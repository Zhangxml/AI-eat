// AI 客户端（OpenAI 兼容端点，DeepSeek/GLM 均兼容）
// 职责：读环境变量 → 组装请求 → fetch 上游 /chat/completions
// - aiComplete：非流式，返回 choices[0].message.content
// - aiChatStream：stream:true，返回原始上游 Response（OpenAI SSE 格式由调用方解析）
// 不引 SDK，直接 fetch；不透传除 Authorization/Content-Type 外的其他敏感头

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface AiConfig {
  baseUrl: string
  apiKey: string
  model: string
}

// 配置缺失的统一中文错误（T10/T11/T13 依赖此文案）
const MISSING_MSG = 'AI 配置缺失：请设置 AI_BASE_URL / AI_API_KEY / AI_MODEL'

export function loadAiConfig(env: NodeJS.ProcessEnv = process.env): AiConfig {
  const { AI_BASE_URL, AI_API_KEY, AI_MODEL } = env
  if (!AI_BASE_URL || !AI_API_KEY || !AI_MODEL) {
    throw new Error(MISSING_MSG)
  }
  return { baseUrl: AI_BASE_URL, apiKey: AI_API_KEY, model: AI_MODEL }
}

// 拼 chat/completions 端点：baseUrl 末尾斜杠归一化（带不带斜杠都正确）
function chatEndpoint(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/chat/completions`
}

// 两个 AI 接口共用的请求组装 + 上游状态校验
async function chatRequest(
  cfg: AiConfig,
  messages: ChatMessage[],
  stream: boolean,
): Promise<Response> {
  const res = await fetch(chatEndpoint(cfg.baseUrl), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: cfg.model, messages, stream }),
  })
  if (!res.ok) {
    // 非 200 抛错带状态码，便于上层（T10）映射 502/503
    throw new Error(`AI 上游请求失败：HTTP ${res.status}`)
  }
  return res
}

export async function aiComplete(cfg: AiConfig, messages: ChatMessage[]): Promise<string> {
  const res = await chatRequest(cfg, messages, false)
  const data = await res.json()
  // OpenAI 兼容响应：choices[0].message.content
  const content = data.choices?.[0]?.message?.content
  if (typeof content !== 'string') {
    throw new Error('AI 上游响应格式异常：choices[0].message.content 缺失')
  }
  return content
}

export async function aiChatStream(cfg: AiConfig, messages: ChatMessage[]): Promise<Response> {
  return chatRequest(cfg, messages, true)
}
