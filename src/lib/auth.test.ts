// 守卫单测：requireSession 的三种模式（未启用多用户 / 已启用且会话有效 / 无效）
// 以及「跨用户访问必须 404」所依赖的归属判定工具
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { LEGACY_OWNER_ID, bootstrapRequired, requireAdmin, requireSession } from './auth'
import { issueSession, sessionCookie } from './session'
import { createUser } from './user-store'

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
    delete process.env.PASSWORD
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

  it('未启用多用户（无 users.json）→ 放行并返回 LEGACY_OWNER', async () => {
    const r = await requireSession(reqWith())
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.user.id).toBe(LEGACY_OWNER_ID)
      expect(r.user.role).toBe('admin')
    }
  })

  it('bootstrapRequired：无用户为 true，有用户为 false', async () => {
    expect(await bootstrapRequired()).toBe(true)
    await createUser({ name: '爸爸', passwordHash: 'h' })
    expect(await bootstrapRequired()).toBe(false)
  })

  it('已启用多用户 + 无 Cookie → 401', async () => {
    await createUser({ name: '爸爸', passwordHash: 'h' })
    const r = await requireSession(reqWith())
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.res.status).toBe(401)
  })

  it('已启用多用户 + 有效会话 → 返回该用户', async () => {
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
    // 模拟改密：版本 +1
    const { updateUser } = await import('./user-store')
    await updateUser(u.id, { sessionVersion: u.sessionVersion + 1, passwordHash: 'h2' })
    const r = await requireSession(reqWith(`ai-eat-session=${token}`), NOW + 1000)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.res.status).toBe(401)
  })

  it('用户被禁用 → 401', async () => {
    const u = await createUser({ name: '妈妈', passwordHash: 'h' })
    const token = await issueSession({ uid: u.id, ver: u.sessionVersion }, NOW)
    const { updateUser } = await import('./user-store')
    await updateUser(u.id, { disabled: true })
    const r = await requireSession(reqWith(`ai-eat-session=${token}`), NOW + 1000)
    expect(r.ok).toBe(false)
  })

  it('用户被删除 → 401（需保留另一个用户，否则禁止删除）', async () => {
    await createUser({ name: '爸爸', passwordHash: 'h' })
    const u = await createUser({ name: '妈妈', passwordHash: 'h' })
    const token = await issueSession({ uid: u.id, ver: u.sessionVersion }, NOW)
    const { deleteUser } = await import('./user-store')
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
    if (!denied.ok) expect(denied.res.status).toBe(403)
  })

  it('未启用多用户时 requireAdmin 也放行（兼容旧模式）', async () => {
    const r = await requireAdmin(reqWith())
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.user.id).toBe(LEGACY_OWNER_ID)
  })

  it('sessionCookie 仍保留（登录下发用）', () => {
    expect(sessionCookie('t', null)).toContain('HttpOnly')
  })
})
