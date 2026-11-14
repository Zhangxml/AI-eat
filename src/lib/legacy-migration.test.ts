// 旧数据接管（建号时自动迁移）单测
// 关键约束：复制→校验→删源；条数不一致则中止且不删源；幂等（已有数据不重复搬）
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { adoptLegacyData } from './legacy-migration'

describe('adoptLegacyData 建号时接管旧数据', () => {
  let root: string

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-eat-adopt-'))
    process.env.AI_EAT_DATA_DIR = path.join(root, 'recipes')
  })

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
    delete process.env.AI_EAT_DATA_DIR
  })

  const write = async (rel: string, content: string) => {
    const f = path.join(root, rel)
    await fs.mkdir(path.dirname(f), { recursive: true })
    await fs.writeFile(f, content, 'utf8')
  }
  const exists = async (rel: string) =>
    fs.access(path.join(root, rel)).then(() => true).catch(() => false)

  it('把 data/recipes 与 settings.json 搬进 users/<uid>/，并在校验后删除源', async () => {
    await write('recipes/r-1.json', '{"name":"A"}')
    await write('recipes/r-2.json', '{"name":"B"}')
    await write('settings.json', '{"version":1,"style":"creative"}')

    const r = await adoptLegacyData('u-11111111')
    expect(r.migrated).toBe(2)
    expect(await exists('users/u-11111111/recipes/r-1.json')).toBe(true)
    expect(await exists('users/u-11111111/recipes/r-2.json')).toBe(true)
    expect(await fs.readFile(path.join(root, 'users/u-11111111/settings.json'), 'utf8'))
      .toContain('creative')
    // 源已删
    expect(await exists('recipes/r-1.json')).toBe(false)
    expect(await exists('settings.json')).toBe(false)
  })

  it('没有旧数据 → 不迁移（migrated=0），也不报错', async () => {
    const r = await adoptLegacyData('u-11111111')
    expect(r.migrated).toBe(0)
  })

  it('幂等：目标已有数据时不再搬（避免重复/覆盖）', async () => {
    await write('users/u-11111111/recipes/r-9.json', '{"name":"existing"}')
    await write('recipes/r-1.json', '{"name":"A"}')
    const r = await adoptLegacyData('u-11111111')
    expect(r.migrated).toBe(0)
    expect(await exists('users/u-11111111/recipes/r-1.json')).toBe(false)
    // 源保留（没搬就不该删）
    expect(await exists('recipes/r-1.json')).toBe(true)
  })

  it('非法 uid 抛错（防目录穿越），且不动数据', async () => {
    await write('recipes/r-1.json', '{}')
    await expect(adoptLegacyData('../evil')).rejects.toThrow()
    expect(await exists('recipes/r-1.json')).toBe(true)
  })

  it('settings.json 不存在时给该用户写默认设置（保证后续读取稳定）', async () => {
    await write('recipes/r-1.json', '{}')
    await adoptLegacyData('u-22222222')
    const s = JSON.parse(await fs.readFile(path.join(root, 'users/u-22222222/settings.json'), 'utf8'))
    expect(s).toEqual({ version: 1, style: 'home' })
  })
})
