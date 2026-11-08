// 访问日志接口（受 PASSWORD 守卫保护，与设置页状态接口同权限级别）
// GET /api/access-logs → 200 { logs: AccessLogEntry[] }（最新在前）| 401 { error }（启用鉴权且未登录）
// 说明：日志读取接口本身不写日志（读操作不在方案 A 记录范围）
import { readAccessLogs } from '@/lib/access-log'
import { requireAuth } from '@/lib/auth'

export async function GET(req: Request): Promise<Response> {
  const denied = requireAuth(req)
  if (denied) return denied
  const logs = await readAccessLogs()
  return Response.json({ logs })
}
