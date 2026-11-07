// auth 鉴权模块单测（Task 16）：
// - authEnabled / verifyPassword / isValidToken / requireAuth 均显式传 env 参数，不依赖 process.env
// - issueToken 契约签名无 env 参数（密钥取 process.env.PASSWORD），本文件用快照接管并在 afterEach 恢复
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { authEnabled, verifyPassword, issueToken, isValidToken, requireAuth } from './auth'

// 测试局部 env 字面量经 unknown 中转：Next 的 global.d.ts 把 ProcessEnv.NODE_ENV 声明为必填，
// 直接 as NodeJS.ProcessEnv 因重叠不足被 TS 拒绝（同 ai-client.test.ts 的既有处理）
const envOf = (vars: Record<string, string>): NodeJS.ProcessEnv => vars as unknown as NodeJS.ProcessEnv

// requireAuth 的 401 响应体形状
interface ErrorResponse {
  error: string
}

// 把 token 的末位字符换成同字母表里的另一个字符（保证一定变了）
function flipLast(s: string, alt: string): string {
  return s.slice(0, -1) + (s.endsWith(alt) ? (alt === 'A' ? 'B' : 'A') : alt)
}

describe('auth 鉴权模块', () => {
  let envSnapshot: NodeJS.ProcessEnv

  beforeEach(() => {
    envSnapshot = { ...process.env }
    process.env.PASSWORD = 'p'
  })

  afterEach(() => {
    process.env = envSnapshot
  })

  // —— authEnabled ——
  it('authEnabled：PASSWORD 非空 true；空串/未设 false（显式 env，不碰 process.env）', () => {
    expect(authEnabled(envOf({ PASSWORD: 'p' }))).toBe(true)
    expect(authEnabled(envOf({ PASSWORD: '' }))).toBe(false)
    expect(authEnabled(envOf({}))).toBe(false)
  })

  // —— verifyPassword ——
  it('verifyPassword：正确口令 true；错误口令 false', () => {
    expect(verifyPassword('p', envOf({ PASSWORD: 'p' }))).toBe(true)
    expect(verifyPassword('wrong', envOf({ PASSWORD: 'p' }))).toBe(false)
  })

  it('verifyPassword：长度不等时短路返回 false，不触发 timingSafeEqual 的等长断言 throw', () => {
    expect(() => verifyPassword('short', envOf({ PASSWORD: 'a-much-longer-password' }))).not.toThrow()
    expect(verifyPassword('short', envOf({ PASSWORD: 'a-much-longer-password' }))).toBe(false)
  })

  it('verifyPassword：PASSWORD 未设/为空 → 一律 false（未启用即无合法口令）', () => {
    expect(verifyPassword('', envOf({}))).toBe(false)
    expect(verifyPassword('anything', envOf({}))).toBe(false)
  })

  // —— issueToken / isValidToken ——
  it('issueToken：payload 为 base64url、签名为 64 位小写 hex，payload 解出 { exp: now + 30天 }', () => {
    const now = 1730000000000
    const token = issueToken(now)
    const [payload, sig] = token.split('.') as [string, string]
    expect(payload).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(sig).toMatch(/^[0-9a-f]{64}$/)
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { exp: number }
    expect(parsed.exp).toBe(now + 30 * 86400_000)
  })

  it('正确密码签发的 token 校验通过（签发与校验同密钥）', () => {
    const token = issueToken(Date.now())
    expect(isValidToken(token, envOf({ PASSWORD: 'p' }))).toBe(true)
  })

  it('过期 token 拒绝（exp ≤ 校验时刻即失效，边界含等号）', () => {
    const now = Date.now()
    expect(isValidToken(issueToken(now - 31 * 86400_000), envOf({ PASSWORD: 'p' }))).toBe(false)
    // 边界：校验时刻恰好等于 exp → 失效；早 1 毫秒 → 有效
    const token = issueToken(now)
    const exp = now + 30 * 86400_000
    expect(isValidToken(token, envOf({ PASSWORD: 'p' }), exp)).toBe(false)
    expect(isValidToken(token, envOf({ PASSWORD: 'p' }), exp - 1)).toBe(true)
  })

  it('篡改 token 拒绝：payload 或签名任一字符变动即 false', () => {
    const token = issueToken(Date.now())
    const [payload, sig] = token.split('.') as [string, string]
    const badPayload = `${flipLast(payload, 'A')}.${sig}`
    const badSig = `${payload}.${flipLast(sig, 'a')}`
    expect(isValidToken(badPayload, envOf({ PASSWORD: 'p' }))).toBe(false)
    expect(isValidToken(badSig, envOf({ PASSWORD: 'p' }))).toBe(false)
  })

  it('换密钥签发的 token 校验失败（HMAC 密钥随 PASSWORD 变化）', () => {
    const token = issueToken(Date.now())
    expect(isValidToken(token, envOf({ PASSWORD: 'other-secret' }))).toBe(false)
  })

  it('垃圾 token 拒绝：空串/无签名段/多余段/纯乱码均 false 且不 throw', () => {
    expect(() => isValidToken('', envOf({ PASSWORD: 'p' }))).not.toThrow()
    expect(isValidToken('', envOf({ PASSWORD: 'p' }))).toBe(false)
    expect(isValidToken('noseparator', envOf({ PASSWORD: 'p' }))).toBe(false)
    expect(isValidToken('a.b.c', envOf({ PASSWORD: 'p' }))).toBe(false)
    expect(isValidToken('!@#.zz', envOf({ PASSWORD: 'p' }))).toBe(false)
  })

  it('PASSWORD 未设时 isValidToken 一律 false（无密钥即无法验签）', () => {
    expect(isValidToken('x.y', envOf({}))).toBe(false)
  })

  // —— requireAuth ——
  it('未设置 PASSWORD 时 requireAuth 放行（返回 null）', () => {
    expect(requireAuth(new Request('http://x'), envOf({}))).toBeNull()
  })

  it('启用后无 Cookie 返回 401 + { error: 请先登录 }', async () => {
    const denied = requireAuth(new Request('http://x'), envOf({ PASSWORD: 'p' }))
    expect(denied?.status).toBe(401)
    expect(((await denied?.json()) as ErrorResponse).error).toBe('请先登录')
  })

  it('启用后带合法会话 Cookie 放行；与其他 cookie 共存也能解析', () => {
    const token = issueToken(Date.now())
    const ok = requireAuth(
      new Request('http://x', { headers: { cookie: `other=1; ai-eat-session=${token}` } }),
      envOf({ PASSWORD: 'p' }),
    )
    expect(ok).toBeNull()
  })

  it('启用后带篡改/过期/空值会话 Cookie → 401', () => {
    // 过期 token
    const stale = issueToken(Date.now() - 31 * 86400_000)
    expect(
      requireAuth(new Request('http://x', { headers: { cookie: `ai-eat-session=${stale}` } }), envOf({ PASSWORD: 'p' }))?.status,
    ).toBe(401)
    // 篡改 payload 的 token
    const token = issueToken(Date.now())
    const [payload, sig] = token.split('.') as [string, string]
    const bad = `${flipLast(payload, 'A')}.${sig}`
    expect(
      requireAuth(new Request('http://x', { headers: { cookie: `ai-eat-session=${bad}` } }), envOf({ PASSWORD: 'p' }))?.status,
    ).toBe(401)
    // 空值 cookie
    expect(
      requireAuth(new Request('http://x', { headers: { cookie: 'ai-eat-session=' } }), envOf({ PASSWORD: 'p' }))?.status,
    ).toBe(401)
  })
})
