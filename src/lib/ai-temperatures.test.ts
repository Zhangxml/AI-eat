import { describe, expect, it } from 'vitest'
import { clampTemperature, DEFAULT_TEMPERATURES, resolveTemperature } from './ai-temperatures'

describe('AI 温度分层', () => {
  it('四个场景使用约定默认值', () => {
    expect(DEFAULT_TEMPERATURES).toEqual({ chat: 0.7, menu: 0.8, recipe: 0.7, nutrition: 0.5 })
    expect(resolveTemperature('chat', {} as NodeJS.ProcessEnv)).toBe(0.7)
    expect(resolveTemperature('menu', {} as NodeJS.ProcessEnv)).toBe(0.8)
    expect(resolveTemperature('recipe', {} as NodeJS.ProcessEnv)).toBe(0.7)
    expect(resolveTemperature('nutrition', {} as NodeJS.ProcessEnv)).toBe(0.5)
  })

  it('环境变量可覆盖对应场景，空串/非法值回落默认', () => {
    expect(resolveTemperature('menu', { AI_TEMP_MENU: '0.93' } as unknown as NodeJS.ProcessEnv)).toBe(0.93)
    expect(resolveTemperature('recipe', { AI_TEMP_RECIPE: '' } as unknown as NodeJS.ProcessEnv)).toBe(0.7)
    expect(resolveTemperature('nutrition', { AI_TEMP_NUTRITION: 'not-a-number' } as unknown as NodeJS.ProcessEnv)).toBe(0.5)
  })

  it('温度统一 clamp 到 [0,1]，兼容 DeepSeek/GLM 共同范围', () => {
    expect(clampTemperature(-0.2)).toBe(0)
    expect(clampTemperature(1.8)).toBe(1)
    expect(resolveTemperature('chat', { AI_TEMP_CHAT: '-1' } as unknown as NodeJS.ProcessEnv)).toBe(0)
    expect(resolveTemperature('chat', { AI_TEMP_CHAT: '2' } as unknown as NodeJS.ProcessEnv)).toBe(1)
  })
})
