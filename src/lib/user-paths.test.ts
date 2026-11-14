// 按用户解析路径的单测：多用户模式下绝不能回落到全局目录（跨用户泄露的第一道防线）
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { LEGACY_OWNER_ID } from './auth-constants'
import { recipesDirFor, settingsPathFor } from './user-paths'

describe('按用户解析数据路径', () => {
  let root: string

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-eat-paths-'))
    process.env.AI_EAT_DATA_DIR = path.join(root, 'recipes')
  })

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
    delete process.env.AI_EAT_DATA_DIR
  })

  it('旧模式（LEGACY_OWNER）：用全局 data/recipes 与 data/settings.json', () => {
    expect(recipesDirFor(LEGACY_OWNER_ID)).toBe(path.join(root, 'recipes'))
    expect(settingsPathFor(LEGACY_OWNER_ID)).toBe(path.join(root, 'settings.json'))
  })

  it('真实用户：落在 data/users/<uid>/{recipes,settings.json}', () => {
    expect(recipesDirFor('u-a1b2c3d4')).toBe(path.join(root, 'users', 'u-a1b2c3d4', 'recipes'))
    expect(settingsPathFor('u-a1b2c3d4')).toBe(path.join(root, 'users', 'u-a1b2c3d4', 'settings.json'))
  })

  it('两个不同用户解析到不同目录（隔离的前提）', () => {
    expect(recipesDirFor('u-11111111')).not.toBe(recipesDirFor('u-22222222'))
    expect(settingsPathFor('u-11111111')).not.toBe(settingsPathFor('u-22222222'))
  })

  it('非法 id 直接抛错（防目录穿越）', () => {
    for (const bad of ['../x', 'u-../../etc', '', 'u-ZZZZZZZZ', 'owner']) {
      expect(() => recipesDirFor(bad)).toThrow()
      expect(() => settingsPathFor(bad)).toThrow()
    }
  })

  it('真实用户路径绝不等于旧全局目录', () => {
    expect(recipesDirFor('u-a1b2c3d4')).not.toBe(path.join(root, 'recipes'))
  })
})
