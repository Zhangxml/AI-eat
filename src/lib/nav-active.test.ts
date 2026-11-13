// 底部导航高亮判定单测
// 覆盖：'/' 精确匹配、子路径前缀匹配、隐藏页归属「设置」、replace 判定
import { describe, expect, it } from 'vitest'
import { isHiddenSettingsPage, isNavActive } from './nav-active'

describe('isNavActive 导航项高亮', () => {
  it("'/' 只在首页精确匹配（否则全站路径都以 / 开头会导致四个 tab 全亮）", () => {
    expect(isNavActive('/', '/')).toBe(true)
    expect(isNavActive('/dishes', '/')).toBe(false)
    expect(isNavActive('/recipes/abc', '/')).toBe(false)
  })

  it('普通路由精确匹配', () => {
    expect(isNavActive('/dishes', '/dishes')).toBe(true)
    expect(isNavActive('/settings', '/settings')).toBe(true)
    expect(isNavActive('/dishes', '/settings')).toBe(false)
  })

  it('子路径点亮所属 tab（/recipes/[id] → 菜谱库）', () => {
    expect(isNavActive('/recipes/r-123', '/recipes')).toBe(true)
    expect(isNavActive('/recipes/new', '/recipes')).toBe(true)
  })

  it('隐藏页 /access-logs 归属「设置」：只有设置高亮，其余三项都不亮', () => {
    expect(isNavActive('/access-logs', '/settings')).toBe(true)
    expect(isNavActive('/access-logs', '/')).toBe(false)
    expect(isNavActive('/access-logs', '/dishes')).toBe(false)
    expect(isNavActive('/access-logs', '/recipes')).toBe(false)
  })

  it('前缀匹配不会误伤同前缀的其它路由（/recipes-x 不属于 /recipes）', () => {
    // 这条锁的是 `startsWith(href + '/')` 里那个斜杠：若改成 `startsWith(href)` 就会误亮
    expect(isNavActive('/recipes-archive', '/recipes')).toBe(false)
    expect(isNavActive('/settings-x', '/settings')).toBe(false)
  })

  it("href='/' 时任何非首页路径都不亮（靠 startsWith('//') 天然成立）", () => {
    for (const p of ['/dishes', '/recipes', '/settings', '/access-logs', '/recipes/new']) {
      expect(isNavActive(p, '/')).toBe(false)
    }
  })
})

describe('isHiddenSettingsPage 隐藏页判定', () => {
  it('/access-logs 是隐藏页（离开时需 replace，避免写进历史栈）', () => {
    expect(isHiddenSettingsPage('/access-logs')).toBe(true)
  })

  it('普通页面不是隐藏页', () => {
    for (const p of ['/', '/dishes', '/recipes', '/settings', '/recipes/new']) {
      expect(isHiddenSettingsPage(p)).toBe(false)
    }
  })

  it('带尾斜杠的 /access-logs/ 不算（Next 会 308 重定向到无斜杠版本）', () => {
    expect(isHiddenSettingsPage('/access-logs/')).toBe(false)
  })
})
