// 配置状态接口（Task 15，Task 16 接守卫）：设置页只读展示 AI 配置与鉴权状态的唯一数据源
// GET 契约（上游裁定 3）：200 { aiConfigured: boolean; baseUrl: string | null; model: string | null; authEnabled: boolean }
// 安全红线：绝不含 apiKey（key 只留在服务端 env，本接口只回显非敏感的 baseUrl/model）
// 语义：aiConfigured = AI_BASE_URL / AI_API_KEY / AI_MODEL 三变量全非空（loadAiConfig 同款合取判断）；
//       authEnabled = PASSWORD 非空（Task 16 起走 auth 模块的 authEnabled()，单一事实来源，避免语义分叉）
// 守卫：受保护路由（登录状态查询除外）；未启用 PASSWORD 时守卫放行，行为与 Task 15 完全一致
import { authEnabled, requireAuth } from '@/lib/auth'

// handler 不读请求体；req 供守卫取 Cookie
export async function GET(req: Request): Promise<Response> {
  const denied = requireAuth(req)
  if (denied) return denied
  const { AI_BASE_URL, AI_API_KEY, AI_MODEL } = process.env
  const aiConfigured = Boolean(AI_BASE_URL) && Boolean(AI_API_KEY) && Boolean(AI_MODEL)
  return Response.json({
    aiConfigured,
    // baseUrl/model 非敏感，回显供设置页展示；未配置时为 null
    baseUrl: aiConfigured ? (AI_BASE_URL as string) : null,
    model: aiConfigured ? (AI_MODEL as string) : null,
    // 鉴权开关与守卫共用同一函数，语义永不分叉
    authEnabled: authEnabled(),
  })
}
