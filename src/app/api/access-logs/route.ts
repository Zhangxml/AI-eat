// 访问日志接口（受 PASSWORD 守卫保护，与设置页状态接口同权限级别）
// GET /api/access-logs → 200 { logs: AccessLogEntry[] }（全局审计，最新在前）
// 权限：仅管理员（member → 403）；未登录 → 401
// 说明：日志读取接口本身不写日志（读操作不在方案 A 记录范围）
import { readAccessLogs } from '@/lib/access-log'
import { requireAdmin } from '@/lib/auth'

export async function GET(req: Request): Promise<Response> {
  // 访问记录是全局审计，仅管理员可读（member 403）
  const auth = await requireAdmin(req)
  if (!auth.ok) return auth.res
  const logs = await readAccessLogs()
  return Response.json({ logs })
}
