// /api/auth 单测（多用户改造后）：
// 首次初始化 → 登录 → 会话 → 登出；失败限流；用户名枚举防护；禁用账号拒绝
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { GET, POST } from './route'
import { getCookieValue } from './test-utils'
import { __resetLoginThrottle } from '@/lib/login-throttle'
import { getUser, listUsers, updateUser } from '@/lib/user-store'

const loginReq = (body: unknown) =>
  new Request('http://x/api/auth', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })

const getReq = (cookie?: string) =>
  new Request('http://x/api/auth', { headers: cookie ? { cookie } : {} })

describe('/api/auth', () => {
  let root: string
  let prevEnv: Record<string, string | undefined>

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-eat-auth-api-'))
    prevEnv = {
      AI_EAT_DATA_DIR: process.env.AI_EAT_DATA_DIR,
      SESSION_SECRET: process.env.SESSION_SECRET,
      PASSWORD: process.env.PASSWORD,
    }
    process.env.AI_EAT_DATA_DIR = path.join(root, 'recipes')
    process.env.SESSION_SECRET = 'test-secret-for-auth-api-0123456789'
    delete process.env.PASSWORD
    // 限流状态是模块级：每个用例前清空，避免测试之间互相影响
    __resetLoginThrottle()
  })

  afterEach(async () => {
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    await fs.rm(root, { recursive: true, force: true })
  })

  it('GET：无用户时 needsSetup=true', async () => {
    const body = await (await GET(getReq())).json()
    expect(body).toEqual({ needsSetup: true, enabled: false })
  })

  it('POST：首次用 username+password 初始化管理员，并下发会话 Cookie', async () => {
    const res = await POST(loginReq({ username: '爸爸', password: 'papa-1234' }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; user: { name: string; role: string } }
    expect(body.ok).toBe(true)
    expect(body.user).toEqual({ name: '爸爸', role: 'admin' })
    const cookie = getCookieValue(res.headers.get('set-cookie'))
    expect(cookie).toBeTruthy()
    // 会话可用
    const me = await (await GET(getReq(cookie!))).json()
    expect(me.currentUser).toEqual({ name: '爸爸', role: 'admin' })
    // 用户已入库，且存的是哈希
    const users = await listUsers()
    expect(users).toHaveLength(1)
    expect(users[0].passwordHash).toMatch(/^scrypt\$/)
    expect(users[0].passwordHash).not.toContain('papa-1234')
  })

  it('POST：初始化后再次登录需用户名+密码；错误密码 401；正确 200', async () => {
    await POST(loginReq({ username: '爸爸', password: 'papa-1234' }))
    const bad = await POST(loginReq({ username: '爸爸', password: 'wrong' }))
    expect(bad.status).toBe(401)
    const good = await POST(loginReq({ username: '爸爸', password: 'papa-1234' }))
    expect(good.status).toBe(200)
  })

  it('POST：不存在的用户名与错误密码返回同一文案（防枚举）', async () => {
    await POST(loginReq({ username: '爸爸', password: 'papa-1234' }))
    const noUser = await POST(loginReq({ username: '不存在的人', password: 'whatever' }))
    const badPw = await POST(loginReq({ username: '爸爸', password: 'whatever' }))
    expect(noUser.status).toBe(401)
    expect(badPw.status).toBe(401)
    expect(((await noUser.json()) as { error: string }).error).toBe(
      ((await badPw.json()) as { error: string }).error,
    )
  })

  it('POST：缺字段/非 JSON → 400', async () => {
    await POST(loginReq({ username: '爸爸', password: 'papa-1234' }))
    expect((await POST(loginReq({ username: '爸爸' }))).status).toBe(400)
    expect((await POST(loginReq({}))).status).toBe(400)
    expect(
      (await POST(new Request('http://x/api/auth', { method: 'POST', body: '{oops' }))).status,
    ).toBe(400)
  })

  it('POST：初始化时密码过短 → 400', async () => {
    const res = await POST(loginReq({ username: '爸爸', password: 'abc' }))
    expect(res.status).toBe(400)
    expect(await listUsers()).toHaveLength(0)
  })

  it('POST：设置了 env.PASSWORD 时，初始化需先输该引导口令', async () => {
    process.env.PASSWORD = 'bootstrap-pw'
    const denied = await POST(loginReq({ username: '爸爸', password: 'papa-1234' }))
    expect(denied.status).toBe(401)
    expect(await listUsers()).toHaveLength(0)
    const ok = await POST(loginReq({ username: '爸爸', password: 'bootstrap-pw' }))
    expect(ok.status).toBe(200)
  })

  it('被禁用的账号无法登录 → 401', async () => {
    await POST(loginReq({ username: '爸爸', password: 'papa-1234' }))
    const [u] = await listUsers()
    await updateUser(u.id, { disabled: true })
    const res = await POST(loginReq({ username: '爸爸', password: 'papa-1234' }))
    expect(res.status).toBe(401)
  })

  it('登录失败 5 次后进入退避（429）', async () => {
    await POST(loginReq({ username: '爸爸', password: 'papa-1234' }))
    for (let i = 0; i < 5; i++) {
      const r = await POST(loginReq({ username: '爸爸', password: 'wrong' }))
      expect(r.status).toBe(401)
    }
    const blocked = await POST(loginReq({ username: '爸爸', password: 'papa-1234' }))
    expect(blocked.status).toBe(429)
    expect(((await blocked.json()) as { error: string }).error).toContain('频繁')
  })

  it('改密（sessionVersion +1）后旧 Cookie 失效', async () => {
    const res = await POST(loginReq({ username: '爸爸', password: 'papa-1234' }))
    const cookie = getCookieValue(res.headers.get('set-cookie'))!
    expect((await (await GET(getReq(cookie))).json()).currentUser).toBeTruthy()

    const [u] = await listUsers()
    await updateUser(u.id, { sessionVersion: u.sessionVersion + 1 })
    const after = await (await GET(getReq(cookie))).json()
    expect(after.currentUser).toBeUndefined()
  })

  it('GET：已登录时返回 currentUser', async () => {
    const res = await POST(loginReq({ username: '妈妈', password: 'mama-1234' }))
    const cookie = getCookieValue(res.headers.get('set-cookie'))!
    const me = await (await GET(getReq(cookie))).json()
    expect(me.needsSetup).toBe(false)
    expect(me.enabled).toBe(true)
    expect(me.currentUser.name).toBe('妈妈')
  })

  it('已迁移后 users.json 被截断 → 全站 503（不能退化成无鉴权）', async () => {
    await POST(loginReq({ username: '爸爸', password: 'papa-1234' }))
    // 模拟掉电/半写：截断文件
    await fs.writeFile(path.join(root, 'users.json'), '{"version":1,"users":[{"id":"u-1', 'utf8')
    const { GET: recipesGet } = await import('@/app/api/recipes/route')
    const res = await recipesGet(new Request('http://x/api/recipes'))
    expect(res.status).toBe(503)
    expect(((await res.json()) as { error: string }).error).toContain('用户表损坏')
  })

  it('已迁移后 users.json 被删除（users/ 目录仍在）→ 503 且不可被抢建号', async () => {
    await POST(loginReq({ username: '爸爸', password: 'papa-1234' }))
    await fs.rm(path.join(root, 'users.json'))
    const { GET: recipesGet } = await import('@/app/api/recipes/route')
    expect((await recipesGet(new Request('http://x/api/recipes'))).status).toBe(503)
    // 不能进入 bootstrap：否则任何人都能接管
    const preempt = await POST(loginReq({ username: '陌生人', password: 'hack1234' }))
    expect(preempt.status).toBe(401)
    expect((await GET(getReq())).status).toBe(200) // GET 仍返回 needsSetup:false/enabled:true
    const body = await (await GET(getReq())).json()
    expect(body.needsSetup).toBe(false)
  })

  it('空表 {"users":[]} → 503（不当成未迁移）', async () => {
    await POST(loginReq({ username: '爸爸', password: 'papa-1234' }))
    await fs.writeFile(path.join(root, 'users.json'), JSON.stringify({ version: 1, users: [] }), 'utf8')
    const { GET: recipesGet } = await import('@/app/api/recipes/route')
    expect((await recipesGet(new Request('http://x/api/recipes'))).status).toBe(503)
  })

  it('用户存在后 getUser 能按 id 查到（初始化链路完整）', async () => {
    await POST(loginReq({ username: '爸爸', password: 'papa-1234' }))
    const [u] = await listUsers()
    expect((await getUser(u.id))?.name).toBe('爸爸')
  })
})
