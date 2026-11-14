// 会话令牌：HMAC-SHA256 签名，载荷 { uid, ver, exp }。
// 与旧实现的关键差异（多用户改造）：
// - 载荷带 uid：服务端能知道「是谁」，而不只是「已登录」
// - 载荷带 ver：对应 users.json 的 sessionVersion；改密码/禁用时 +1 → 该用户所有旧 token 立即失效
// - 密钥独立于用户口令：优先 env.SESSION_SECRET，否则自动生成 32 字节随机值写入 data/.session-secret（0600）
//   绝不能再用「用户密码」当签名密钥——多用户后服务端只存哈希，拿不到明文
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { dataRoot } from './user-store'

// 会话有效期 30 天，与 Cookie Max-Age 保持一致
const SESSION_TTL_MS = 30 * 86400_000
export const SESSION_COOKIE = 'ai-eat-session'

export interface SessionPayload {
  uid: string
  /** 用户的 sessionVersion 快照 */
  ver: number
  /** 过期时间（毫秒时间戳） */
  exp: number
}

export function sessionSecretPath(): string {
  return path.join(dataRoot(), '.session-secret')
}

// 进程内缓存：避免每个请求都读盘。按「密钥文件路径」缓存——
// 若只缓存一个值，进程内切换 AI_EAT_DATA_DIR（测试、或多实例共用一个进程）会读到别的目录的密钥。
// env 优先且不缓存（便于测试与热切换）。
const cachedByPath = new Map<string, string>()

export async function readSessionSecret(): Promise<string> {
  const fromEnv = process.env.SESSION_SECRET
  if (fromEnv && fromEnv !== '') return fromEnv

  const file = sessionSecretPath()
  const cached = cachedByPath.get(file)
  if (cached !== undefined) return cached

  try {
    const raw = (await fs.readFile(file, 'utf8')).trim()
    if (raw.length >= 32) {
      cachedByPath.set(file, raw)
      return raw
    }
  } catch {
    // 不存在/不可读 → 下面生成
  }

  const secret = randomBytes(32).toString('base64url')
  await fs.mkdir(path.dirname(file), { recursive: true })
  // 0600：仅服务进程可读（写失败不致命——本次进程内仍可用，但重启后 token 会失效）
  await fs.writeFile(file, secret + '\n', { encoding: 'utf8', mode: 0o600 }).catch(() => {})
  cachedByPath.set(file, secret)
  return secret
}

function sign(payloadB64: string, secret: string): string {
  return createHmac('sha256', secret).update(payloadB64).digest('hex')
}

/** 签发 token；now 可注入便于测试 */
export async function issueSession(
  input: { uid: string; ver: number },
  now: number = Date.now(),
): Promise<string> {
  const payload: SessionPayload = { uid: input.uid, ver: input.ver, exp: now + SESSION_TTL_MS }
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  const secret = await readSessionSecret()
  return `${payloadB64}.${sign(payloadB64, secret)}`
}

/** 仅解码（不验签，用于日志/调试）；格式非法返回 null */
export function decodeToken(token: string): SessionPayload | null {
  const dot = token.indexOf('.')
  if (dot <= 0 || dot === token.length - 1) return null
  if (token.indexOf('.', dot + 1) !== -1) return null
  try {
    const parsed = JSON.parse(
      Buffer.from(token.slice(0, dot), 'base64url').toString('utf8'),
    ) as Partial<SessionPayload>
    if (
      typeof parsed.uid === 'string' &&
      typeof parsed.ver === 'number' &&
      typeof parsed.exp === 'number'
    ) {
      return { uid: parsed.uid, ver: parsed.ver, exp: parsed.exp }
    }
  } catch {
    // 非法 JSON
  }
  return null
}

/** 验签 + 验过期；任何异常返回 null（不抛） */
export async function verifySession(
  token: string,
  now: number = Date.now(),
): Promise<{ uid: string; ver: number } | null> {
  const dot = token.indexOf('.')
  if (dot <= 0 || dot === token.length - 1) return null
  if (token.indexOf('.', dot + 1) !== -1) return null

  const payloadB64 = token.slice(0, dot)
  const sig = token.slice(dot + 1)

  let secret: string
  try {
    secret = await readSessionSecret()
  } catch {
    return null
  }
  const expected = sign(payloadB64, secret)
  const a = Buffer.from(sig, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length !== b.length) return null
  if (!timingSafeEqual(a, b)) return null

  const payload = decodeToken(token)
  if (payload === null) return null
  if (payload.exp <= now) return null
  return { uid: payload.uid, ver: payload.ver }
}

/** 会话 Cookie：HttpOnly + SameSite=Lax + 30 天；Secure 仅 https（按 x-forwarded-proto 首段） */
export function sessionCookie(token: string, forwardedProto: string | null): string {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    'Max-Age=2592000',
  ]
  const proto = forwardedProto?.split(',')[0]?.trim().toLowerCase() ?? ''
  if (proto === 'https') parts.push('Secure')
  return parts.join('; ')
}
