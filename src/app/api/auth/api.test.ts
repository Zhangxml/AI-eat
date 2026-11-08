// /api/auth 路由单测（Task 16）：POST 登录签发会话 Cookie / GET 查询鉴权开关
// env 用快照接管 + afterEach 恢复（PASSWORD 影响签发与校验两侧）
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { POST, GET } from './route'
import { isValidToken, SESSION_COOKIE } from '@/lib/auth'

// 测试局部 env 字面量经 unknown 中转：Next 的 global.d.ts 把 ProcessEnv.NODE_ENV 声明为必填，
// 直接 as NodeJS.ProcessEnv 因重叠不足被 TS 拒绝（同 ai-client.test.ts 的既有处理）
const envOf = (vars: Record<string, string>): NodeJS.ProcessEnv => vars as unknown as NodeJS.ProcessEnv

// POST 请求构造：带 JSON body
const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request('http://x/api/auth', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...headers },
  })

// Set-Cookie 值解析：name=值; 属性串 → { value, attrs }
function parseSetCookie(header: string): { value: string; attrs: string[] } {
  const segs = header.split(';')
  const pair = segs[0] ?? ''
  const eq = pair.indexOf('=')
  return { value: pair.slice(eq + 1), attrs: segs.slice(1).map(s => s.trim()) }
}

describe('/api/auth', () => {
  let envSnapshot: NodeJS.ProcessEnv

  beforeEach(() => {
    envSnapshot = { ...process.env }
    process.env.PASSWORD = 'p'
  })

  afterEach(() => {
    process.env = envSnapshot
  })

  it('正确密码 → 200 且 Set-Cookie 含 HttpOnly/Path=/ /SameSite=Lax/Max-Age=2592000，token 可验', async () => {
    const res = await POST(post({ password: 'p' }))
    expect(res.status).toBe(200)
    const setCookie = res.headers.get('set-cookie')
    expect(setCookie).toBeTruthy()
    const { value, attrs } = parseSetCookie(setCookie as string)
    expect(attrs).toEqual(expect.arrayContaining(['HttpOnly', 'Path=/', 'SameSite=Lax', 'Max-Age=2592000']))
    // 签发的 token 必须能通过守卫的同一密钥校验
    expect(isValidToken(value, envOf({ PASSWORD: 'p' }))).toBe(true)
    expect((await res.json())).toEqual({ ok: true })
  })

  it('纯 HTTP（x-forwarded-proto: http）不带 Secure；HTTPS 代理（首段 https）带 Secure', async () => {
    // 局域网纯 HTTP：绝不卡死登录（LibreTV 关键坑）
    const httpRes = await POST(post({ password: 'p' }, { 'x-forwarded-proto': 'http' }))
    const httpCookie = parseSetCookie(httpRes.headers.get('set-cookie') as string)
    expect(httpCookie.attrs).not.toContain('Secure')
    // 反代终止 TLS：x-forwarded-proto 首段 https → Secure
    const httpsRes = await POST(post({ password: 'p' }, { 'x-forwarded-proto': 'https,http' }))
    const httpsCookie = parseSetCookie(httpsRes.headers.get('set-cookie') as string)
    expect(httpsCookie.attrs).toContain('Secure')
    expect(SESSION_COOKIE).toBe('ai-eat-session')
  })

  it('缺失 x-forwarded-proto 头（纯 HTTP 直连默认路径）→ Set-Cookie 不含 Secure', async () => {
    // post() 默认不带该头：无代理头时绝不发 Secure，局域网 HTTP 直连不被卡死（LibreTV 坑回归面，
    // 锁定「不许改从 req.url 推导」之外的另一侧：默认路径必须无 Secure）
    const res = await POST(post({ password: 'p' }))
    const cookie = parseSetCookie(res.headers.get('set-cookie') as string)
    expect(cookie.attrs).not.toContain('Secure')
  })

  it('错误密码 → 401 { error } 中文', async () => {
    const res = await POST(post({ password: 'wrong' }))
    expect(res.status).toBe(401)
    expect(((await res.json()) as { error: string }).error).toBeTruthy()
  })

  it('body 非法（非 JSON / 缺 password / password 非字符串）→ 400 { error }', async () => {
    const broken = new Request('http://x/api/auth', { method: 'POST', body: '{oops', headers: { 'content-type': 'application/json' } })
    expect((await POST(broken)).status).toBe(400)
    expect((await POST(post({}))).status).toBe(400)
    expect((await POST(post({ password: 123 }))).status).toBe(400)
  })

  it('PASSWORD 未设：POST 正确密码也 401（无合法口令）；GET → { enabled: false }', async () => {
    delete process.env.PASSWORD
    const res = await POST(post({ password: 'p' }))
    expect(res.status).toBe(401)
    const getRes = await GET()
    expect(await getRes.json()).toEqual({ enabled: false })
  })

  it('GET：PASSWORD 已设 → { enabled: true }（登录页判断用，不受守卫保护）', async () => {
    const res = await GET()
    expect(await res.json()).toEqual({ enabled: true })
  })

  it('401 登录失败日志 60 秒节流（审计修复 #7）：同 IP 只记首条，窗口外恢复', async () => {
    // 用真实 appendAccessLog 落盘验证；用独立 XFF IP 作节流键（TRUST_PROXY=true 打开 XFF 读取），
    // 避免与同文件其他 401 用例共享 'unknown' 键而撞上已开启的 60 秒窗口
    const dataDir = await fs.mkdtemp('/tmp/opencode/ai-eat-auth-')
    process.env.AI_EAT_DATA_DIR = `${dataDir}/data/recipes`
    process.env.TRUST_PROXY = 'true'
    const postFrom = (ip: string, password: unknown) =>
      new Request('http://x/api/auth', {
        method: 'POST',
        body: JSON.stringify({ password }),
        headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
      })
    try {
      // 首次 401：记 1 条；紧接着两次 401：60 秒窗口内被节流，不再追加
      await POST(postFrom('10.99.99.1', 'wrong'))
      await POST(postFrom('10.99.99.1', 'wrong'))
      await POST(postFrom('10.99.99.1', 'wrong'))
      const { readAccessLogs } = await import('@/lib/access-log')
      const failLogs = (await readAccessLogs()).filter(l => l.status === 401)
      expect(failLogs).toHaveLength(1)
      expect(failLogs[0].ip).toBe('10.99.99.1')
      // 成功登录照常记录（200 不受节流影响）
      await POST(postFrom('10.99.99.1', 'p'))
      const okLogs = (await readAccessLogs()).filter(l => l.status === 200)
      expect(okLogs).toHaveLength(1)
    } finally {
      delete process.env.TRUST_PROXY
      await fs.rm(dataDir, { recursive: true, force: true })
      delete process.env.AI_EAT_DATA_DIR
    }
  })

  it('content-length 超 1MB → 413（审计修复 #4），不进入密码校验', async () => {
    const res = await POST(
      new Request('http://x/api/auth', {
        method: 'POST',
        body: JSON.stringify({ password: 'p' }),
        headers: { 'content-type': 'application/json', 'content-length': String(1024 * 1024 + 1) },
      }),
    )
    expect(res.status).toBe(413)
    expect(((await res.json()) as { error: string }).error).toBe('请求体过大')
  })
})
