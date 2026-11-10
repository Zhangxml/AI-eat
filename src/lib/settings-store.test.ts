// 设置文件存储单测：容错回落、原子写、目录自动创建、损坏文件不崩
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import os from 'node:os'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { readSettings, writeSettings, settingsFilePath } from './settings-store'

describe('设置文件存储', () => {
  let dir: string

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-eat-settings-'))
    process.env.AI_EAT_DATA_DIR = `${dir}/recipes`
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
    delete process.env.AI_EAT_DATA_DIR
  })

  it('文件不存在 → 返回默认设置（不抛错）', async () => {
    expect(await readSettings()).toEqual({ version: 1, style: 'home' })
  })

  it('写入后可读回，且落在 data/settings.json（与 recipes 同级）', async () => {
    await writeSettings({ version: 1, style: 'creative' })
    expect(await readSettings()).toEqual({ version: 1, style: 'creative' })
    // 路径应在 AI_EAT_DATA_DIR 的父目录下
    expect(settingsFilePath()).toBe(path.join(dir, 'settings.json'))
  })

  it('目录不存在时写入会自动创建（首次使用）', async () => {
    const fresh = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-eat-settings-fresh-'))
    process.env.AI_EAT_DATA_DIR = `${fresh}/data/recipes`
    try {
      await writeSettings({ version: 1, style: 'creative' })
      expect(await readSettings()).toEqual({ version: 1, style: 'creative' })
    } finally {
      await fs.rm(fresh, { recursive: true, force: true })
    }
  })

  it('损坏的 JSON / 非法字段 → 回落默认（不崩）', async () => {
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'settings.json'), '{oops', 'utf8')
    expect(await readSettings()).toEqual({ version: 1, style: 'home' })

    await fs.writeFile(path.join(dir, 'settings.json'), JSON.stringify({ version: 1, style: 'exotic' }), 'utf8')
    expect(await readSettings()).toEqual({ version: 1, style: 'home' })
  })

  it('原子写：目录内不残留 .tmp 文件', async () => {
    await writeSettings({ version: 1, style: 'creative' })
    expect((await fs.readdir(dir)).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })
})
