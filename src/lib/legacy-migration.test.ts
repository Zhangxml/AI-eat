// 旧数据接管（建号时自动迁移）单测
// 关键约束：复制→校验→删源；条数不一致则中止且不删源；按文件补齐（半迁移可重试）；
// 配置误指（data 根 / 用户私有目录）必须拒绝且不动任何文件。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { adoptLegacyData } from './legacy-migration'

describe('adoptLegacyData 建号时接管旧数据', () => {
  let root: string
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-eat-adopt-'))
    process.env.AI_EAT_DATA_DIR = path.join(root, 'recipes')
  })

  afterEach(async () => {
    // 部分用例会 chmod 目录，先恢复权限再删，避免清理失败
    for (const rel of ['', 'recipes', 'users']) {
      await fs.chmod(path.join(root, rel), 0o755).catch(() => {})
    }
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
    // 完成标记
    expect(await exists('users/u-11111111/.legacy-adopted')).toBe(true)
  })

  it('没有旧数据 → 不迁移（migrated=0），也不报错', async () => {
    const r = await adoptLegacyData('u-11111111')
    expect(r.migrated).toBe(0)
  })

  it('按文件补齐：目标已有部分文件（上次复制失败）→ 补齐剩余的，不动已有文件', async () => {
    // 模拟半迁移：上次只复制成功了 r-1
    await write('users/u-11111111/recipes/r-1.json', '{"name":"A"}')
    await write('recipes/r-1.json', '{"name":"A"}')
    await write('recipes/r-2.json', '{"name":"B"}')
    await write('recipes/r-3.json', '{"name":"C"}')

    const r = await adoptLegacyData('u-11111111')
    expect(r.migrated).toBe(2) // 只补 r-2、r-3
    expect(await exists('users/u-11111111/recipes/r-2.json')).toBe(true)
    expect(await exists('users/u-11111111/recipes/r-3.json')).toBe(true)
    // 源已全部删除
    expect(await exists('recipes/r-2.json')).toBe(false)
    expect(await exists('recipes/r-3.json')).toBe(false)
  })

  it('已有完成标记 → 短路（之后往旧目录扔文件也不会再搬，避免误覆盖）', async () => {
    await write('recipes/r-1.json', '{"name":"A"}')
    await adoptLegacyData('u-11111111')
    // 接管完成后又出现一个旧文件：不应再处理
    await write('recipes/r-2.json', '{"name":"B"}')
    const r = await adoptLegacyData('u-11111111')
    expect(r.migrated).toBe(0)
    expect(await exists('recipes/r-2.json')).toBe(true)
    expect(await exists('users/u-11111111/recipes/r-2.json')).toBe(false)
  })

  it('非法 uid 抛错（防目录穿越），且不动数据', async () => {
    await write('recipes/r-1.json', '{}')
    await expect(adoptLegacyData('../evil')).rejects.toThrow()
    expect(await exists('recipes/r-1.json')).toBe(true)
  })

  it('自定义目录名（非 recipes）也能正常接管（AI_EAT_DATA_DIR 只约定「菜谱库目录」）', async () => {
    process.env.AI_EAT_DATA_DIR = path.join(root, 'mydishes')
    await write('mydishes/r-1.json', '{"name":"A"}')
    const r = await adoptLegacyData('u-11111111')
    expect(r.migrated).toBe(1)
    expect(await exists('users/u-11111111/recipes/r-1.json')).toBe(true)
    expect(await exists('mydishes/r-1.json')).toBe(false)
  })

  it('data/recipes 是指向 data 根的符号链接 → 同样拒绝（realpath 后再判断）', async () => {
    await fs.mkdir(path.join(root, 'users'), { recursive: true })
    await write('users.json', '{"version":1,"users":[]}')
    // recipes -> . （解析后就是 data 根，里面有 users.json）
    await fs.symlink(root, path.join(root, 'recipes'))
    await expect(adoptLegacyData('u-11111111')).rejects.toThrow(/配置错误/)
    expect(await exists('users.json')).toBe(true)
  })

  it('AI_EAT_DATA_DIR 指向 data 根 → 拒绝，且不删 users.json', async () => {
    await fs.mkdir(path.join(root, 'users'), { recursive: true })
    await write('users.json', '{"version":1,"users":[]}')
    process.env.AI_EAT_DATA_DIR = root // 误配：指向 data 根
    await expect(adoptLegacyData('u-11111111')).rejects.toThrow(/配置错误/)
    expect(await exists('users.json')).toBe(true)
  })

  it('AI_EAT_DATA_DIR 指向某个用户的私有目录 → 拒绝，不搬走别人的库', async () => {
    process.env.AI_EAT_DATA_DIR = path.join(root, 'users', 'u-22222222', 'recipes')
    await write('users/u-22222222/recipes/keep.json', '{"name":"别人的"}')
    await expect(adoptLegacyData('u-11111111')).rejects.toThrow(/配置错误/)
    expect(await exists('users/u-22222222/recipes/keep.json')).toBe(true)
  })

  it('源目录不可读（EACCES）→ 上抛，不能当成「没有旧数据」静默成功', async () => {
    if (isRoot) return // root 不受权限位限制，跳过
    await write('recipes/r-1.json', '{}')
    await fs.chmod(path.join(root, 'recipes'), 0o000)
    await expect(adoptLegacyData('u-11111111')).rejects.toThrow()
  })

  it('settings 复制成功但删源失败 → 目标保留真实设置，不被默认值覆盖', async () => {
    if (isRoot) return
    await write('recipes/r-1.json', '{}')
    await write('settings.json', '{"version":1,"style":"creative"}')
    // 先建好目标目录（否则 data 根变只读后连 users/ 都建不出来）
    await fs.mkdir(path.join(root, 'users', 'u-11111111', 'recipes'), { recursive: true })
    // data 根设为只读：copyFile 到 users/<uid>/ 仍可写，但 rm(settings.json) 会失败
    await fs.chmod(root, 0o500)
    const r = await adoptLegacyData('u-11111111')
    expect(r.wroteDefaultSettings).toBe(false)
    expect(await fs.readFile(path.join(root, 'users/u-11111111/settings.json'), 'utf8'))
      .toContain('creative')
    await fs.chmod(root, 0o755)
    // 旧文件残留，但不影响已接管的结果
    expect(await exists('settings.json')).toBe(true)
  })

  it('settings.json 不存在时给该用户写默认设置（保证后续读取稳定）', async () => {
    await write('recipes/r-1.json', '{}')
    await adoptLegacyData('u-22222222')
    const s = JSON.parse(await fs.readFile(path.join(root, 'users/u-22222222/settings.json'), 'utf8'))
    expect(s).toEqual({ version: 1, style: 'home' })
  })
})
