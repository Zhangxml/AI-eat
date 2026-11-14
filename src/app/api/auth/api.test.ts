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
    // 默认密码模式：管理员密码由 env.PASSWORD 唯一决定（本文件的初始化密码就是它）
    process.env.PASSWORD = 'papa-1234'
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

  it('GET：无用户时 needsSetup=true（密码模式需登录）', async () => {
    const body = await (await GET(getReq())).json()
    expect(body).toEqual({ needsSetup: true, enabled: true })
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

  it('POST：初始化密码与 env.PASSWORD 不一致 → 401（密码模式下它就是管理员密码）', async () => {
    const res = await POST(loginReq({ username: '爸爸', password: 'abc' }))
    expect(res.status).toBe(401)
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
    const res = await POST(loginReq({ username: '妈妈', password: 'papa-1234' }))
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
    // 登录也必须 503（不能报「用户名或口令错误」，否则管理员会一直以为密码错了）
    const login = await POST(loginReq({ username: '爸爸', password: 'papa-1234' }))
    expect(login.status).toBe(503)
    expect(((await login.json()) as { error: string }).error).toContain('用户表损坏')
  })

  it('已迁移后 users.json 被删除（users/ 目录仍在）→ 503 且不可被抢建号', async () => {
    await POST(loginReq({ username: '爸爸', password: 'papa-1234' }))
    await fs.rm(path.join(root, 'users.json'))
    const { GET: recipesGet } = await import('@/app/api/recipes/route')
    expect((await recipesGet(new Request('http://x/api/recipes'))).status).toBe(503)
    // 不能进入 bootstrap：否则任何人都能接管。返回 503（表不可用）而非 401，
    // 避免把「数据坏了」误报成「密码错了」
    const preempt = await POST(loginReq({ username: '陌生人', password: 'hack1234' }))
    expect(preempt.status).toBe(503)
    expect((await GET(getReq())).status).toBe(200) // GET 仍返回 needsSetup:false/enabled:true
    const body = await (await GET(getReq())).json()
    expect(body.needsSetup).toBe(false)
  })

  it('空表 {"users":[]} → 503（不当成未迁移，登录也不报密码错）', async () => {
    await POST(loginReq({ username: '爸爸', password: 'papa-1234' }))
    await fs.writeFile(path.join(root, 'users.json'), JSON.stringify({ version: 1, users: [] }), 'utf8')
    const { GET: recipesGet } = await import('@/app/api/recipes/route')
    expect((await recipesGet(new Request('http://x/api/recipes'))).status).toBe(503)
    expect((await POST(loginReq({ username: '爸爸', password: 'papa-1234' }))).status).toBe(503)
  })

  it('PASSWORD 少于 4 位也能完成初始化（密码由 env 决定，不被长度检查卡死）', async () => {
    process.env.PASSWORD = 'abc'
    const res = await POST(loginReq({ username: '管理员', password: 'abc' }))
    expect(res.status).toBe(200)
    expect(await listUsers()).toHaveLength(1)
  })

  it('管理员登录只认 env.PASSWORD：改 env 后旧密码立即失效（无需改 users.json）', async () => {
    await POST(loginReq({ username: '爸爸', password: 'papa-1234' }))
    expect((await POST(loginReq({ username: '爸爸', password: 'papa-1234' }))).status).toBe(200)
    // 模拟改 env 后重启：同一个用户、同一个 hash，但密码来源已变
    process.env.PASSWORD = 'new-admin-pw'
    expect((await POST(loginReq({ username: '爸爸', password: 'papa-1234' }))).status).toBe(401)
    expect((await POST(loginReq({ username: '爸爸', password: 'new-admin-pw' }))).status).toBe(200)
  })

  it('免密模式：POST 拒绝登录（409），GET 返回 passwordless + 自动建出的管理员', async () => {
    delete process.env.PASSWORD
    const post = await POST(loginReq({ username: '任何人', password: 'whatever' }))
    expect(post.status).toBe(409)
    expect(((await post.json()) as { error: string }).error).toContain('免密')

    const body = (await (await GET(getReq())).json()) as {
      passwordless: boolean
      needsSetup: boolean
      currentUser: { name: string; role: string }
    }
    expect(body.passwordless).toBe(true)
    expect(body.needsSetup).toBe(false)
    expect(body.currentUser).toEqual({ name: '管理员', role: 'admin' })
    // 自动建号并落库
    expect((await listUsers()).map(u => u.name)).toEqual(['管理员'])
  })

  it('免密模式 + 已有管理员 → 登录仍拒绝，但身份沿用最早的管理员', async () => {
    delete process.env.PASSWORD
    const first = await POST(loginReq({ username: '甲', password: 'x' }))
    // 免密模式下 POST 一律 409，不会建号
    expect(first.status).toBe(409)
    // 通过 requireSession 自动建「管理员」
    const body = (await (await GET(getReq())).json()) as { currentUser: { name: string } }
    expect(body.currentUser.name).toBe('管理员')
  })

  it('并发初始化：只有一个建号成功，另一个 409（不会建出两个账号）', async () => {
    const [a, b] = await Promise.all([
      POST(loginReq({ username: '甲', password: 'papa-1234' })),
      POST(loginReq({ username: '乙', password: 'papa-1234' })),
    ])
    expect([a.status, b.status].sort()).toEqual([200, 409])
    const users = await listUsers()
    expect(users).toHaveLength(1)
    expect(users[0].role).toBe('admin')
  })

  it('用户存在后 getUser 能按 id 查到（初始化链路完整）', async () => {
    await POST(loginReq({ username: '爸爸', password: 'papa-1234' }))
    const [u] = await listUsers()
    expect((await getUser(u.id))?.name).toBe('爸爸')
  })
})

