// 配置状态接口（Task 15）：设置页只读展示 AI 配置与鉴权状态的唯一数据源
// GET 契约（上游裁定 3）：200 { aiConfigured: boolean; baseUrl: string | null; model: string | null; authEnabled: boolean }
// 安全红线：绝不含 apiKey（key 只留在服务端 env，本接口只回显非敏感的 baseUrl/model）
// 语义：aiConfigured = AI_BASE_URL / AI_API_KEY / AI_MODEL 三变量全非空（loadAiConfig 同款合取判断）；
//       authEnabled = PASSWORD 非空（Task 16 鉴权上线后复用同一语义做守卫）
// 本任务直接读 process.env 实现，不抽 lib（单一消费者，与 menu route 同款原则）
// handler 不读请求体；参数名省略以符合 next/typescript 的 no-unused-vars
export async function GET(): Promise<Response> {
  const { AI_BASE_URL, AI_API_KEY, AI_MODEL, PASSWORD } = process.env
  const aiConfigured = Boolean(AI_BASE_URL) && Boolean(AI_API_KEY) && Boolean(AI_MODEL)
  return Response.json({
    aiConfigured,
    // baseUrl/model 非敏感，回显供设置页展示；未配置时为 null
    baseUrl: aiConfigured ? (AI_BASE_URL as string) : null,
    model: aiConfigured ? (AI_MODEL as string) : null,
    authEnabled: Boolean(PASSWORD),
  })
}
