import { describe, expect, it } from 'vitest'
import { INSPIRATION_STYLES, INSPIRATION_TECHNIQUES, pickInspiration } from './inspiration'

describe('灵感种子', () => {
  it('注入固定随机源时输出可预测（路由测试可稳定 mock）', () => {
    expect(pickInspiration(() => 0)).toBe(`本次灵感方向：${INSPIRATION_TECHNIQUES[0]} + ${INSPIRATION_STYLES[0]}`)
    expect(pickInspiration(() => 0.999)).toBe(
      `本次灵感方向：${INSPIRATION_TECHNIQUES.at(-1)} + ${INSPIRATION_STYLES.at(-1)}`,
    )
  })

  it('rng 返回 1 或非有限数时不越界', () => {
    expect(pickInspiration(() => 1)).toContain(INSPIRATION_TECHNIQUES.at(-1) as string)
    expect(pickInspiration(() => Number.NaN)).toContain(INSPIRATION_TECHNIQUES[0])
  })
})
