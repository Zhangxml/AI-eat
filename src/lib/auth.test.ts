// 守卫单测：两种运行模式下的 requireSession / requireAdmin 行为。
//
// - 密码模式（env.PASSWORD 非空）：未初始化 → 401；会话有效 → 返回该用户；禁用/删除/版本不符 → 401
// - 免密模式（env.PASSWORD 空）：系统只有一个身份（最早的管理员）；未初始化会自动建「管理员」
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_ADMIN_NAME, bootstrapRequired, firstAdmin, requireAdmin, requireSession } from './auth'
import { issueSession, sessionCookie } from './session'
import { createUser, listUsers, updateUser, deleteUser } from './user-store'

const NOW = 1_800_000_000_000

describe('requireSession 守卫', () => {
  let root: string
  let prevEnv: Record<string, string | undefined>

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-eat-auth-'))
    prevEnv = {
      AI_EAT_DATA_DIR: process.env.AI_EAT_DATA_DIR,
      SESSION_SECRET: process.env.SESSION_SECRET,
      PASSWORD: process.env.PASSWORD,
    }
    process.env.AI_EAT_DATA_DIR = path.join(root, 'recipes')
    process.env.SESSION_SECRET = 'test-secret-0123456789abcdef'
    // 默认密码模式；免密模式的用例自己 delete
    process.env.PASSWORD = 'test-password'
  })

  afterEach(async () => {
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    await fs.rm(root, { recursive: true, force: true })
  })

  const reqWith = (cookie?: string) =>
    new Request('http://x/api/recipes', { headers: cookie ? { cookie } : {} })

  it('bootstrapRequired：无用户为 true，有用户为 false', async () => {
    expect(await bootstrapRequired()).toBe(true)
    await createUser({ name: '爸爸', passwordHash: 'h' })
    expect(await bootstrapRequired()).toBe(false)
  })

  // ---------------- 密码模式 ----------------

  it('密码模式 + 未初始化 → 401（由登录页引导建号）', async () => {
    const r = await requireSession(reqWith())
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.res.status).toBe(401)
      expect(r.reason).toBe('unauthenticated')
    }
  })

  it('密码模式 + 无 Cookie → 401', async () => {
    await createUser({ name: '爸爸', passwordHash: 'h' })
    const r = await requireSession(reqWith())
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.res.status).toBe(401)
  })

  it('密码模式 + 有效会话 → 返回该用户', async () => {
    await createUser({ name: '爸爸', passwordHash: 'h' }) // 首个是 admin
    const u = await createUser({ name: '妈妈', passwordHash: 'h' })
    const token = await issueSession({ uid: u.id, ver: u.sessionVersion }, NOW)
    const r = await requireSession(reqWith(`ai-eat-session=${token}`), NOW + 1000)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.user.id).toBe(u.id)
      expect(r.user.name).toBe('妈妈')
      expect(r.user.role).toBe('member')
    }
  })

  it('sessionVersion 不匹配（改密后）→ 401', async () => {
    const u = await createUser({ name: '妈妈', passwordHash: 'h' })
    const token = await issueSession({ uid: u.id, ver: u.sessionVersion }, NOW)
    await updateUser(u.id, { sessionVersion: u.sessionVersion + 1, passwordHash: 'h2' })
    const r = await requireSession(reqWith(`ai-eat-session=${token}`), NOW + 1000)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.res.status).toBe(401)
  })

  it('用户被禁用 → 401', async () => {
    const u = await createUser({ name: '妈妈', passwordHash: 'h' })
    const token = await issueSession({ uid: u.id, ver: u.sessionVersion }, NOW)
    await updateUser(u.id, { disabled: true })
    const r = await requireSession(reqWith(`ai-eat-session=${token}`), NOW + 1000)
    expect(r.ok).toBe(false)
  })

  it('用户被删除 → 401（需保留另一个用户，否则禁止删除）', async () => {
    await createUser({ name: '爸爸', passwordHash: 'h' })
    const u = await createUser({ name: '妈妈', passwordHash: 'h' })
    const token = await issueSession({ uid: u.id, ver: u.sessionVersion }, NOW)
    await deleteUser(u.id)
    const r = await requireSession(reqWith(`ai-eat-session=${token}`), NOW + 1000)
    expect(r.ok).toBe(false)
  })

  it('requireAdmin：member → 403，admin → 放行', async () => {
    const admin = await createUser({ name: '爸爸', passwordHash: 'h' })
    const member = await createUser({ name: '妈妈', passwordHash: 'h' })
    const adminTok = await issueSession({ uid: admin.id, ver: 1 }, NOW)
    const memberTok = await issueSession({ uid: member.id, ver: 1 }, NOW)

    const okAdmin = await requireAdmin(reqWith(`ai-eat-session=${adminTok}`), NOW + 1000)
    expect(okAdmin.ok).toBe(true)

    const denied = await requireAdmin(reqWith(`ai-eat-session=${memberTok}`), NOW + 1000)
    expect(denied.ok).toBe(false)
    if (!denied.ok) {
      expect(denied.res.status).toBe(403)
      expect(denied.reason).toBe('forbidden')
    }
  })

  // ---------------- 免密单用户模式 ----------------

  it('免密 + 未初始化 → 自动创建「管理员」并放行（无需 Cookie）', async () => {
    delete process.env.PASSWORD
    const r = await requireSession(reqWith())
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.user.name).toBe(DEFAULT_ADMIN_NAME)
      expect(r.user.role).toBe('admin')
    }
    // 已落库，且只有一个账号
    const users = await listUsers()
    expect(users).toHaveLength(1)
    expect(users[0].role).toBe('admin')
  })

  it('免密 + 已初始化 → 用最早的管理员身份（忽略 Cookie）', async () => {
    delete process.env.PASSWORD
    const first = await createUser({ name: '最早管理员', passwordHash: 'h' })
    await createUser({ name: '后来管理员', passwordHash: 'h' })
    const r = await requireSession(reqWith())
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.user.id).toBe(first.id)
  })

  it('免密 + 成员 token → 仍按管理员处理（系统只有一个身份）', async () => {
    delete process.env.PASSWORD
    const admin = await createUser({ name: '管理员', passwordHash: 'h' })
    const member = await createUser({ name: '妈妈', passwordHash: 'h' })
    const memberTok = await issueSession({ uid: member.id, ver: member.sessionVersion }, NOW)
    const r = await requireSession(reqWith(`ai-eat-session=${memberTok}`), NOW + 1000)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.user.id).toBe(admin.id)
      expect(r.user.role).toBe('admin')
    }
  })

  it('免密 + 用户表损坏 → 503（fail-closed）', async () => {
    delete process.env.PASSWORD
    await fs.writeFile(path.join(root, 'users.json'), '{坏掉的 json')
    const r = await requireSession(reqWith())
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.res.status).toBe(503)
      expect(r.reason).toBe('user-store-broken')
    }
  })

  it('免密 + 没有任何管理员 → 503', async () => {
    delete process.env.PASSWORD
    await createUser({ name: '妈妈', passwordHash: 'h', role: 'member' })
    const r = await requireSession(reqWith())
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.res.status).toBe(503)
  })

  it('免密 + users.json 被删但 users/ 仍在 → 503（不当成首次运行重建）', async () => {
    delete process.env.PASSWORD
    await createUser({ name: '管理员', passwordHash: 'h' })
    await fs.rm(path.join(root, 'users.json'))
    const r = await requireSession(reqWith())
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.res.status).toBe(503)
  })

  it('firstAdmin：取最早创建且未禁用的管理员', async () => {
    const a = await createUser({ name: '甲', passwordHash: 'h' })
    const b = await createUser({ name: '乙', passwordHash: 'h', role: 'admin' })
    expect((await firstAdmin())?.id).toBe(a.id)
    await updateUser(a.id, { disabled: true })
    expect((await firstAdmin())?.id).toBe(b.id)
  })

  it('sessionCookie 仍保留（登录下发用）', () => {
    expect(sessionCookie('t', null)).toContain('HttpOnly')
  })
})
