// 鉴权守卫（多用户改造后）。
// 三种运行模式：
// 1. 未启用多用户（data/users.json 不存在）→ 视为「旧模式」：放行，返回一个合成的 LEGACY_OWNER
//    （数据仍在 data/recipes，与第一版完全一致，保证未迁移前功能不变）
// 2. 已启用 + 会话有效 → 返回真实用户
// 3. 已启用 + 会话无效/用户被禁用/被删除/sessionVersion 不符 → 401
//
// 设计要点：
// - 路由统一用 requireSession 拿 user，**不再**直接判断「是否登录」——否则又会退化成拿不到身份
// - LEGACY_OWNER_ID 与真实用户 id 不冲突（真实 id 形如 u-<8hex>）
// - requireAdmin 在旧模式下也放行：迁移前管理员才存在，不该把用户锁在门外
import {
  countAdmins,
  getUser,
  listUsers,
  multiUserInitialized,
  readUsersFile,
  type User,
  type UserRole,
} from './user-store'
import { SESSION_COOKIE, verifySession } from './session'

// 旧模式（未迁移）下代表「唯一使用者」的合成 id；数据目录回落到 data/recipes
export const LEGACY_OWNER_ID = 'legacy-owner'

export interface SessionUser {
  id: string
  name: string
  role: UserRole
}

// 失败原因显式化：调用方（尤其 middleware）不应靠 status code 猜语义。
// - unauthenticated：未登录 / 已禁用 / 已删除 / sessionVersion 不符 → 页面层可安全跳登录
// - user-store-broken：用户表损坏或为空（503）→ 页面层应放行，让页面把错误显示出来
// - forbidden：已登录但角色不足（403）
export type SessionFailureReason = 'unauthenticated' | 'user-store-broken' | 'forbidden'

export type SessionResult =
  | { ok: true; user: SessionUser; legacy: boolean }
  | { ok: false; res: Response; reason: SessionFailureReason }

/** 是否已进入多用户模式（有合法用户） */
export async function multiUserMode(): Promise<boolean> {
  return (await listUsers()).length > 0
}

/** 是否需要初始化首个管理员：仅当「从未初始化过」（无 users.json 且无 users/ 目录） */
export async function bootstrapRequired(): Promise<boolean> {
  return !(await multiUserInitialized())
}

/** 是否启用了访问鉴权（已初始化即启用）——与 /api/config 的 authEnabled 同源 */
export async function authEnabled(): Promise<boolean> {
  return multiUserInitialized()
}

function cookieValue(header: string, name: string): string | null {
  for (const part of header.split(';')) {
    const item = part.trim()
    const eq = item.indexOf('=')
    if (eq === -1) continue
    if (item.slice(0, eq) === name) return item.slice(eq + 1)
  }
  return null
}

function toSessionUser(u: User): SessionUser {
  return { id: u.id, name: u.name, role: u.role }
}

const UNAUTHORIZED = () => Response.json({ error: '请先登录' }, { status: 401 })
const FORBIDDEN = () => Response.json({ error: '需要管理员权限' }, { status: 403 })

/**
 * 受保护路由的统一守卫。
 * 用法（各 handler 首行）：
 *   const auth = await requireSession(req)
 *   if (!auth.ok) return auth.res
 *   const user = auth.user
 */
export async function requireSession(
  req: Request,
  now: number = Date.now(),
): Promise<SessionResult> {
  // 未初始化（从未迁移过）→ 旧模式放行
  if (!(await multiUserInitialized())) {
    return {
      ok: true,
      legacy: true,
      user: { id: LEGACY_OWNER_ID, name: '本机用户', role: 'admin' },
    }
  }

  // 已初始化：用户表必须可读且非空，否则 fail-closed。
  // 为什么不能当空表放行：表截断/误删会退化成「无鉴权 + 任何人可抢建 admin」。
  const { state, users } = await readUsersFile()
  if (state !== 'ok' || users.length === 0) {
    return {
      ok: false,
      reason: 'user-store-broken',
      res: Response.json(
        { error: '用户表损坏或为空：请从备份恢复 data/users.json 后重启' },
        { status: 503 },
      ),
    }
  }

  const header = req.headers.get('cookie')
  const token = header === null ? null : cookieValue(header, SESSION_COOKIE)
  if (token === null) return { ok: false, reason: 'unauthenticated', res: UNAUTHORIZED() }

  const claims = await verifySession(token, now)
  if (claims === null) return { ok: false, reason: 'unauthenticated', res: UNAUTHORIZED() }

  const user = await getUser(claims.uid)
  if (user === null || user.disabled) return { ok: false, reason: 'unauthenticated', res: UNAUTHORIZED() }
  // 改密/管理员强制下线：版本不匹配即视为失效
  if (user.sessionVersion !== claims.ver) return { ok: false, reason: 'unauthenticated', res: UNAUTHORIZED() }

  return { ok: true, legacy: false, user: toSessionUser(user) }
}

/** 仅管理员可访问（访问记录、用户管理）。旧模式放行。 */
export async function requireAdmin(
  req: Request,
  now: number = Date.now(),
): Promise<SessionResult> {
  const result = await requireSession(req, now)
  if (!result.ok) return result
  if (result.user.role !== 'admin') return { ok: false, reason: 'forbidden', res: FORBIDDEN() }
  return result
}

/** 是否还有其它管理员（防止把最后一个管理员删掉/降级后无人可管理） */
export async function hasOtherAdmin(excludeId: string): Promise<boolean> {
  const users = await listUsers()
  return users.some(u => u.id !== excludeId && u.role === 'admin' && !u.disabled)
}

export { countAdmins }
export type { User, UserRole }
