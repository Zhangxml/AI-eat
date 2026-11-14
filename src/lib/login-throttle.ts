// 登录失败限流：同 (ip, 用户名) 连续失败 N 次后，后续尝试按指数退避拒绝（429）。
// 为什么单独成模块：
// - route 文件不能导出非 HTTP 方法符号（Next 的类型约束），测试需要 reset 就得放别处
// - 纯逻辑无 IO，便于单测
// 参数：窗口 10 分钟；连续失败 5 次起退避，1s→2s→4s…上限 60s
export const FAIL_WINDOW_MS = 10 * 60_000
export const MAX_ATTEMPTS = 5
const BACKOFF_BASE_MS = 1000
const BACKOFF_MAX_MS = 60_000
const MAP_CAP = 1000

interface Attempt {
  count: number
  firstAt: number
  lastAt: number
}

const attempts = new Map<string, Attempt>()

export function attemptKey(ip: string, username: string): string {
  return `${ip}\u0000${username.trim().toLowerCase()}`
}

/** 还需等待的毫秒数（0 = 可尝试） */
export function backoffRemaining(key: string, now: number = Date.now()): number {
  const a = attempts.get(key)
  if (!a) return 0
  if (now - a.firstAt > FAIL_WINDOW_MS) {
    attempts.delete(key)
    return 0
  }
  if (a.count < MAX_ATTEMPTS) return 0
  const over = a.count - MAX_ATTEMPTS
  const wait = Math.min(BACKOFF_BASE_MS * 2 ** over, BACKOFF_MAX_MS)
  const since = now - a.lastAt
  return since >= wait ? 0 : wait - since
}

export function recordFailure(key: string, now: number = Date.now()): void {
  const a = attempts.get(key)
  if (!a || now - a.firstAt > FAIL_WINDOW_MS) {
    attempts.set(key, { count: 1, firstAt: now, lastAt: now })
    return
  }
  a.count += 1
  a.lastAt = now
  if (attempts.size > MAP_CAP) attempts.clear()
}

export function clearFailures(key: string): void {
  attempts.delete(key)
}

/** 仅测试使用：清空全部限流状态（生产代码不要调用） */
export function __resetLoginThrottle(): void {
  attempts.clear()
}
