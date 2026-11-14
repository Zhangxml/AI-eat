// 登录 / 初始化 / 登出（多用户）。
// POST /api/auth   body { username, password }            → 200 { ok, user } + Set-Cookie
//                  未有任何用户时 body { username, password } 也用于「初始化首个管理员」
// GET  /api/auth                                           → { needsSetup, enabled, currentUser? }
// POST /api/auth/logout                                    → 204（清 Cookie）
//
// 安全要点：
// - 登录失败统一 401「用户名或口令错误」，不区分是哪一个错（防用户名枚举）
// - 恒时比较由 scrypt 校验内部完成；用户不存在时也跑一次假校验，避免用响应时间探测用户名
// - 登录失败限流：同 IP + 同名 5 次失败后指数退避（本次纳入）
import { appendAccessLog, clientIpOf } from '@/lib/access-log'
import { bootstrapRequired, requireSession } from '@/lib/auth'
import { checkBodySize, bodyTooLarge, BODY_LIMIT_BYTES } from '@/lib/body-limit'
import { hashPassword, verifyPassword } from '@/lib/password-hash'
import { issueSession, sessionCookie } from '@/lib/session'
import {
  attemptKey,
  backoffRemaining,
  clearFailures,
  recordFailure,
} from '@/lib/login-throttle'
import { createUser, findUserByName, readUsersFile } from '@/lib/user-store'
import { adoptLegacyData } from '@/lib/legacy-migration'

// 登录失败日志节流：同 IP 60 秒内只写首条 401（防刷满审计窗口）
const LOG_THROTTLE_MS = 60_000
const lastLoggedAt = new Map<string, number>()

function shouldLog(ip: string, now: number): boolean {
  const last = lastLoggedAt.get(ip) ?? 0
  if (now - last < LOG_THROTTLE_MS) return false
  lastLoggedAt.set(ip, now)
  if (lastLoggedAt.size > 500) lastLoggedAt.clear()
  return true
}

// 假的 scrypt 校验目标：用户不存在时也执行一次等价开销的校验，避免时间侧信道枚举用户名
let dummyHashPromise: Promise<string> | null = null
function dummyHash(): Promise<string> {
  dummyHashPromise ??= hashPassword('dummy-password-for-timing')
  return dummyHashPromise
}

interface AuthBody {
  username?: unknown
  password?: unknown
}

async function parseBody(req: Request): Promise<AuthBody | null> {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return null
  }
  if (typeof body !== 'object' || body === null) return null
  return body as AuthBody
}

