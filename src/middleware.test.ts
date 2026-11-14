// middleware 单测（Node runtime）：锁住「HTML 下发前的拦截口径」。
// 为什么值得测：这一层是唯一能让「未登录/已禁用」在页面渲染前就跳走的地方，
// 一旦某条分支退化成放行，用户就会看到骨架闪一下——而这种回归在手工点测时很容易漏。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { NextRequest } from 'next/server'
import { middleware } from './middleware'
import { hashPassword } from './lib/password-hash'
import { issueSession } from './lib/session'
import { createUser, updateUser } from './lib/user-store'

const nextReq = (pathname: string, cookie?: string) =>
  new NextRequest(`http://x${pathname}`, { headers: cookie ? { cookie } : {} })

/** NextResponse.next() 的标记头；重定向看 status/location */
const isPass = (res: Response) => res.headers.get('x-middleware-next') === '1'
const isLoginRedirect = (res: Response) =>
  res.status === 303 && new URL(res.headers.get('location') ?? 'http://x').pathname === '/login'

describe('middleware（页面守卫）', () => {
  let root: string
  let prevEnv: Record<string, string | undefined>

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-eat-mw-'))
    prevEnv = {
      AI_EAT_DATA_DIR: process.env.AI_EAT_DATA_DIR,
      SESSION_SECRET: process.env.SESSION_SECRET,
    }
    process.env.AI_EAT_DATA_DIR = path.join(root, 'recipes')
    process.env.SESSION_SECRET = 'test-secret-for-middleware-0123456789'
  })

  afterEach(async () => {
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    await fs.rm(root, { recursive: true, force: true })
  })

  async function makeUser(name = '测试用户') {
    const user = await createUser({
      name,
      passwordHash: await hashPassword('pass1234'),
      role: 'member',
    })
    const token = await issueSession({ uid: user.id, ver: user.sessionVersion })
    return { user, cookie: `ai-eat-session=${token}` }
  }

  it('/login 永远放行（否则重定向循环）', async () => {
    expect(isPass(await middleware(nextReq('/login')))).toBe(true)
  })

  it('无 Cookie → 303 到 /login?next=<原路径>', async () => {
    await makeUser()
    const res = await middleware(nextReq('/recipes'))
    expect(res.status).toBe(303)
    const loc = new URL(res.headers.get('location')!)
    expect(loc.pathname).toBe('/login')
    expect(loc.searchParams.get('next')).toBe('/recipes')
  })

  it('保留查询串到 next（登录后可回到带参数的原页）', async () => {
    await makeUser()
    const loc = new URL((await middleware(nextReq('/recipes?tag=汤'))).headers.get('location')!)
    // req.nextUrl.search 已是编码态（?tag=%E6%B1%A4），原样带进 next，登录后 safeNextPath 会接受它
    expect(loc.searchParams.get('next')).toBe('/recipes?tag=%E6%B1%A4')
  })

  it('根路径不塞 next=/（避免多余的 ?next=%2F）', async () => {
    await makeUser()
    const loc = new URL((await middleware(nextReq('/'))).headers.get('location')!)
    expect(loc.searchParams.get('next')).toBeNull()
  })

  it('有效会话 → 放行', async () => {
    const { cookie } = await makeUser()
    expect(isPass(await middleware(nextReq('/recipes', cookie)))).toBe(true)
  })

  it('伪造 / 跨实例 Cookie（签名不符）→ 303', async () => {
    await makeUser()
    expect(isLoginRedirect(await middleware(nextReq('/recipes', 'ai-eat-session=abc.def')))).toBe(true)
  })

  it('过期 token → 303', async () => {
    const user = await createUser({
      name: '过期用户',
      passwordHash: await hashPassword('pass1234'),
      role: 'member',
    })
    const expired = await issueSession({ uid: user.id, ver: user.sessionVersion }, Date.now() - 31 * 86400_000)
    expect(isLoginRedirect(await middleware(nextReq('/recipes', `ai-eat-session=${expired}`)))).toBe(true)
  })

  it('被禁用后旧 token（签名仍合法）→ 303（本次修复的核心）', async () => {
    const { user, cookie } = await makeUser()
    expect(isPass(await middleware(nextReq('/recipes', cookie)))).toBe(true)

    await updateUser(user.id, { disabled: true, sessionVersion: user.sessionVersion + 1 })
    expect(isLoginRedirect(await middleware(nextReq('/recipes', cookie)))).toBe(true)
  })

  it('仅置 disabled（不改 sessionVersion）也 → 303', async () => {
    // 单独锁定 disabled 判定：上面的用例同时 bump 了 sessionVersion，会被版本判定兜住，
    // 删掉 disabled 分支测试仍会通过（变异测试暴露的缺口）
    const { user, cookie } = await makeUser()
    await updateUser(user.id, { disabled: true })
    expect(isLoginRedirect(await middleware(nextReq('/recipes', cookie)))).toBe(true)
  })

  it('改密后旧 token → 303，新版本 token → 放行', async () => {
    const { user, cookie } = await makeUser()
    await updateUser(user.id, { sessionVersion: user.sessionVersion + 1 })
    expect(isLoginRedirect(await middleware(nextReq('/recipes', cookie)))).toBe(true)

    const fresh = await issueSession({ uid: user.id, ver: user.sessionVersion + 1 })
    expect(isPass(await middleware(nextReq('/recipes', `ai-eat-session=${fresh}`)))).toBe(true)
  })

  it('用户表损坏（503）→ 放行，让页面展示明确错误而不是困在登录页', async () => {
    const { cookie } = await makeUser()
    await fs.writeFile(path.join(root, 'users.json'), '{ 坏掉的 json')
    expect(isPass(await middleware(nextReq('/recipes', cookie)))).toBe(true)
  })

  it('旧模式（从未初始化）→ 放行，交由 /login 引导建号', async () => {
    expect(isPass(await middleware(nextReq('/recipes')))).toBe(true)
  })
})
