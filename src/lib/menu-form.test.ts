// 买什么表单校验的单测：人数/天数/偏好三字段的前置校验，口径必须与服务端一致
// （前端先拦一次避免用户白等一次往返；服务端仍独立校验，不依赖前端）
import { describe, expect, it } from 'vitest'
import { MAX_DAYS, MAX_PEOPLE, MAX_TEXT_CHARS, validateMenuForm } from './menu-form'

describe('validateMenuForm', () => {
  it('合法输入：返回规范化后的人数/天数/偏好（偏好 trim）', () => {
    expect(validateMenuForm({ peopleInput: '3', daysInput: '7', preference: '  清淡  ' })).toEqual({
      ok: true,
      people: 3,
      days: 7,
      preference: '清淡',
    })
  })

  it('天数缺省为空串时按 1 天处理（与「不填就是买一餐」一致）', () => {
    expect(validateMenuForm({ peopleInput: '2', daysInput: '', preference: '' })).toEqual({
      ok: true,
      people: 2,
      days: 1,
      preference: '',
    })
  })

  it('偏好为空时返回空串，不携带该字段由调用方决定', () => {
    const r = validateMenuForm({ peopleInput: '2', daysInput: '1', preference: '   ' })
    expect(r.ok && r.preference).toBe('')
  })

  it('人数非整数 / 小于 1 / 超过上限 → 中文行内错误', () => {
    for (const peopleInput of ['0', '-1', '2.5', 'abc', '', '51']) {
      const r = validateMenuForm({ peopleInput, daysInput: '1', preference: '' })
      expect(r.ok, `people=${peopleInput}`).toBe(false)
      if (!r.ok) expect(r.error).toContain('人数')
    }
    expect(MAX_PEOPLE).toBe(50)
  })

  it('天数 1~7 边界通过，0 / 8 / 小数 / 非数字 → 中文行内错误', () => {
    expect(validateMenuForm({ peopleInput: '2', daysInput: '1', preference: '' }).ok).toBe(true)
    expect(validateMenuForm({ peopleInput: '2', daysInput: '7', preference: '' }).ok).toBe(true)
    for (const daysInput of ['0', '8', '100', '1.5', 'abc', '-1']) {
      const r = validateMenuForm({ peopleInput: '2', daysInput, preference: '' })
      expect(r.ok, `days=${daysInput}`).toBe(false)
      if (!r.ok) expect(r.error).toContain('天')
    }
    expect(MAX_DAYS).toBe(7)
  })

  it('偏好超过上限 → 中文行内错误', () => {
    const r = validateMenuForm({
      peopleInput: '2',
      daysInput: '1',
      preference: 'x'.repeat(MAX_TEXT_CHARS + 1),
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('口味偏好')
  })

  it('人数非法优先于天数报错（一次只提示一个，避免堆叠）', () => {
    const r = validateMenuForm({ peopleInput: '0', daysInput: '99', preference: '' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('人数')
  })
})