export async function POST(req: Request): Promise<Response> {
  const ip = clientIpOf(req)
  if (!checkBodySize(req, BODY_LIMIT_BYTES)) return bodyTooLarge()

  const body = await parseBody(req)
  const username = typeof body?.username === 'string' ? body.username.trim() : ''
  const password = typeof body?.password === 'string' ? body.password : ''
  if (body === null || username === '' || password === '') {
    await appendAccessLog({ ip, method: 'POST', path: '/api/auth', status: 400 })
    return Response.json({ error: '请求体格式非法：需要 username 与 password' }, { status: 400 })
  }

  const now = Date.now()

  // ---- 首次初始化：还没有任何用户 ----
  if (await bootstrapRequired()) {
    const key = attemptKey(ip, username)
    const wait = backoffRemaining(key, now)
    if (wait > 0) {
      return Response.json({ error: `尝试过于频繁，请 ${Math.ceil(wait / 1000)} 秒后再试` }, { status: 429 })
    }
    // 引导口令：若设置了 env.PASSWORD，则必须先输对（防止空库时被陌生人抢先建号）
    const bootstrapPassword = process.env.PASSWORD ?? ''
    if (bootstrapPassword !== '' && password !== bootstrapPassword) {
      recordFailure(key, now)
      if (shouldLog(ip, now)) {
        await appendAccessLog({ ip, method: 'POST', path: '/api/auth', status: 401 })
      }
      return Response.json({ error: '用户名或口令错误' }, { status: 401 })
    }
    if (password.length < 4) {
      return Response.json({ error: '密码至少 4 位' }, { status: 400 })
    }
    let created
    try {
      // onlyIfEmpty：并发初始化时只有一个能建号，另一个得到「已初始化」而不是多建一个成员账号
      created = await createUser({
        name: username,
        passwordHash: await hashPassword(password),
        onlyIfEmpty: true,
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : '创建失败'
      // 「已初始化」是并发/重复提交的正常结果，按 409 返回，前端可直接提示去登录
      const code = (e as { code?: string }).code
      return Response.json({ error: msg }, { status: code === 'ALREADY_INITIALIZED' ? 409 : 400 })
    }
    // 接管单用户时代的旧数据（data/recipes + data/settings.json）。
    // 必须在建号后立刻做：登录页文案承诺「将接收现有菜谱库」，且一旦 users.json 存在，
    // 迁移脚本会幂等跳过——不在这里搬，旧数据就再也进不来。
    try {
      await adoptLegacyData(created.id)
    } catch (e) {
      // 接管失败不回滚账号（账号已可用），但要让调用方知道数据可能未迁移
      await appendAccessLog({ ip, method: 'POST', path: '/api/auth', status: 500, user: created.name })
      return Response.json(
        {
          error: `账号已创建，但接管旧菜谱失败：${
            e instanceof Error ? e.message : String(e)
          }。请检查 AI_EAT_DATA_DIR 配置与 data 目录权限；修复后重新登录会自动重试`,
        },
        { status: 500 },
      )
    }
    clearFailures(key)
    await appendAccessLog({ ip, method: 'POST', path: '/api/auth', status: 200, user: created.name })
    const token = await issueSession({ uid: created.id, ver: created.sessionVersion }, now)
    return Response.json(
      { ok: true, user: { name: created.name, role: created.role } },
      { headers: { 'Set-Cookie': sessionCookie(token, req.headers.get('x-forwarded-proto')) } },
    )
  }

  // ---- 常规登录 ----
  const key = attemptKey(ip, username)
  const wait = backoffRemaining(key, now)
  if (wait > 0) {
    return Response.json({ error: `尝试过于频繁，请 ${Math.ceil(wait / 1000)} 秒后再试` }, { status: 429 })
  }

  // 已初始化（bootstrapRequired 为 false）时用户表必须可读且非空。
  // 损坏/为空若按「用户名或口令错误」返回，管理员会一直以为是密码错了，
  // 与 requireSession 的 503 fail-closed 口径保持一致。
  const { state: usersState, users: allUsers } = await readUsersFile()
  if (usersState !== 'ok' || allUsers.length === 0) {
    return Response.json(
      { error: '用户表损坏或为空：请从备份恢复 data/users.json 后重试' },
      { status: 503 },
    )
  }

  const user = await findUserByName(username)
  // 用户不存在时也跑一次等价校验（防时间侧信道枚举用户名）
  let ok = false
  if (user === null) {
    await verifyPassword(password, await dummyHash())
  } else {
    ok = await verifyPassword(password, user.passwordHash)
  }

  if (!ok || user === null || user.disabled) {
    recordFailure(key, now)
    if (shouldLog(ip, now)) {
      await appendAccessLog({ ip, method: 'POST', path: '/api/auth', status: 401 })
    }
    return Response.json({ error: '用户名或口令错误' }, { status: 401 })
  }

  clearFailures(key)

  // 建号时接管旧数据可能因权限/磁盘抖动失败，而那时账号已经建好、`bootstrapRequired()` 也变 false，
  // 网页不再有「初始化」入口 → 旧数据留在 data/recipes 里却永远进不来。
  // 这里让「最早创建的账号（旧数据的所有者）」在每次登录时补一次：有完成标记会立即短路，
  // 失败也不影响登录（下次登录再试）。
  if (user.role === 'admin') {
    const oldest = [...allUsers].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0]
    if (oldest?.id === user.id) {
      await adoptLegacyData(user.id).catch(() => {})
    }
  }

  await appendAccessLog({ ip, method: 'POST', path: '/api/auth', status: 200, user: user.name })
  const token = await issueSession({ uid: user.id, ver: user.sessionVersion }, now)
  return Response.json(
    { ok: true, user: { name: user.name, role: user.role } },
    { headers: { 'Set-Cookie': sessionCookie(token, req.headers.get('x-forwarded-proto')) } },
  )
}

// GET /api/auth：登录页据此决定显示「初始化」还是「登录」，以及是否已登录
export async function GET(req: Request): Promise<Response> {
  const needsSetup = await bootstrapRequired()
  if (needsSetup) {
    return Response.json({ needsSetup: true, enabled: false })
  }
  const auth = await requireSession(req)
  if (!auth.ok) return Response.json({ needsSetup: false, enabled: true })
  return Response.json({
    needsSetup: false,
    enabled: true,
    currentUser: { name: auth.user.name, role: auth.user.role },
  })
}
