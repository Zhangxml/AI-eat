// 登录接口（Task 16）：POST 校验口令并签发会话 Cookie；GET 供登录页查询鉴权是否启用
// POST 契约：body { password } → 200 { ok: true } + Set-Cookie（会话 30 天）
//   错误密码 → 401 { error }；body 非法（非 JSON / 缺 password / 非字符串）→ 400 { error }
// GET 契约：{ enabled: boolean }——登录页据此决定是否需要登录；本路由不受守卫保护
import { verifyPassword, issueToken, authEnabled, sessionCookie } from '@/lib/auth'
import { appendAccessLog, clientIpOf } from '@/lib/access-log'
import { checkBodySize, BODY_LIMIT_BYTES } from '@/lib/body-limit'

// 登录失败日志节流（审计修复 #7）：同一 IP 60 秒内的反复试错只记首条 401，
// 防止暴力枚举把 200 条审计窗口刷满、淹没真实操作记录。Map 超过 500 个 IP 时整体清空防膨胀。
// 成功登录（200）与其余状态码（400 等）照常逐条记录，不受节流影响
const LOGIN_FAIL_LOG_INTERVAL_MS = 60_000
const LOGIN_FAIL_MAP_CAP = 500
const lastLoginFailLogAt = new Map<string, number>()

// 401 分支专用：节流判断后按需写日志
async function logLoginFailureThrottled(ip: string): Promise<void> {
  const now = Date.now()
  const last = lastLoginFailLogAt.get(ip) ?? 0
  if (now - last < LOGIN_FAIL_LOG_INTERVAL_MS) return
  lastLoginFailLogAt.set(ip, now)
  if (lastLoginFailLogAt.size > LOGIN_FAIL_MAP_CAP) lastLoginFailLogAt.clear()
  await appendAccessLog({ ip, method: 'POST', path: '/api/auth', status: 401 })
}

// POST /api/auth：口令校验 → Set-Cookie 签发会话
// 访问日志（方案 A）：登录尝试（含失败）都记录——401 序列是「有人乱试口令」的审计线索；
// 401 经 60 秒节流（见 logLoginFailureThrottled），成功与其余状态码照常逐条记录
export async function POST(req: Request): Promise<Response> {
  const ip = clientIpOf(req)
  // body 体积前置闸门（审计修复 #4）：登录 body 只有一个口令字段，超 1MB 必然非法，不进解析
  if (!checkBodySize(req, BODY_LIMIT_BYTES)) {
    return Response.json({ error: '请求体过大' }, { status: 413 })
  }
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
    // 节流：同 IP 60 秒内只写首条 401（防枚举刷满审计窗口），窗口外恢复记录
    await logLoginFailureThrottled(ip)
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
