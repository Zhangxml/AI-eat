// 全局用户设置接口（可写）；与只读的 /api/config（部署级 env）职责分离：
// - /api/config   = 部署级只读（AI 是否配置、鉴权/删除保护开关）
// - /api/settings = 用户级可写（推荐风格等偏好），存 data/settings.json
// GET   → 200 Settings（合并默认值后的完整设置）
// PATCH → 200 Settings | 400 { error }（未知键/非法值） | 500 { error }（写盘失败）
import { requireAuth } from '@/lib/auth'
import { appendAccessLog, clientIpOf } from '@/lib/access-log'
import { mergeSettings, validateSettingsPatch } from '@/lib/settings'
import { readSettings, writeSettings } from '@/lib/settings-store'
import { checkBodySize, bodyTooLarge, BODY_LIMIT_BYTES } from '@/lib/body-limit'

export async function GET(req: Request): Promise<Response> {
  const denied = requireAuth(req)
  if (denied) return denied
  return Response.json(await readSettings())
}

export async function PATCH(req: Request): Promise<Response> {
  const denied = requireAuth(req)
  if (denied) return denied
  const ip = clientIpOf(req)
  // 设置体积极小，1MB 闸门只是统一口径
  if (!checkBodySize(req, BODY_LIMIT_BYTES)) return bodyTooLarge()

  let body: unknown
  try {
    body = await req.json()
  } catch {
    await appendAccessLog({ ip, method: 'PATCH', path: '/api/settings', status: 400 })
    return Response.json({ error: '请求体不是合法 JSON' }, { status: 400 })
  }
  // strict 校验：未知键/非法值一律 400（防拼写错误被静默忽略）
  const patch = validateSettingsPatch(body)
  if (!patch) {
    await appendAccessLog({ ip, method: 'PATCH', path: '/api/settings', status: 400 })
    return Response.json({ error: '设置项非法：仅支持 style（home|creative）' }, { status: 400 })
  }

  const next = mergeSettings(await readSettings(), patch)
  try {
    await writeSettings(next)
    await appendAccessLog({ ip, method: 'PATCH', path: '/api/settings', status: 200 })
    return Response.json(next)
  } catch {
    await appendAccessLog({ ip, method: 'PATCH', path: '/api/settings', status: 500 })
    return Response.json({ error: '设置保存失败：请检查服务器 data 目录权限' }, { status: 500 })
  }
}
