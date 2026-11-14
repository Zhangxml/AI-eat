// 用户管理（仅管理员）。
// GET  /api/users            → 200 { users: [{ id, name, role, disabled, createdAt }] }（绝不含 passwordHash）
// POST /api/users            → 201 { user } | 400（重名/密码过短/格式非法）
// 安全：本路由首行 requireAdmin；响应体永不包含 passwordHash 或任何凭据
import { requireAdmin } from '@/lib/auth'
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
  const role = b.role === 'admin' ? 'admin' : 'member'
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
