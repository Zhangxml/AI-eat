// 「连点 N 次显示隐藏入口」计数逻辑单测
// 覆盖：达阈值才解锁、间隔超时重置、达阈值后保持、默认参数、非法时间戳
import { describe, expect, it } from 'vitest'
import { DEFAULT_TAP_REVEAL_OPTIONS, createTapReveal } from './tap-reveal'

describe('createTapReveal 连点解锁', () => {
  it('未达阈值不解锁，达到第 threshold 次才解锁', () => {
    const t = createTapReveal({ threshold: 5, windowMs: 1500 })
    // 每 200ms 点一次，全部在窗口内
    const results = [0, 200, 400, 600, 800].map(ms => t.tap(ms))
    expect(results.slice(0, 4)).toEqual([false, false, false, false])
    expect(results[4]).toBe(true)
    expect(t.revealed()).toBe(true)
  })

  it('相邻间隔超过 windowMs 时重新计数（不会跨很久累积）', () => {
    const t = createTapReveal({ threshold: 5, windowMs: 1500 })
    // 点 4 次（间隔 200ms）→ 停 5 秒 → 再点 1 次：不应解锁（计数已重置为 1）
    for (const ms of [0, 200, 400, 600]) expect(t.tap(ms)).toBe(false)
    expect(t.count()).toBe(4)
    expect(t.tap(600 + 5000)).toBe(false)
    expect(t.count()).toBe(1)
  })

  it('恰好等于 windowMs 的间隔算「连续」（边界含等号）', () => {
    const t = createTapReveal({ threshold: 3, windowMs: 1000 })
    expect(t.tap(0)).toBe(false)
    expect(t.tap(1000)).toBe(false)
    expect(t.tap(2000)).toBe(true)
  })

  it('超过 windowMs 一毫秒即重置（边界另一侧）', () => {
    const t = createTapReveal({ threshold: 3, windowMs: 1000 })
    t.tap(0)
    t.tap(1001) // 超时 → 重新从 1 开始
    expect(t.count()).toBe(1)
    expect(t.tap(1100)).toBe(false) // 2
    expect(t.tap(1200)).toBe(true) // 3
  })

  it('解锁后保持解锁，无需继续点击', () => {
    const t = createTapReveal({ threshold: 2, windowMs: 1000 })
    t.tap(0)
    expect(t.tap(100)).toBe(true)
    expect(t.revealed()).toBe(true)
    // 之后隔很久再点，仍然解锁（调用方只管显示，不该被重置回隐藏）
    expect(t.tap(999999)).toBe(true)
    expect(t.revealed()).toBe(true)
  })

  it('默认参数为 5 次、1.5 秒窗口', () => {
    expect(DEFAULT_TAP_REVEAL_OPTIONS).toEqual({ threshold: 5, windowMs: 1500 })
    const t = createTapReveal()
    for (const ms of [0, 300, 600, 900]) expect(t.tap(ms)).toBe(false)
    expect(t.tap(1200)).toBe(true)
  })

  it('首次点击即从 1 开始计数（不会因为 lastAt 为空而多算）', () => {
    const t = createTapReveal({ threshold: 2, windowMs: 1000 })
    expect(t.count()).toBe(0)
    expect(t.tap(0)).toBe(false)
    expect(t.count()).toBe(1)
  })

  it('非法时间戳（NaN/Infinity/负数）按 0 处理，不抛错、不误判为超时', () => {
    const t = createTapReveal({ threshold: 3, windowMs: 1000 })
    expect(t.tap(Number.NaN)).toBe(false)
    expect(t.tap(Number.POSITIVE_INFINITY)).toBe(false)
    expect(t.tap(-5)).toBe(true) // 三次都被收敛到 0，间隔 0 ≤ 窗口 → 连续
  })

  it('threshold 小于 1 时收敛为 1（防御性：至少点一次就能解锁）', () => {
    const t = createTapReveal({ threshold: 0, windowMs: 1000 })
    expect(t.tap(0)).toBe(true)
    expect(createTapReveal({ threshold: -3, windowMs: 1000 }).tap(0)).toBe(true)
  })

  it('threshold 为小数时向下取整（4.9 → 需 4 次）', () => {
    const t = createTapReveal({ threshold: 4.9, windowMs: 1000 })
    expect(t.tap(0)).toBe(false) // 1
    expect(t.tap(100)).toBe(false) // 2
    expect(t.tap(200)).toBe(false) // 3
    expect(t.tap(300)).toBe(true) // 4 >= floor(4.9)
  })

  it('threshold/windowMs 为 NaN 或 Infinity 时回落默认值（Math.max 兜不住 NaN）', () => {
    // 阈值 NaN：若直接用 Math.max(1, NaN) === NaN，会 hits >= NaN 恒 false，永远解不开
    const t = createTapReveal({ threshold: Number.NaN, windowMs: 1000 })
    for (const ms of [0, 100, 200, 300]) expect(t.tap(ms)).toBe(false)
    expect(t.tap(400)).toBe(true) // 回落默认 5 次

    // 窗口 NaN：若直接用，t - lastAt <= NaN 恒 false，计数永远停在 1
    const t2 = createTapReveal({ threshold: 5, windowMs: Number.NaN })
    for (const ms of [0, 100, 200, 300]) t2.tap(ms)
    expect(t2.count()).toBe(4) // 回落默认 1500ms 窗口，4 次全部计入（若窗口 NaN 会停在 1）

    // Infinity 阈值同样不可用，回落默认
    const t3 = createTapReveal({ threshold: Number.POSITIVE_INFINITY, windowMs: 1000 })
    for (const ms of [0, 100, 200, 300]) expect(t3.tap(ms)).toBe(false)
    expect(t3.tap(400)).toBe(true)
  })

  it('时钟被回拨（时间戳变小）不算连续，避免把很久以前的点击并进来', () => {
    const t = createTapReveal({ threshold: 3, windowMs: 1000 })
    expect(t.tap(1000)).toBe(false) // 1
    expect(t.tap(500)).toBe(false) // 回拨 → 重置为 1
    expect(t.count()).toBe(1)
    expect(t.tap(600)).toBe(false) // 2
    expect(t.tap(700)).toBe(true) // 3
  })

  it('windowMs 为 Infinity / 负数时回落默认值（Math.max(0, Infinity) 会让窗口无限大）', () => {
    // Infinity 窗口：若直接用会让「任何间隔」都算连续（永不重置）
    const t = createTapReveal({ threshold: 3, windowMs: Number.POSITIVE_INFINITY })
    t.tap(0)
    // 默认窗口 1500ms，隔 5000ms 应重置
    expect(t.tap(5000)).toBe(false)
    expect(t.count()).toBe(1)

    // 负窗口：收敛为 0（只有同毫秒才算连续）
    const t2 = createTapReveal({ threshold: 2, windowMs: -100 })
    expect(t2.tap(0)).toBe(false)
    expect(t2.tap(1)).toBe(false) // 超 0ms 窗口 → 重置
    expect(t2.tap(1)).toBe(true) // 同毫秒连击
  })

  it('运行时传 null 不抛错，按默认值处理', () => {
    const t = createTapReveal(null as unknown as { threshold: number; windowMs: number })
    for (const ms of [0, 100, 200, 300]) expect(t.tap(ms)).toBe(false)
    expect(t.tap(400)).toBe(true) // 默认 5 次
  })

  it('默认值对象被冻结，外部误改不会影响后续实例', () => {
    expect(Object.isFrozen(DEFAULT_TAP_REVEAL_OPTIONS)).toBe(true)
    // 严格模式下写冻结对象会抛错；此处只断言值未被改变
    const before = { ...DEFAULT_TAP_REVEAL_OPTIONS }
    try {
      ;(DEFAULT_TAP_REVEAL_OPTIONS as { threshold: number }).threshold = 2
    } catch {
      /* 冻结对象在严格模式下抛 TypeError，属预期 */
    }
    expect(DEFAULT_TAP_REVEAL_OPTIONS).toEqual(before)
    // 新建实例仍按 5 次
    const t = createTapReveal()
    for (const ms of [0, 100, 200, 300]) expect(t.tap(ms)).toBe(false)
    expect(t.tap(400)).toBe(true)
  })

  it('windowMs 为 0 时只有同一毫秒的连击才算连续（边界）', () => {
    const t = createTapReveal({ threshold: 2, windowMs: 0 })
    expect(t.tap(0)).toBe(false)
    expect(t.tap(0)).toBe(true)
    const t2 = createTapReveal({ threshold: 2, windowMs: 0 })
    expect(t2.tap(0)).toBe(false)
    expect(t2.tap(1)).toBe(false) // 超 0ms 窗口 → 重置
  })
})