describe('建号迁移失败后的自愈', () => {
  let root: string
  let prevEnv: Record<string, string | undefined>

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-eat-auth-heal-'))
    prevEnv = {
      AI_EAT_DATA_DIR: process.env.AI_EAT_DATA_DIR,
      SESSION_SECRET: process.env.SESSION_SECRET,
      PASSWORD: process.env.PASSWORD,
    }
    process.env.AI_EAT_DATA_DIR = path.join(root, 'recipes')
    process.env.SESSION_SECRET = 'test-secret-for-auth-heal-0123456789'
    process.env.PASSWORD = 'papa-1234' // 密码模式：管理员登录走 env.PASSWORD
    __resetLoginThrottle()
  })

  afterEach(async () => {
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    await fs.rm(root, { recursive: true, force: true })
  })

  it('建号时迁移失败留下的旧数据，最早的管理员再次登录会自动补齐', async () => {
    // 建号（此时无旧数据，迁移 0 条并写完成标记）
    await POST(loginReq({ username: '爸爸', password: 'papa-1234' }))
    const [u] = await listUsers()
    // 清掉完成标记，模拟「建号时迁移失败、没来得及标记」
    await fs.rm(path.join(root, 'users', u.id, '.legacy-adopted'), { force: true })
    // 旧目录里还有菜谱（当时没搬成功）
    await fs.mkdir(path.join(root, 'recipes'), { recursive: true })
    await fs.writeFile(path.join(root, 'recipes', 'r-1.json'), '{"name":"旧菜"}', 'utf8')

    expect((await POST(loginReq({ username: '爸爸', password: 'papa-1234' }))).status).toBe(200)

    expect(await fs.readdir(path.join(root, 'users', u.id, 'recipes'))).toEqual(['r-1.json'])
    expect(await fs.readdir(path.join(root, 'recipes')).catch(() => [])).toEqual([])
  })

  it('迁移失败不阻塞登录（旧目录不可读时仍能登录）', async () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) return
    await POST(loginReq({ username: '爸爸', password: 'papa-1234' }))
    const [u] = await listUsers()
    await fs.rm(path.join(root, 'users', u.id, '.legacy-adopted'), { force: true })
    await fs.mkdir(path.join(root, 'recipes'), { recursive: true })
    await fs.chmod(path.join(root, 'recipes'), 0o000)
    const res = await POST(loginReq({ username: '爸爸', password: 'papa-1234' }))
    expect(res.status).toBe(200)
    await fs.chmod(path.join(root, 'recipes'), 0o755)
  })
})
