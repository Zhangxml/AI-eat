// 全局设置 schema 单测：默认值、合并、未知键拒绝、版本恒为当前
import { describe, expect, it } from 'vitest'
import {
  SETTINGS_VERSION,
  defaultSettings,
  mergeSettings,
  parseSettingsFile,
  validateSettingsPatch,
} from './settings'

describe('全局设置 schema', () => {
  it('默认值为 version 1 + style home', () => {
    expect(defaultSettings()).toEqual({ version: SETTINGS_VERSION, style: 'home' })
  })

  it('合法设置原样解析', () => {
    expect(parseSettingsFile({ version: 1, style: 'creative' })).toEqual({ version: 1, style: 'creative' })
  })

  it('读取宽松：缺 version / 未知键 / 未来版本多字段都不丢弃已设置的值', () => {
    // 手写文件漏了 version
    expect(parseSettingsFile({ style: 'creative' }).style).toBe('creative')
    // 旧版本读到未来版本写的文件（多出未知字段）
    expect(parseSettingsFile({ version: 2, style: 'creative', servings: 4 }).style).toBe('creative')
    // 文件里有垃圾键
    expect(parseSettingsFile({ version: 1, style: 'creative', foo: 1 }).style).toBe('creative')
  })

  it('读取宽松：非法 style / 非对象 / 数组 → 该字段回落默认 home', () => {
    expect(parseSettingsFile({ version: 1, style: 'exotic' })).toEqual({ version: 1, style: 'home' })
    expect(parseSettingsFile(null)).toEqual({ version: 1, style: 'home' })
    expect(parseSettingsFile([1, 2])).toEqual({ version: 1, style: 'home' })
    expect(parseSettingsFile('oops')).toEqual({ version: 1, style: 'home' })
  })

  it('读取时 version 恒为当前版本（不采信文件里的值）', () => {
    expect(parseSettingsFile({ version: 99, style: 'creative' }).version).toBe(SETTINGS_VERSION)
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
