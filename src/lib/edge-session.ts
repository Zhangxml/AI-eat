// Edge 运行时可用的会话验签（middleware 专用）。
//
// 为什么单独一份：src/lib/session.ts 依赖 node:crypto（createHmac/timingSafeEqual），
// 无法打进 Edge bundle；而 middleware 必须能验签，否则只能「看到 Cookie 就放行」——
// 那会让任何无效/过期/来自其它实例的 Cookie 都渲染出完整骨架再被 401 踢走（闪一下）。
//
// 只做两件事：验签名 + 验过期。
// **不**校验「用户是否存在 / 是否被禁用 / sessionVersion 是否匹配」——那些要读 users.json，
// Edge 没有文件系统。这部分仍由 API 层守卫负责，因此「改密/禁用后的旧会话」在页面层
// 仍会有一次骨架闪现（低频，可接受）。

// 会话 Cookie 名：middleware（Edge）与 src/lib/session.ts（node）共用同一份定义。
// 若两处各写一份，将来改名只改一处会导致「所有页面 303 到 /login、登录后仍被拦」的死循环。
export const SESSION_COOKIE = 'ai-eat-session'

export interface EdgeSessionClaims {
  uid: string
  ver: number
  exp: number
}

function b64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('')
}

/**
 * 校验 token 的签名与过期时间。
 * @param token   `<payloadB64>.<hexSig>`
 * @param secret  会话密钥（来自 env.SESSION_SECRET）
 * @param now     当前时间（毫秒），测试可注入
 */
export async function verifySessionEdge(
  token: string,
  secret: string,
  now: number = Date.now(),
): Promise<EdgeSessionClaims | null> {
  if (secret === '') return null
  const dot = token.indexOf('.')
  if (dot <= 0 || dot === token.length - 1) return null
  if (token.indexOf('.', dot + 1) !== -1) return null

  const payloadB64 = token.slice(0, dot)
  const sigHex = token.slice(dot + 1)

  let expectedHex: string
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    )
    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payloadB64))
    expectedHex = toHex(sig)
  } catch {
    return null
  }
  // 定长比较（签名恒为 64 hex 字符，长度不等直接失败）
  if (sigHex.length !== expectedHex.length) return null
  // 逐字符异或后归零，避免提前返回造成的时序差异
  let diff = 0
  for (let i = 0; i < sigHex.length; i++) diff |= sigHex.charCodeAt(i) ^ expectedHex.charCodeAt(i)
  if (diff !== 0) return null

  // 验过期
  let payload: { uid?: unknown; ver?: unknown; exp?: unknown }
  try {
    const json = new TextDecoder().decode(b64urlToBytes(payloadB64))
    payload = JSON.parse(json) as typeof payload
  } catch {
    return null
  }
  // 必须先挡住 null/非对象：JSON.parse('null') 得到 null，直接读 .uid 会抛 TypeError，
  // 而 middleware 里抛异常 = 500（node 侧的 decodeToken 把这段包在 try 里，行为更稳）
  if (typeof payload !== 'object' || payload === null) return null
  if (
    typeof payload.uid !== 'string' ||
    typeof payload.ver !== 'number' ||
    typeof payload.exp !== 'number'
  ) {
    return null
  }
  if (payload.exp <= now) return null
  return { uid: payload.uid, ver: payload.ver, exp: payload.exp }
}
