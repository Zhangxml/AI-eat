// 用户管理（仅管理员）。
// GET  /api/users            → 200 { users: [{ id, name, role, disabled, createdAt }] }（绝不含 passwordHash）
// POST /api/users            → 201 { user } | 400（重名/密码过短/格式非法）
// 安全：本路由首行 requireAdmin；响应体永不包含 passwordHash 或任何凭据
import { requireAdmin } from '@/lib/auth'
import { isPasswordlessMode } from '@/lib/auth-mode'
import { appendAccessLog, clientIpOf } from '@/lib/access-log'
import { checkBodySize, bodyTooLarge, BODY_LIMIT_BYTES } from '@/lib/body-limit'
import { hashPassword } from '@/lib/password-hash'
import { createUser, listUsers, multiUserInitialized, type User } from '@/lib/user-store'

const MIN_PASSWORD_LEN = 4

/** 对外暴露的用户视图：剔除 passwordHash（红线） */
function publicUser(u: User) {
  return {
    id: u.id,
    name: u.name,
    role: u.role,
    disabled: u.disabled,
    createdAt: u.createdAt,
  }
}

export async function GET(req: Request): Promise<Response> {
  const auth = await requireAdmin(req)
  if (!auth.ok) return auth.res
  // 免密单用户模式：系统只有一个身份，不提供用户管理（与界面隐藏保持一致，不留 API 口子）
  if (isPasswordlessMode()) {
    return Response.json(
      { error: '当前为免密单用户模式，不支持用户管理' },
      { status: 409 },
    )
  }
  // 必须已进入多用户模式：旧模式（从未初始化）下不允许建号/改号，
  // 否则可绕过 /api/auth 的引导口令抢先建 admin，并让迁移脚本因幂等而永久跳过
  if (!(await multiUserInitialized())) {
    return Response.json(
      { error: '尚未初始化：请先在登录页创建管理员' },
      { status: 409 },
    )
  }
  const users = await listUsers()
  return Response.json({ users: users.map(publicUser) })
}

export async function POST(req: Request): Promise<Response> {
  const auth = await requireAdmin(req)
  if (!auth.ok) return auth.res
  const ip = clientIpOf(req)
  if (!checkBodySize(req, BODY_LIMIT_BYTES)) return bodyTooLarge()
  // 免密单用户模式：不支持创建用户（创建后也无法登录，避免用户困惑）
  if (isPasswordlessMode()) {
    await appendAccessLog({ ip, user: auth.user.name, method: 'POST', path: '/api/users', status: 409 })
    return Response.json(
      { error: '当前为免密单用户模式，不支持创建用户；设置 PASSWORD 并重启后可启用多用户' },
      { status: 409 },
    )
  }
  // 必须已进入多用户模式：旧模式（从未初始化）下不允许建号/改号，
  // 否则可绕过 /api/auth 的引导口令抢先建 admin，并让迁移脚本因幂等而永久跳过
  if (!(await multiUserInitialized())) {
    return Response.json(
      { error: '尚未初始化：请先在登录页创建管理员' },
      { status: 409 },
    )
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    await appendAccessLog({ ip, user: auth.user.name, method: 'POST', path: '/api/users', status: 400 })
    return Response.json({ error: '请求体不是合法 JSON' }, { status: 400 })
  }
  if (typeof body !== 'object' || body === null) {
    return Response.json({ error: '请求体格式非法' }, { status: 400 })
  }
  const b = body as Record<string, unknown>
  const name = typeof b.name === 'string' ? b.name.trim() : ''
  const password = typeof b.password === 'string' ? b.password : ''
  // 管理员只能有一个（密码由 env.PASSWORD 控制，所有 admin 共用同一口令）。
  // 允许通过接口建 admin 会让「填写的初始密码」静默失效，也让审计里的 user 名不可信。
  if (b.role === 'admin') {
    return Response.json(
      { error: '不支持通过接口创建管理员：管理员密码由环境变量 PASSWORD 控制' },
      { status: 400 },
    )
  }
  const role = 'member'
  if (name === '' || password === '') {
    return Response.json({ error: '需要 name 与 password' }, { status: 400 })
  }
  if (password.length < MIN_PASSWORD_LEN) {
    return Response.json({ error: `密码至少 ${MIN_PASSWORD_LEN} 位` }, { status: 400 })
  }

  try {
    const user = await createUser({ name, passwordHash: await hashPassword(password), role })
    await appendAccessLog({ ip, user: auth.user.name, method: 'POST', path: '/api/users', status: 201 })
    return Response.json({ user: publicUser(user) }, { status: 201 })
  } catch (e) {
    const msg = e instanceof Error ? e.message : '创建失败'
    await appendAccessLog({ ip, user: auth.user.name, method: 'POST', path: '/api/users', status: 400 })
    return Response.json({ error: msg }, { status: 400 })
  }
}
