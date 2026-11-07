// PASSWORD 口令会话鉴权（Task 16，设计 5.6）：
// - authEnabled：PASSWORD 非空即启用（与 /api/config 的 authEnabled 同一语义，config 路由复用本函数为单一事实来源）
// - verifyPassword：timingSafeEqual 恒时比较（长度不等先短路返回 false，避开其等长断言 throw）
// - issueToken / isValidToken：HMAC-SHA256 签名会话令牌，payload 只放过期时间 exp（不放密码本身），
//   密钥直接用 PASSWORD 值经 crypto.createHmac 的 key 参数（自用场景，不需要 KDF）
// - requireAuth：受保护路由的守卫，未启用放行（null），启用且会话无效返回 401 { error: '请先登录' }
import { createHmac, timingSafeEqual } from 'node:crypto'

// 会话有效期 30 天（毫秒），与 Cookie Max-Age=2592000 保持一致
const SESSION_TTL_MS = 30 * 86400_000
// 会话 Cookie 名（登录下发与守卫校验两侧共用）
export const SESSION_COOKIE = 'ai-eat-session'

// 是否启用鉴权：PASSWORD 非空即启用
export function authEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.PASSWORD)
}

// 校验登录口令：与 env.PASSWORD 做 timingSafeEqual 恒时比较
export function verifyPassword(password: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const expected = env.PASSWORD ?? ''
  // 未设置/空口令视为无合法口令，一律拒绝
  if (expected === '') return false
  const a = Buffer.from(password, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  // 长度不等必须先短路返回：timingSafeEqual 对不等长输入直接 throw
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

// 派生 HMAC 密钥：直接用 PASSWORD 值作为 createHmac 的 key（裁定 3：自用场景不需要 KDF）
function hmacKey(env: NodeJS.ProcessEnv): string | null {
  const password = env.PASSWORD ?? ''
  return password === '' ? null : password
}

// 签发会话令牌：base64url(payload) + '.' + hex(hmacSHA256(payload, PASSWORD))
// payload 只含过期时间 { exp: now + 30天 }；now 可注入便于测试过期/边界
export function issueToken(now: number = Date.now()): string {
  const payload = JSON.stringify({ exp: now + SESSION_TTL_MS })
  const encoded = Buffer.from(payload, 'utf8').toString('base64url')
  const sig = createHmac('sha256', process.env.PASSWORD ?? '').update(encoded).digest('hex')
  return `${encoded}.${sig}`
}

// 校验会话令牌：验签（恒时比较）+ 未过期（exp > now，即 exp ≤ now 视为过期）
// token 格式非法、签名不符、密钥缺失、已过期均返回 false，不 throw
export function isValidToken(token: string, env: NodeJS.ProcessEnv = process.env, now: number = Date.now()): boolean {
  const key = hmacKey(env)
  if (key === null) return false
  const dot = token.indexOf('.')
  if (dot <= 0 || dot === token.length - 1) return false
  // 只允许一段 '.'（多余段即非法格式）
  if (token.indexOf('.', dot + 1) !== -1) return false
  const encoded = token.slice(0, dot)
  const sig = token.slice(dot + 1)
  const expected = createHmac('sha256', key).update(encoded).digest('hex')
  const a = Buffer.from(sig, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length !== b.length) return false
  if (!timingSafeEqual(a, b)) return false
  // 验签通过后再验过期时间
  let payload: { exp?: unknown }
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as { exp?: unknown }
  } catch {
    return false
  }
  return typeof payload.exp === 'number' && payload.exp > now
}

// 从 Cookie 头取指定 cookie 的值；无该键返回 null（只按第一个 '=' 切分，值本身不含分号）
function cookieValue(header: string, name: string): string | null {
  for (const part of header.split(';')) {
    const item = part.trim()
    const eq = item.indexOf('=')
    if (eq === -1) continue
    if (item.slice(0, eq) === name) return item.slice(eq + 1)
  }
  return null
}

// 路由守卫：未启用鉴权返回 null（放行）；启用且 Cookie 会话无效返回 401
// 用法（各受保护 handler 首行）：const denied = requireAuth(req); if (denied) return denied;
export function requireAuth(req: Request, env: NodeJS.ProcessEnv = process.env): Response | null {
  if (!authEnabled(env)) return null
  const header = req.headers.get('cookie')
  const token = header === null ? null : cookieValue(header, SESSION_COOKIE)
  if (token === null || !isValidToken(token, env)) {
    return Response.json({ error: '请先登录' }, { status: 401 })
  }
  return null
}

// 组装登录成功后的 Set-Cookie 值：HttpOnly + SameSite=Lax + 30 天有效期
// Secure 按 x-forwarded-proto 首段推导（http(s)），绝不从 req.url 判断——
// 反向代理场景 req.url 是内部 http 地址，按它判断会给 HTTPS 部署漏发 Secure，
// 且纯 HTTP 局域网部署不该被 Secure 卡死（LibreTV 验证过的关键坑）
export function sessionCookie(token: string, forwardedProto: string | null): string {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    `Max-Age=${30 * 86400}`,
  ]
  const proto = forwardedProto?.split(',')[0]?.trim().toLowerCase() ?? ''
  if (proto === 'https') parts.push('Secure')
  return parts.join('; ')
}
