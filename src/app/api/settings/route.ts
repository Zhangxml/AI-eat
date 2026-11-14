// 用户设置接口（可写，按用户隔离：data/users/<uid>/settings.json）；与只读的 /api/config（部署级 env）职责分离：
// - /api/config   = 部署级只读（AI 是否配置、鉴权/删除保护开关）
// - /api/settings = 用户级可写（推荐风格等偏好），存 data/users/<uid>/settings.json
// GET   → 200 Settings（合并默认值后的完整设置）
// PATCH → 200 Settings | 400 { error }（未知键/非法值） | 500 { error }（写盘失败）
import { requireSession } from '@/lib/auth'
import { appendAccessLog, clientIpOf } from '@/lib/access-log'
import { mergeSettings, validateSettingsPatch } from '@/lib/settings'
import { readSettings, writeSettings } from '@/lib/settings-store'
import { readJsonBody, BODY_LIMIT_BYTES } from '@/lib/body-limit'

export async function GET(req: Request): Promise<Response> {
  const auth = await requireSession(req)
  if (!auth.ok) return auth.res
  // 用户偏好可随时在设置页修改：显式禁止缓存，避免改完读到旧值
  return Response.json(await readSettings(auth.user.id), { headers: { 'Cache-Control': 'no-store' } })
}

export async function PATCH(req: Request): Promise<Response> {
  const auth = await requireSession(req)
  if (!auth.ok) return auth.res
  const ip = clientIpOf(req)
  // 设置体积极小，1MB 闸门只是统一口径（流式累计，chunked 也绕不过）
  const parsed = await readJsonBody(req, BODY_LIMIT_BYTES)
  if (!parsed.ok) {
    await appendAccessLog({ ip, user: auth.user.name, method: 'PATCH', path: '/api/settings', status: parsed.response.status })
    return parsed.response
  }
  const body = parsed.value
  // strict 校验：未知键/非法值一律 400（防拼写错误被静默忽略）
  const patch = validateSettingsPatch(body)
  if (!patch) {
    await appendAccessLog({ ip, user: auth.user.name, method: 'PATCH', path: '/api/settings', status: 400 })
    return Response.json({ error: '设置项非法：仅支持 style（home|creative）' }, { status: 400 })
  }

  const next = mergeSettings(await readSettings(auth.user.id), patch)
  try {
    await writeSettings(next, auth.user.id)
    await appendAccessLog({ ip, user: auth.user.name, method: 'PATCH', path: '/api/settings', status: 200 })
    return Response.json(next)
  } catch {
    await appendAccessLog({ ip, user: auth.user.name, method: 'PATCH', path: '/api/settings', status: 500 })
    return Response.json({ error: '设置保存失败：请检查服务器 data 目录权限' }, { status: 500 })
  }
}
