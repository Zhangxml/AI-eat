// 买什么：重新点菜时的并发协作单测
// 覆盖：在途请求登记/全部取消、以及「已生成未入库」的计数与二次确认文案
import { describe, expect, it } from 'vitest'
import { DishAborts, buildRegenConfirmMessage, countUnsavedRecipes } from './dishes-regen'

describe('DishAborts 在途请求注册表', () => {
  it('登记后可查到菜名；delete 后移出', () => {
    const reg = new DishAborts()
    reg.set('番茄炒蛋', new AbortController())
    expect(reg.names()).toEqual(['番茄炒蛋'])
    reg.delete('番茄炒蛋')
    expect(reg.names()).toEqual([])
  })

  it('abortAll 取消全部在途请求并清空登记表，返回被取消的菜名', () => {
    const reg = new DishAborts()
    const a = new AbortController()
    const b = new AbortController()
    reg.set('番茄炒蛋', a)
    reg.set('青椒肉丝', b)

    const aborted = reg.abortAll()

    expect(a.signal.aborted).toBe(true)
    expect(b.signal.aborted).toBe(true)
    expect(aborted.sort()).toEqual(['番茄炒蛋', '青椒肉丝'].sort())
    expect(reg.names()).toEqual([])
  })

  it('abortAll 在空表上是 no-op（不抛错，返回空数组）', () => {
    const reg = new DishAborts()
    expect(reg.abortAll()).toEqual([])
  })

  it('已结束（delete 过）的请求不会被 abortAll 再次取消', () => {
    const reg = new DishAborts()
    const done = new AbortController()
    reg.set('番茄炒蛋', done)
    reg.delete('番茄炒蛋')

    expect(reg.abortAll()).toEqual([])
    expect(done.signal.aborted).toBe(false)
  })
})

describe('countUnsavedRecipes 清空前会丢几道', () => {
  it('只统计「已生成且未入库」的道数', () => {
    const states = {
      已入库菜: { phase: 'ready' as const, recipe: {} },
      未入库菜: { phase: 'ready' as const, recipe: {} },
      生成中菜: { phase: 'generating' as const },
      未生成菜: { phase: 'idle' as const },
    }
    const saved = { 已入库菜: true }
    expect(countUnsavedRecipes(states, saved)).toBe(1)
  })

  it('已生成但 recipe 缺失（异常态）不计入', () => {
    expect(countUnsavedRecipes({ 异常菜: { phase: 'ready' } }, {})).toBe(0)
  })

  it('空状态返回 0', () => {
    expect(countUnsavedRecipes({}, {})).toBe(0)
  })
})

describe('buildRegenConfirmMessage 二次确认文案', () => {
  it('有未入库菜谱时给出含数量的中文提示', () => {
    const msg = buildRegenConfirmMessage(2)
    expect(msg).toContain('清空')
    expect(msg).toContain('2 道')
    expect(msg).toContain('继续')
  })

  it('没有未入库菜谱时不打扰用户（返回 null）', () => {
    expect(buildRegenConfirmMessage(0)).toBeNull()
    expect(buildRegenConfirmMessage(-1)).toBeNull()
  })
})
