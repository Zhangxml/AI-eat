// 开放重定向防护单测：反斜杠、协议相对、绝对 URL、javascript: 等变体都必须回落首页
import { describe, expect, it } from 'vitest'
import { safeNextPath } from './safe-next-path'

const ORIGIN = 'http://localhost:8890'

describe('safeNextPath 登录后回跳目标', () => {
  it('正常站内路径原样保留', () => {
    expect(safeNextPath('/settings', ORIGIN)).toBe('/settings')
    expect(safeNextPath('/recipes/r-123', ORIGIN)).toBe('/recipes/r-123')
    expect(safeNextPath('/recipes?tag=家常菜&q=鱼', ORIGIN)).toBe('/recipes?tag=%E5%AE%B6%E5%B8%B8%E8%8F%9C&q=%E9%B1%BC')
  })

  it('缺省/空串 → 首页', () => {
    expect(safeNextPath(null, ORIGIN)).toBe('/')
    expect(safeNextPath('', ORIGIN)).toBe('/')
  })

  it('协议相对 //evil.com → 首页', () => {
    expect(safeNextPath('//evil.com', ORIGIN)).toBe('/')
    expect(safeNextPath('//evil.com/x', ORIGIN)).toBe('/')
  })

  it('反斜杠变体 → 首页（WHATWG 下 \\ 等价于 /）', () => {
    // 注意用 String.raw：普通字符串里的 \\ 会被转义成单个 \，测不到真实的反斜杠
    expect(safeNextPath(String.raw`/\evil.com`, ORIGIN)).toBe('/')
    expect(safeNextPath(String.raw`\evil.com`, ORIGIN)).toBe('/')
    expect(safeNextPath(String.raw`/\/evil.com`, ORIGIN)).toBe('/')
  })

  it('编码形式的反斜杠（%5C）也拒绝', () => {
    expect(safeNextPath('/%5Cevil.com', ORIGIN)).toBe('/')
    expect(safeNextPath('%5Cevil.com', ORIGIN)).toBe('/')
  })

  it('绝对 URL 到其它源 → 首页', () => {
    expect(safeNextPath('https://evil.com', ORIGIN)).toBe('/')
    expect(safeNextPath('http://localhost:9999/x', ORIGIN)).toBe('/')
  })

  it('javascript: / data: 等危险协议 → 首页', () => {
    expect(safeNextPath('javascript:alert(1)', ORIGIN)).toBe('/')
    expect(safeNextPath('data:text/html,x', ORIGIN)).toBe('/')
  })

  it('回跳自身（/login）→ 首页，避免登录后原地打转', () => {
    expect(safeNextPath('/login', ORIGIN)).toBe('/')
    expect(safeNextPath('/login?next=/settings', ORIGIN)).toBe('/')
  })

  it('同源的绝对 URL 允许（保留 path+search）', () => {
    expect(safeNextPath('http://localhost:8890/settings?a=1', ORIGIN)).toBe('/settings?a=1')
  })
})

describe('safeNextPath：点段归一化（开放重定向变体）', () => {
  it('`/..//evil.com` 归一化成协议相对路径 → 首页', () => {
    // new URL 会把 /..//evil.com 归一化为 //evil.com（origin 仍同源），
    // 只比较 origin 会放行，最终 window.location.replace('//evil.com') 跳到站外
    for (const raw of [
      '/..//evil.com',
      '/a/..//evil.com',
      '/..///evil.com',
      '/%2e%2e//evil.com',
      '/%2e%2e//evil.com?x=1',
      '/a/../..//evil.com',
      '/./..//evil.com',
    ]) {
      expect(safeNextPath(raw, ORIGIN), raw).toBe('/')
    }
  })

  it('正常点段路径仍保留（/a/../settings → /settings）', () => {
    expect(safeNextPath('/a/../settings', ORIGIN)).toBe('/settings')
  })
})
