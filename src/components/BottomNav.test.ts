// 底部导航项数据的最小单测：约束导航结构不被无意改动
import { describe, expect, it } from 'vitest'
import { NAV_ITEMS } from './BottomNav'

describe('底部导航', () => {
  it('包含且仅包含四个入口（顺序：问问AI / 买什么 / 菜谱库 / 设置）', () => {
    expect(NAV_ITEMS.map(i => i.href)).toEqual(['/', '/dishes', '/recipes', '/settings'])
    expect(NAV_ITEMS.every(i => i.label.length > 0)).toBe(true)
  })
})
