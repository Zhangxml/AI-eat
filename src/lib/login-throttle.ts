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

/**
 * 限流键。用户名先截断到 64 字符再拼：
 * 登录接口允许最长 1MB 的 body，若不截断，攻击者可用 900KB 的用户名把 Map key 撑爆
 * （实测 20 个请求就能让进程内存 +70MB，1000 个键可达数 GB）。
 * 截断只会让「超长用户名的不同后缀」共享同一个桶 —— 对合法用户无影响（真实用户名 ≤32）。
 */
export function attemptKey(ip: string, username: string): string {
  return `${ip}\u0000${username.trim().toLowerCase().slice(0, 64)}`
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
  // 超容量时只淘汰最旧的一条（Map 迭代顺序 = 插入顺序）。
  // 旧实现是 attempts.clear()：攻击者灌满 1000 个键就能把所有人的失败计数清零、重新开始爆破。
  while (attempts.size > MAP_CAP) {
    const oldest = attempts.keys().next().value
    if (oldest === undefined) break
    attempts.delete(oldest)
  }
}

export function clearFailures(key: string): void {
  attempts.delete(key)
}

// ---- 全局桶：与用户名无关，防「换一个不存在的用户名就绕过」与 scrypt CPU 放大 ----
// 阈值比单用户名宽松（正常用户偶尔打错几次不应被全站拦），但足够挡住批量刷。
export const GLOBAL_MAX_ATTEMPTS = 30
export const GLOBAL_FAIL_WINDOW_MS = 10 * 60_000
const globalAttempts = new Map<string, Attempt>()

function globalKey(ip: string): string {
  return `global\u0000${ip}`
}

/** 全局（按限流来源）还需等待的毫秒数 */
export function globalBackoffRemaining(ip: string, now: number = Date.now()): number {
  const a = globalAttempts.get(globalKey(ip))
  if (!a) return 0
  if (now - a.firstAt > GLOBAL_FAIL_WINDOW_MS) {
    globalAttempts.delete(globalKey(ip))
    return 0
  }
  if (a.count < GLOBAL_MAX_ATTEMPTS) return 0
  const over = a.count - GLOBAL_MAX_ATTEMPTS
  return Math.min(BACKOFF_BASE_MS * 2 ** over, BACKOFF_MAX_MS)
}

/** 记一次全局失败（任何用户名/用户不存在都算） */
export function recordGlobalFailure(ip: string, now: number = Date.now()): void {
  const key = globalKey(ip)
  const a = globalAttempts.get(key)
  if (!a || now - a.firstAt > GLOBAL_FAIL_WINDOW_MS) {
    globalAttempts.set(key, { count: 1, firstAt: now, lastAt: now })
    return
  }
  a.count += 1
  a.lastAt = now
  while (globalAttempts.size > MAP_CAP) {
    const oldest = globalAttempts.keys().next().value
    if (oldest === undefined) break
    globalAttempts.delete(oldest)
  }
}

/** 仅测试使用：清空全局桶 */
export function __resetGlobalThrottle(): void {
  globalAttempts.clear()
}

/** 仅测试使用：清空全部限流状态（生产代码不要调用） */
export function __resetLoginThrottle(): void {
  attempts.clear()
  globalAttempts.clear()
}
