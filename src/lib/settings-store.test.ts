// 设置存储单测（多用户改造后）：按用户读写、容错、原子写
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { LEGACY_OWNER_ID } from './auth-constants'
import { readSettings, settingsFilePath, writeSettings } from './settings-store'

describe('设置文件存储', () => {
  let root: string

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-eat-settings-'))
    process.env.AI_EAT_DATA_DIR = path.join(root, 'recipes')
  })

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
    delete process.env.AI_EAT_DATA_DIR
  })

  it('旧模式（不传 userId）：读写 data/settings.json', async () => {
    expect(settingsFilePath()).toBe(path.join(root, 'settings.json'))
    expect(await readSettings()).toEqual({ version: 1, style: 'home' })
    await writeSettings({ version: 1, style: 'creative' })
    expect(await readSettings()).toEqual({ version: 1, style: 'creative' })
  })

  it('按用户读写：落在 data/users/<uid>/settings.json，互不影响', async () => {
    const a = 'u-11111111'
    const b = 'u-22222222'
    await writeSettings({ version: 1, style: 'creative' }, a)
    expect(await readSettings(a)).toEqual({ version: 1, style: 'creative' })
    // 另一个用户仍是默认
    expect(await readSettings(b)).toEqual({ version: 1, style: 'home' })
    // 旧模式不受影响
    expect(await readSettings()).toEqual({ version: 1, style: 'home' })
    expect(settingsFilePath(a)).toBe(path.join(root, 'users', a, 'settings.json'))
  })

  it('LEGACY_OWNER 等价于不传 userId（回落全局）', async () => {
    await writeSettings({ version: 1, style: 'creative' }, LEGACY_OWNER_ID)
    expect(await readSettings()).toEqual({ version: 1, style: 'creative' })
  })

  it('文件损坏/不存在 → 默认值，不抛错', async () => {
    await fs.mkdir(root, { recursive: true })
    await fs.writeFile(path.join(root, 'settings.json'), '{oops', 'utf8')
    expect(await readSettings()).toEqual({ version: 1, style: 'home' })
  })

  it('目录不存在时写入自动创建，且不残留 .tmp', async () => {
    const uid = 'u-33333333'
    await writeSettings({ version: 1, style: 'creative' }, uid)
    expect(await readSettings(uid)).toEqual({ version: 1, style: 'creative' })
    const dir = path.join(root, 'users', uid)
    expect((await fs.readdir(dir)).filter(f => f.endsWith('.tmp'))).toEqual([])
  })

  it('写入前严格校验：非法值抛错且不落盘', async () => {
    await expect(
      writeSettings({ version: 1, style: 'bogus' } as never, 'u-44444444'),
    ).rejects.toThrow()
    expect(await readSettings('u-44444444')).toEqual({ version: 1, style: 'home' })
  })
})
