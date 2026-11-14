// 鉴权守卫。
//
// 两种运行模式（由 env.PASSWORD 决定，见 auth-mode.ts）：
// 1. 免密单用户（PASSWORD 空）：
//    - 首次运行自动创建「管理员」并接管旧数据，之后所有请求都以该管理员身份处理；
//    - 其他账号不可登录，但数据保留（冻结是运行时判定，不改 users.json）；
//    - 表损坏/无管理员 → 503 fail-closed。
// 2. 密码模式（PASSWORD 非空）：
//    - 未初始化 → 401，由登录页引导建号；
//    - 会话有效 → 返回真实用户；无效/禁用/删除/版本不符 → 401。
//
// 设计要点：
// - 路由统一用 requireSession 拿 user，**不再**直接判断「是否登录」
// - LEGACY_OWNER_ID 仅作为历史常量保留（旧数据目录回落用），不再有「未初始化直接放行」的分支
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import {
  countAdmins,
  createUser,
  dataRoot,
  getUser,
  listUsers,
  multiUserInitialized,
  readUsersFile,
  type User,
  type UserRole,
} from './user-store'
import { SESSION_COOKIE, verifySession } from './session'
import { isPasswordlessMode } from './auth-mode'
import { hashPassword } from './password-hash'
import { adoptLegacyData } from './legacy-migration'

// 旧模式（未迁移）下代表「唯一使用者」的合成 id；数据目录回落到 data/recipes。
// 免密模式不再使用它（会建真实的管理员账号），保留给路径解析的兼容分支。
export const LEGACY_OWNER_ID = 'legacy-owner'

/** 免密模式下默认创建的管理员名 */
export const DEFAULT_ADMIN_NAME = '管理员'

// 免密模式下「已确认接管过旧数据」的进程内标记：避免每个请求都去 access 标记文件。
// 不持久化——重启后会重新尝试（正好覆盖「上次迁移失败」的情况）。
const adoptedFor = new Set<string>()

// 接管失败只告警一次（失败时每个请求都会重试，否则会刷满日志）
let adoptWarned = false
function warnAdoptFailed(userId: string, e: unknown): void {
  if (adoptWarned) return
  adoptWarned = true
  console.warn(
    `[auth] 接管旧数据失败（用户 ${userId}），将在后续请求重试：` +
      `${e instanceof Error ? e.message : String(e)}`,
  )
}

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

/**
 * 是否启用访问鉴权——只看 PASSWORD 是否非空，与 /api/config 的 authEnabled 同源。
 * 不再等于「有 users.json」：免密单用户模式下虽然有 users.json，但不需要登录。
 */
export async function authEnabled(): Promise<boolean> {
  return !isPasswordlessMode()
}

/** 最早创建且未禁用的管理员（免密模式的唯一身份） */
export async function firstAdmin(): Promise<User | null> {
  const { state, users } = await readUsersFile()
  if (state !== 'ok') return null
  const admins = users.filter(u => u.role === 'admin' && !u.disabled)
  if (admins.length === 0) return null
  // createdAt 是 ISO 字符串，字典序即时间序
  return admins.sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0]
}

/** users/ 目录是否存在（区分「首次运行」与「表被删但已迁移过」） */
async function usersDirExists(): Promise<boolean> {
  const { promises: fs } = await import('node:fs')
  return fs
    .stat(path.join(dataRoot(), 'users'))
    .then(s => s.isDirectory())
    .catch(() => false)
}

/**
 * 免密模式的首次运行准备（幂等）：
 * - 无 users.json 且无 users/ → 自动创建「管理员」并接管旧数据；
 * - 已初始化 → 确保旧数据被接管过（标记短路，开销是一次 access）。
 * 并发首次访问由 createUser(onlyIfEmpty) 的内部串行队列保证只建一个。
 */
async function ensurePasswordlessAdmin(): Promise<void> {
  const { state } = await readUsersFile()
  if (state === 'missing') {
    // 已迁移但表被删 → 不能当成首次运行（否则会用空表覆盖掉可恢复的状态）
    if (await usersDirExists()) return
    try {
      const created = await createUser({
        name: DEFAULT_ADMIN_NAME,
        // 免密模式不校验密码，但表结构要求非空；用随机值保证「若将来切到密码模式也不会被猜到」
        passwordHash: await hashPassword(randomBytes(32).toString('base64url')),
        onlyIfEmpty: true,
      })
      // 接管失败不能让「已接管」标记落地：否则本进程再也不重试，用户会一直看到空库
      try {
        await adoptLegacyData(created.id)
        adoptedFor.add(created.id)
      } catch (e) {
        warnAdoptFailed(created.id, e)
      }
    } catch (e) {
      // 并发下另一个请求先建好了 → 正常，继续用它的身份
      if ((e as { code?: string }).code !== 'ALREADY_INITIALIZED') throw e
    }
    return
  }
  if (state !== 'ok') return // corrupt：交给调用方返回 503
  const admin = await firstAdmin()
  if (admin && !adoptedFor.has(admin.id)) {
    // 建号时迁移可能失败（权限/磁盘抖动）；这里补一次，成功后记住，失败下次再试
    try {
      await adoptLegacyData(admin.id)
      adoptedFor.add(admin.id)
    } catch (e) {
      warnAdoptFailed(admin.id, e)
    }
  }
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
  // ---- 免密单用户模式：系统只有一个身份（最早的管理员）----
  if (isPasswordlessMode()) {
    // 首次运行会自动建「管理员」并接管旧数据；已初始化则确保接管过（幂等）。
    // 写盘失败（卷只读/磁盘满）必须转成 503 JSON，否则会冒泡成 Next 的 500 HTML，
    // 前端 apiFetch 与审计都无法按契约处理。
    try {
      await ensurePasswordlessAdmin()
    } catch {
      return {
        ok: false,
        reason: 'user-store-broken',
        res: Response.json(
          { error: '数据目录不可写：无法创建或读取管理员账号，请检查 data 目录权限' },
          { status: 503 },
        ),
      }
    }

    const { state, users } = await readUsersFile()
    if (state !== 'ok' || users.length === 0) {
      return {
        ok: false,
        reason: 'user-store-broken',
        res: Response.json(
          { error: '用户表损坏或为空：请从备份恢复 data/users.json 后重试' },
          { status: 503 },
        ),
      }
    }
    const admin = users
      .filter(u => u.role === 'admin' && !u.disabled)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0]
    if (admin === undefined) {
      return {
        ok: false,
        reason: 'user-store-broken',
        res: Response.json(
          { error: '用户表无可用管理员账号：请从备份恢复 data/users.json 后重试' },
          { status: 503 },
        ),
      }
    }
    // 不再看 Cookie：其他账号被冻结，旧 token 也按管理员身份处理（严格单用户）
    return { ok: true, legacy: false, user: toSessionUser(admin) }
  }

  // ---- 密码模式 ----
  // 未初始化 → 401，由登录页引导建号（不再有「未初始化直接放行」的旧模式）
  if (!(await multiUserInitialized())) {
    return { ok: false, reason: 'unauthenticated', res: UNAUTHORIZED() }
  }

  // 已初始化：用户表必须可读且非空，否则 fail-closed。
  // 为什么不能当空表放行：表截断/误删会退化成「无鉴权 + 任何人可抢建 admin」。
  const { state, users } = await readUsersFile()
  if (state !== 'ok' || users.length === 0) {
    return {
      ok: false,
      reason: 'user-store-broken',
      res: Response.json(
        { error: '用户表损坏或为空：请从备份恢复 data/users.json 后重试' },
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

/** 仅管理员可访问（访问记录、用户管理）。 */
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
