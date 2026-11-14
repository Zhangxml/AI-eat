// 校验「登录后回跳目标」，防开放重定向。
// 为什么不能只判断 startsWith('/')：按 WHATWG URL 规范，special scheme（http/https）里
// 反斜杠与正斜杠等价，`/\evil.com` 会被解析成 `http://evil.com/` —— 只挡 `//` 会漏掉它。
// 正确做法：用 URL 解析归一化后比较 origin，同源才接受，且只保留 pathname + search。
export function safeNextPath(raw: string | null, origin: string): string {
  if (raw === null || raw === '') return '/'
  // 反斜杠一律拒绝：WHATWG 在 special scheme 下把 \ 当作 /，`/\evil.com` 与 `//evil.com` 等价，
  // 语义混乱且是开放重定向的经典变体。直接拒绝比逐个推演解析结果更可靠。
  if (raw.includes('\\')) return '/'
  // 编码形式（%5C）解码后若是反斜杠，同样拒绝——否则会落到 //evil.com 或站内 404
  let decoded = raw
  try {
    decoded = decodeURIComponent(raw)
  } catch {
    return '/'
  }
  if (decoded.includes('\\')) return '/'
  let url: URL
  try {
    url = new URL(raw, origin)
  } catch {
    return '/'
  }
  // 跨源（含 //evil.com、/\evil.com、https://evil.com、javascript:）一律回落首页
  if (url.origin !== origin) return '/'
  const path = url.pathname + url.search
  // 归一化后必须仍是「单斜杠开头的站内路径」：
  // `new URL('/..//evil.com', origin)` 会把点段归一化成 `//evil.com`（origin 仍同源），
  // 只比 origin 会放行，最终 window.location.replace('//evil.com') 跳到站外。
  if (!path.startsWith('/') || path.startsWith('//')) return '/'
  // 不接受登录页自身（避免登录后原地打转）
  if (path === '/login' || path.startsWith('/login?')) return '/'
  return path
}
