// 登录接口（Task 16）：POST 校验口令并签发会话 Cookie；GET 供登录页查询鉴权是否启用
// POST 契约：body { password } → 200 { ok: true } + Set-Cookie（会话 30 天）
//   错误密码 → 401 { error }；body 非法（非 JSON / 缺 password / 非字符串）→ 400 { error }
// GET 契约：{ enabled: boolean }——登录页据此决定是否需要登录；本路由不受守卫保护
import { verifyPassword, issueToken, authEnabled, sessionCookie } from '@/lib/auth'
import { appendAccessLog, clientIpOf } from '@/lib/access-log'

// POST /api/auth：口令校验 → Set-Cookie 签发会话
// 访问日志（方案 A）：登录尝试（含失败）都记录——401 序列是「有人乱试口令」的审计线索
export async function POST(req: Request): Promise<Response> {
  const ip = clientIpOf(req)
  let body: unknown
  try {
    body = await req.json()
  } catch {
    await appendAccessLog({ ip, method: 'POST', path: '/api/auth', status: 400 })
    return Response.json({ error: '请求体不是合法 JSON' }, { status: 400 })
  }
  if (typeof body !== 'object' || body === null) {
    await appendAccessLog({ ip, method: 'POST', path: '/api/auth', status: 400 })
    return Response.json({ error: '请求体格式非法' }, { status: 400 })
  }
  const password = (body as { password?: unknown }).password
  if (typeof password !== 'string') {
    await appendAccessLog({ ip, method: 'POST', path: '/api/auth', status: 400 })
    return Response.json({ error: '请求体格式非法：缺少 password' }, { status: 400 })
  }
  if (!verifyPassword(password)) {
    await appendAccessLog({ ip, method: 'POST', path: '/api/auth', status: 401 })
    return Response.json({ error: '口令错误' }, { status: 401 })
  }
  // 访问日志：登录成功
  await appendAccessLog({ ip, method: 'POST', path: '/api/auth', status: 200 })
  // Secure 按 x-forwarded-proto 首段推导（http(s)），绝不从 req.url 判断（反代场景 req.url 是内部 http 地址）
  const token = issueToken()
  return Response.json(
    { ok: true },
    { headers: { 'Set-Cookie': sessionCookie(token, req.headers.get('x-forwarded-proto')) } },
  )
}

// GET /api/auth：鉴权开关查询（登录页判断用，始终放行）
export async function GET(): Promise<Response> {
  return Response.json({ enabled: authEnabled() })
}
