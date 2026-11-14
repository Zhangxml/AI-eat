// 登录限流单测：键归一化/截断、指数退避、容量淘汰、全局桶
import { beforeEach, describe, expect, it } from 'vitest'
import {
  attemptKey,
  backoffRemaining,
  clearFailures,
  globalBackoffRemaining,
  recordFailure,
  recordGlobalFailure,
  GLOBAL_MAX_ATTEMPTS,
  MAX_ATTEMPTS,
  __resetLoginThrottle,
} from './login-throttle'

const NOW = 1_800_000_000_000

describe('login-throttle', () => {
  beforeEach(() => __resetLoginThrottle())

  it('attemptKey：大小写/首尾空白归一，超长用户名截断（防内存膨胀）', () => {
    expect(attemptKey('1.1.1.1', '  Admin ')).toBe(attemptKey('1.1.1.1', 'admin'))
    const long = 'a'.repeat(100_000)
    expect(attemptKey('1.1.1.1', long).length).toBeLessThan(100)
  })

  it(`连续失败 ${MAX_ATTEMPTS} 次后进入指数退避，时间到后恢复`, () => {
    const key = attemptKey('ip', 'u')
    for (let i = 0; i < MAX_ATTEMPTS - 1; i++) recordFailure(key, NOW)
    expect(backoffRemaining(key, NOW)).toBe(0)
    recordFailure(key, NOW)
    expect(backoffRemaining(key, NOW)).toBeGreaterThan(0)
    // 退避窗口过去后可以再试
    expect(backoffRemaining(key, NOW + 60_000)).toBe(0)
  })

  it('窗口过期后计数重置', () => {
    const key = attemptKey('ip', 'u')
    for (let i = 0; i < MAX_ATTEMPTS; i++) recordFailure(key, NOW)
    expect(backoffRemaining(key, NOW)).toBeGreaterThan(0)
    expect(backoffRemaining(key, NOW + 11 * 60_000)).toBe(0)
  })

  it('容量超限只淘汰最旧，不清空全部（旧实现 clear() 可被用来重置爆破计数）', () => {
    const victim = attemptKey('ip', 'victim')
    for (let i = 0; i < MAX_ATTEMPTS; i++) recordFailure(victim, NOW)
    expect(backoffRemaining(victim, NOW)).toBeGreaterThan(0)

    // 灌满 1000+ 个键触发淘汰
    for (let i = 0; i < 1100; i++) recordFailure(attemptKey('flood', `u${i}`), NOW)
    // victim 仍在退避（未被整体清空）
    expect(backoffRemaining(victim, NOW)).toBeGreaterThan(0)
  })

  it('成功后清空该键', () => {
    const key = attemptKey('ip', 'u')
    for (let i = 0; i < MAX_ATTEMPTS; i++) recordFailure(key, NOW)
    clearFailures(key)
    expect(backoffRemaining(key, NOW)).toBe(0)
  })

  it(`全局桶与用户名无关：${GLOBAL_MAX_ATTEMPTS} 次失败后对该来源退避`, () => {
    // 换不同用户名各失败一次 —— 单用户名桶永远不会触发
    for (let i = 0; i < GLOBAL_MAX_ATTEMPTS - 1; i++) {
      recordFailure(attemptKey('direct', `u${i}`), NOW)
      recordGlobalFailure('direct', NOW)
    }
    expect(globalBackoffRemaining('direct', NOW)).toBe(0)
    recordFailure(attemptKey('direct', 'last'), NOW)
    recordGlobalFailure('direct', NOW)
    expect(globalBackoffRemaining('direct', NOW)).toBeGreaterThan(0)
    // 其他来源不受影响
    expect(globalBackoffRemaining('other', NOW)).toBe(0)
  })
})
