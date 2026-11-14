// 会话 token 单测：载荷含 uid/ver/exp，密钥独立于用户口令
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  SESSION_COOKIE,
  decodeToken,
  issueSession,
  readSessionSecret,
  sessionCookie,
  verifySession,
} from './session'

const NOW = 1_800_000_000_000

describe('session token', () => {
  let root: string

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-eat-session-'))
    process.env.AI_EAT_DATA_DIR = path.join(root, 'recipes')
    delete process.env.SESSION_SECRET
  })

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
    delete process.env.AI_EAT_DATA_DIR
    delete process.env.SESSION_SECRET
  })

  it('签发的 token 可校验通过，载荷含 uid 与 ver', async () => {
    const t = await issueSession({ uid: 'u-a1b2c3d4', ver: 3 }, NOW)
    expect(await verifySession(t, NOW + 1000)).toEqual({ uid: 'u-a1b2c3d4', ver: 3 })
    expect(decodeToken(t)?.uid).toBe('u-a1b2c3d4')
    expect(decodeToken(t)?.ver).toBe(3)
  })

  it('过期 token 校验失败', async () => {
    const t = await issueSession({ uid: 'u-a1b2c3d4', ver: 1 }, NOW)
    expect(await verifySession(t, NOW + 31 * 86400_000)).toBeNull()
  })

  it('篡改载荷（改 uid）后签名不符 → null', async () => {
    const t = await issueSession({ uid: 'u-a1b2c3d4', ver: 1 }, NOW)
    const [, sig] = t.split('.')
    const forgedPayload = Buffer.from(JSON.stringify({ uid: 'u-deadbeef', ver: 1, exp: NOW + 1000 })).toString('base64url')
    expect(await verifySession(`${forgedPayload}.${sig}`, NOW)).toBeNull()
  })

  it('篡改签名 → null', async () => {
    const t = await issueSession({ uid: 'u-a1b2c3d4', ver: 1 }, NOW)
    const [payload] = t.split('.')
    expect(await verifySession(`${payload}.${'0'.repeat(64)}`, NOW)).toBeNull()
  })

  it('格式非法（无点、多点、空）→ null，不抛错', async () => {
    for (const bad of ['', 'abc', 'a.b.c', '.', 'a.']) {
      await expect(verifySession(bad, NOW)).resolves.toBeNull()
    }
  })

  it('密钥自动生成并落盘（0600），同一进程内稳定', async () => {
    const s1 = await readSessionSecret()
    const s2 = await readSessionSecret()
    expect(s1).toBe(s2)
    expect(s1.length).toBeGreaterThan(30)
    const file = path.join(root, '.session-secret')
    const stat = await fs.stat(file)
    expect(stat.mode & 0o777).toBe(0o600)
  })

  it('env.SESSION_SECRET 优先于文件', async () => {
    process.env.SESSION_SECRET = 'explicit-secret-for-test'
    expect(await readSessionSecret()).toBe('explicit-secret-for-test')
  })

  it('换密钥后旧 token 失效', async () => {
    process.env.SESSION_SECRET = 'key-A'
    const t = await issueSession({ uid: 'u-a1b2c3d4', ver: 1 }, NOW)
    expect(await verifySession(t, NOW)).not.toBeNull()
    process.env.SESSION_SECRET = 'key-B'
    expect(await verifySession(t, NOW)).toBeNull()
  })

  it('sessionCookie 属性：HttpOnly + SameSite=Lax + 30 天；https 才加 Secure', () => {
    const c = sessionCookie('tok', null)
    expect(c).toContain(`${SESSION_COOKIE}=tok`)
    expect(c).toContain('HttpOnly')
    expect(c).toContain('Path=/')
    expect(c).toContain('SameSite=Lax')
    expect(c).toContain('Max-Age=2592000')
    expect(c).not.toContain('Secure')
    expect(sessionCookie('tok', 'https')).toContain('Secure')
    expect(sessionCookie('tok', 'HTTPS,http')).toContain('Secure')
  })
})
