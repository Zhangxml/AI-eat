// 「连点 N 次显示隐藏入口」的计数逻辑（设置页隐藏「访问记录」入口用）。
// 为什么抽成纯模块：设置页是纯 UI 页、项目里无组件测试；把它做成可注入时间源的纯对象，
// 才能用 vitest 锁定「相邻点击超时重置」「达阈值后保持显示」这些容易写错的边界。
// 语义：
// - 「连续」= 相邻两次点击间隔 ≤ windowMs（防误触累积：昨天点 3 次、今天点 2 次不该触发）
// - 达到 threshold 次后保持解锁（调用方只管显示，不需要再处理状态）
// - 非有限值/负数时间戳按 0 处理，避免注入非法值把计数弄乱
export interface TapRevealOptions {
  /** 需要的连续点击次数 */
  threshold: number
  /** 相邻两次点击的最大间隔（毫秒），超过则重新计数 */
  windowMs: number
}

export interface TapReveal {
  /** 记录一次点击（now 为毫秒时间戳），返回「是否已达到阈值」 */
  tap(now: number): boolean
  /** 当前累计次数（测试与调试用） */
  count(): number
  /** 是否已解锁 */
  revealed(): boolean
}

// 默认参数：5 次、相邻间隔 1.5 秒（手机连点 5 次约 1 秒，1.5 秒足够宽松；停顿思考即自动重置）
// 冻结默认值：避免外部误改（例如测试里改一下就让全局默认变了）
export const DEFAULT_TAP_REVEAL_OPTIONS: TapRevealOptions = Object.freeze({ threshold: 5, windowMs: 1500 })

export function createTapReveal(opts: TapRevealOptions = DEFAULT_TAP_REVEAL_OPTIONS): TapReveal {
  // opts ?? {}：运行时传 null 也按默认值处理，不抛 TypeError（TS 层已禁止，这里兜运行时）
  const o = opts ?? DEFAULT_TAP_REVEAL_OPTIONS
  // 注意：Math.max(1, NaN) === NaN，光靠 Math.max 兜不住 NaN。
  // 阈值/窗口非法（NaN/Infinity/缺失）时回落默认值，避免出现「计数一直涨却永不解锁」的死状态。
  const threshold = Number.isFinite(o.threshold)
    ? Math.max(1, Math.floor(o.threshold))
    : DEFAULT_TAP_REVEAL_OPTIONS.threshold
  const windowMs = Number.isFinite(o.windowMs)
    ? Math.max(0, o.windowMs)
    : DEFAULT_TAP_REVEAL_OPTIONS.windowMs

  let hits = 0
  let lastAt: number | null = null
  let unlocked = false

  return {
    tap(now: number): boolean {
      if (unlocked) return true

      const t = Number.isFinite(now) && now >= 0 ? now : 0
      // 首次点击，或距上次点击超过窗口 → 从这一下重新计数
      // t >= lastAt：时钟被回拨（NTP/手动改时间）时不算连续，避免把很久以前的点击并进来
      const continues = lastAt !== null && t >= lastAt && t - lastAt <= windowMs
      hits = continues ? hits + 1 : 1
      lastAt = t

      if (hits >= threshold) unlocked = true
      return unlocked
    },

    count(): number {
      return hits
    },

    revealed(): boolean {
      return unlocked
    },
  }
}
