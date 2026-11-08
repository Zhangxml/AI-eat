// AI 客户端（OpenAI 兼容端点，DeepSeek/GLM 均兼容）
// 职责：读环境变量 → 组装请求 → fetch 上游 /chat/completions
// - aiComplete：非流式，返回 choices[0].message.content
// - aiChatStream：stream:true，返回原始上游 Response（OpenAI SSE 格式由调用方解析）
// - fetch 带 AbortSignal.timeout(120s)：上游 120 秒无响应即中止，错误消息含「AI 上游超时」
// - 可选 options.temperature：温度分层（见 ai-temperatures.ts），clamp [0,1] 后随请求发送
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

// 单次调用可选项（当前只有温度；后续如需 top_p/max_tokens 在此扩展）
export interface AiCallOptions {
  temperature?: number
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

// AI 上游单次请求超时：120 秒无响应即中止（避免上游挂起导致前端无限等待、连接悬挂）
const AI_TIMEOUT_MS = 120_000

// 两个 AI 接口共用的请求组装 + 上游状态校验
async function chatRequest(
  cfg: AiConfig,
  messages: ChatMessage[],
  stream: boolean,
  opts?: AiCallOptions,
): Promise<Response> {
  // 温度：仅当调用方提供有限数时发送（clamp 到 [0,1]）；未提供则交由供应商默认
  const temperature =
    opts?.temperature !== undefined && Number.isFinite(opts.temperature)
      ? Math.min(1, Math.max(0, opts.temperature))
      : undefined
  const body: Record<string, unknown> = { model: cfg.model, messages, stream }
  if (temperature !== undefined) body.temperature = temperature
  let res: Response
  try {
    res = await fetch(chatEndpoint(cfg.baseUrl), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      // 120 秒硬超时：到时 fetch 以 TimeoutError（DOMException）reject，走下方超时翻译
      signal: AbortSignal.timeout(AI_TIMEOUT_MS),
    })
  } catch (e) {
    // 网络层异常（含超时）在拿到状态码前统一翻译：超时给明确文案，其余按连接失败透出
    if (e instanceof DOMException && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
      throw new Error(`AI 上游超时（120 秒无响应）`)
    }
    throw new Error(`AI 上游连接失败：${e instanceof Error ? e.message : String(e)}`)
  }
  if (!res.ok) {
    // 非 200 抛错带状态码，便于上层（T10）映射 502/503
    throw new Error(`AI 上游请求失败：HTTP ${res.status}`)
  }
  return res
}

export async function aiComplete(
  cfg: AiConfig,
  messages: ChatMessage[],
  opts?: AiCallOptions,
): Promise<string> {
  const res = await chatRequest(cfg, messages, false, opts)
  const data = await res.json()
  // OpenAI 兼容响应：choices[0].message.content
  const content = data.choices?.[0]?.message?.content
  if (typeof content !== 'string') {
    throw new Error('AI 上游响应格式异常：choices[0].message.content 缺失')
  }
  return content
}

export async function aiChatStream(
  cfg: AiConfig,
  messages: ChatMessage[],
  opts?: AiCallOptions,
): Promise<Response> {
  return chatRequest(cfg, messages, true, opts)
}
