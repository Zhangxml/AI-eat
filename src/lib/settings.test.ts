// 全局设置 schema 单测：默认值、合并、未知键拒绝、版本恒为当前
import { describe, expect, it } from 'vitest'
import {
  SETTINGS_VERSION,
  defaultSettings,
  mergeSettings,
  validateSettings,
  validateSettingsPatch,
} from './settings'

describe('全局设置 schema', () => {
  it('默认值为 version 1 + style home', () => {
    expect(defaultSettings()).toEqual({ version: SETTINGS_VERSION, style: 'home' })
  })

  it('合法设置通过校验', () => {
    expect(validateSettings({ version: 1, style: 'creative' })).toEqual({ version: 1, style: 'creative' })
  })

  it('非法 style / 缺 version / 未知键 一律拒绝', () => {
    expect(validateSettings({ version: 1, style: 'exotic' })).toBeNull()
    expect(validateSettings({ style: 'home' })).toBeNull()
    expect(validateSettings({ version: 1, style: 'home', foo: 1 })).toBeNull()
  })

  it('PATCH 只接受 style，未知键拒绝（防拼写错误被静默忽略）', () => {
    expect(validateSettingsPatch({ style: 'creative' })).toEqual({ style: 'creative' })
    expect(validateSettingsPatch({ style: 'bad' })).toBeNull()
    expect(validateSettingsPatch({ stlye: 'creative' })).toBeNull()
    expect(validateSettingsPatch({ version: 2 })).toBeNull()
  })

  it('合并不覆盖未提供的字段，version 恒为当前', () => {
    const base = { version: 1, style: 'home' as const }
    expect(mergeSettings(base, { style: 'creative' })).toEqual({ version: 1, style: 'creative' })
    expect(mergeSettings(base, {})).toEqual({ version: 1, style: 'home' })
  })
})
