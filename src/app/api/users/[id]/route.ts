// 单个用户管理（仅管理员）：改密 / 改名 / 禁用 / 删除。
// PATCH /api/users/:id  body { name?, password?, disabled?, role? } → 200 { user }
// DELETE /api/users/:id → 204（连带删除该用户的数据目录）
// 安全约束：
// - 改密/禁用会 +1 sessionVersion → 该用户所有旧会话立即失效
// - 不能把最后一个管理员降级/禁用/删除（否则无人可管理）
// - 不能删除自己（避免误操作把自己锁在外面；请先用另一管理员操作）
// - 删除会递归删 data/users/<uid>/，需 body { confirm: '<用户名>' } 二次确认
import { promises as fs } from 'node:fs'
import { requireAdmin } from '@/lib/auth'
import { appendAccessLog, clientIpOf } from '@/lib/access-log'
import { checkBodySize, bodyTooLarge, BODY_LIMIT_BYTES } from '@/lib/body-limit'
import { hashPassword } from '@/lib/password-hash'
import {
  deleteUser,
  getUser,
  listUsers,
  multiUserInitialized,
  updateUser,
  userDir,
  type User,
} from '@/lib/user-store'

const MIN_PASSWORD_LEN = 4

function publicUser(u: User) {
  return { id: u.id, name: u.name, role: u.role, disabled: u.disabled, createdAt: u.createdAt }
}

async function otherActiveAdminExists(excludeId: string): Promise<boolean> {
  const users = await listUsers()
  return users.some(u => u.id !== excludeId && u.role === 'admin' && !u.disabled)
}

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
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

  const { id } = await ctx.params
  const target = await getUser(id)
  if (target === null) {
    return Response.json({ error: '用户不存在' }, { status: 404 })
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: '请求体不是合法 JSON' }, { status: 400 })
  }
  if (typeof body !== 'object' || body === null) {
    return Response.json({ error: '请求体格式非法' }, { status: 400 })
  }
  const b = body as Record<string, unknown>

  const patch: Parameters<typeof updateUser>[1] = {}

  if (b.name !== undefined) {
    if (typeof b.name !== 'string' || b.name.trim() === '') {
      return Response.json({ error: 'name 须为非空字符串' }, { status: 400 })
    }
    patch.name = b.name.trim()
  }
  if (b.password !== undefined) {
    if (typeof b.password !== 'string' || b.password.length < MIN_PASSWORD_LEN) {
      return Response.json({ error: `密码至少 ${MIN_PASSWORD_LEN} 位` }, { status: 400 })
    }
    patch.passwordHash = await hashPassword(b.password)
    // 改密 → 作废旧会话
    patch.sessionVersion = target.sessionVersion + 1
  }
  if (b.disabled !== undefined) {
    if (typeof b.disabled !== 'boolean') {
      return Response.json({ error: 'disabled 须为布尔值' }, { status: 400 })
    }
    // 管理员账号一律不可禁用（不是只看「是否最后一个」）：
    // 管理员掌握账号与审计权限，禁用后若不慎无人可恢复，等于自锁；且与前端「按钮禁用」口径一致
    if (b.disabled && target.role === 'admin') {
      return Response.json({ error: '管理员账号不能禁用' }, { status: 400 })
    }
    patch.disabled = b.disabled
    if (b.disabled) patch.sessionVersion = (patch.sessionVersion ?? target.sessionVersion) + 1
  }
  if (b.role !== undefined) {
    if (b.role !== 'admin' && b.role !== 'member') {
      return Response.json({ error: 'role 须为 admin 或 member' }, { status: 400 })
    }
    if (b.role === 'member' && target.role === 'admin' && !(await otherActiveAdminExists(target.id))) {
      return Response.json({ error: '不能降级最后一个管理员' }, { status: 400 })
    }
    patch.role = b.role
  }

  try {
    const updated = await updateUser(id, patch)
    await appendAccessLog({ ip, user: auth.user.name, method: 'PATCH', path: `/api/users/${id}`, status: 200 })
    return Response.json({ user: publicUser(updated) })
  } catch (e) {
    const msg = e instanceof Error ? e.message : '更新失败'
    return Response.json({ error: msg }, { status: 400 })
  }
}

export async function DELETE(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
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

  const { id } = await ctx.params
  const target = await getUser(id)
  if (target === null) return Response.json({ error: '用户不存在' }, { status: 404 })

  // 不能删自己：避免误操作把自己锁在外面
  if (target.id === auth.user.id) {
    return Response.json({ error: '不能删除当前登录的账号' }, { status: 400 })
  }
  // 管理员账号一律不可删除（避免把管理能力删没；确需移除请先将另一个账号提为管理员并改其角色）
  if (target.role === 'admin') {
    return Response.json({ error: '管理员账号不能删除' }, { status: 400 })
  }

  // 二次确认：body { confirm: '<用户名>' }
  let body: unknown = null
  try {
    body = await req.json()
  } catch {
    // 无 body 视为未确认
  }
  const confirm = (body as { confirm?: unknown } | null)?.confirm
  if (typeof confirm !== 'string' || confirm.trim() !== target.name) {
    return Response.json(
      { error: `删除需二次确认：请提交 { "confirm": "${target.name}" }` },
      { status: 400 },
    )
  }

  try {
    await deleteUser(id)
  } catch (e) {
    const msg = e instanceof Error ? e.message : '删除失败'
    return Response.json({ error: msg }, { status: 400 })
  }
  // 连带删除数据目录（失败不回滚账号删除——账号已不可登录，残留目录无害）
  await fs.rm(userDir(id), { recursive: true, force: true }).catch(() => {})

  await appendAccessLog({ ip, user: auth.user.name, method: 'DELETE', path: `/api/users/${id}`, status: 204 })
  return new Response(null, { status: 204 })
}
