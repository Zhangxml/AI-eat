// MenuEpoch 单测：锁定「重置菜单后旧请求不得写回」的代次语义
import { describe, expect, it } from 'vitest'
import { MenuEpoch } from './menu-epoch'

describe('MenuEpoch 菜单代次守卫', () => {
  it('初始代次为 0，bump 后递增', () => {
    const e = new MenuEpoch()
    expect(e.value).toBe(0)
    expect(e.bump()).toBe(1)
    expect(e.value).toBe(1)
  })

  it('同一代次内的请求不算过期（正常生成可写回）', () => {
    const e = new MenuEpoch()
    const v = e.bump()
    expect(e.isStale(v)).toBe(false)
  })

  it('菜单被重新获取后，旧请求的返回被判为过期（不写回，避免显示上一个菜单的菜谱）', () => {
    const e = new MenuEpoch()
    const oldRequest = e.bump() // 菜单A
    e.bump() // 用户重新点菜 → 菜单B
    expect(e.isStale(oldRequest)).toBe(true)
  })

  it('新代次的请求仍然有效（只有过期的那次被丢弃）', () => {
    const e = new MenuEpoch()
    const oldRequest = e.bump()
    const newRequest = e.bump()
    expect(e.isStale(oldRequest)).toBe(true)
    expect(e.isStale(newRequest)).toBe(false)
  })
})
