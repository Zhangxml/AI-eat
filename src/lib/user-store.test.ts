// 用户存储单测：users.json 的 CRUD、名字唯一、路径安全、容错
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  createUser,
  dataRoot,
  deleteUser,
  findUserByName,
  getUser,
  listUsers,
  multiUserEnabled,
  updateUser,
  usersDirFor,
  usersFilePath,
} from './user-store'

describe('user-store', () => {
  let root: string

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-eat-users-'))
    process.env.AI_EAT_DATA_DIR = path.join(root, 'recipes')
  })

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
    delete process.env.AI_EAT_DATA_DIR
  })

  it('dataRoot 取 AI_EAT_DATA_DIR 的父目录', () => {
    expect(dataRoot()).toBe(root)
    expect(usersFilePath()).toBe(path.join(root, 'users.json'))
  })

  it('无 users.json 时 multiUserEnabled=false 且列表为空（不崩）', async () => {
    expect(await multiUserEnabled()).toBe(false)
    expect(await listUsers()).toEqual([])
  })

  it('创建首个用户：自动成为 admin，写入文件后可读回', async () => {
    const u = await createUser({ name: '爸爸', passwordHash: 'scrypt$x' })
    expect(u.role).toBe('admin')
    expect(u.id).toMatch(/^u-[0-9a-f]{8}$/)
    expect(u.sessionVersion).toBe(1)
    expect(await multiUserEnabled()).toBe(true)
    expect((await listUsers()).map(x => x.name)).toEqual(['爸爸'])
    // 文件里存的是哈希串（本用例传入的就是一个哈希字面量），不是明文口令
    const raw = await fs.readFile(usersFilePath(), 'utf8')
    const onDisk = JSON.parse(raw)
    expect(onDisk.version).toBe(1)
    expect(onDisk.users[0].passwordHash).toBe('scrypt$x')
    expect(onDisk.users[0].role).toBe('admin')
  })

  it('后续创建的用户是 member', async () => {
    await createUser({ name: '爸爸', passwordHash: 'h1' })
    const m = await createUser({ name: '妈妈', passwordHash: 'h2' })
    expect(m.role).toBe('member')
  })

  it('名字唯一（大小写与首尾空白不敏感）', async () => {
    await createUser({ name: 'Dad', passwordHash: 'h1' })
    await expect(createUser({ name: 'dad', passwordHash: 'h2' })).rejects.toThrow(/已存在/)
    await expect(createUser({ name: '  DAD  ', passwordHash: 'h3' })).rejects.toThrow(/已存在/)
    expect(await findUserByName('DAD')).not.toBeNull()
    expect(await findUserByName('nobody')).toBeNull()
  })

  it('按 id 查询；非法 id 返回 null（路径安全）', async () => {
    const u = await createUser({ name: 'A', passwordHash: 'h' })
    expect((await getUser(u.id))?.name).toBe('A')
    for (const bad of ['../etc/passwd', 'u-../../x', 'a/b', '', 'u-ZZZZZZZZ']) {
      expect(await getUser(bad)).toBeNull()
    }
  })

  it('usersDirFor 拼出 users/<id>/recipes；非法 id 抛错', () => {
    expect(usersDirFor('u-a1b2c3d4')).toBe(path.join(root, 'users', 'u-a1b2c3d4', 'recipes'))
    expect(() => usersDirFor('../x')).toThrow()
  })

  it('更新用户：合并字段并刷新 updatedAt', async () => {
    const u = await createUser({ name: 'A', passwordHash: 'h' })
    const at = u.updatedAt
    await new Promise(r => setTimeout(r, 5))
    const next = await updateUser(u.id, { name: 'A2', disabled: true })
    expect(next.name).toBe('A2')
    expect(next.disabled).toBe(true)
    expect(next.passwordHash).toBe('h')
    expect(next.updatedAt).not.toBe(at)
    expect((await getUser(u.id))?.name).toBe('A2')
  })

  it('更新不存在的用户 → 抛错', async () => {
    await createUser({ name: 'A', passwordHash: 'h' })
    await expect(updateUser('u-deadbeef', { name: 'X' })).rejects.toThrow(/不存在/)
  })

  it('删除用户：从表里移除', async () => {
    const a = await createUser({ name: 'A', passwordHash: 'h' })
    const b = await createUser({ name: 'B', passwordHash: 'h' })
    await deleteUser(b.id)
    expect((await listUsers()).map(x => x.id)).toEqual([a.id])
  })

  it('禁止删除最后一个用户（否则会回落旧模式、等于关掉鉴权）', async () => {
    const only = await createUser({ name: '唯一', passwordHash: 'h' })
    await expect(deleteUser(only.id)).rejects.toThrow(/最后一个用户/)
    expect(await listUsers()).toHaveLength(1)
  })

  it('删除不存在的用户 → 抛错', async () => {
    await createUser({ name: 'A', passwordHash: 'h' })
    await expect(deleteUser('u-deadbeef')).rejects.toThrow(/不存在/)
  })

  it('users.json 损坏时按空表处理（不崩），且不覆盖原文件', async () => {
    await fs.writeFile(usersFilePath(), '{oops', 'utf8')
    expect(await listUsers()).toEqual([])
    expect(await multiUserEnabled()).toBe(false)
    expect(await fs.readFile(usersFilePath(), 'utf8')).toBe('{oops')
  })

  it('坏条目被跳过，其余照常读取', async () => {
    await fs.writeFile(
      usersFilePath(),
      JSON.stringify({
        version: 1,
        users: [
          // 合法条目：字段齐全（含时间戳）
          {
            id: 'u-11111111', name: '好', role: 'admin', passwordHash: 'h',
            sessionVersion: 1, disabled: false,
            createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
          },
          // 非法 id（含空格）
          {
            id: 'bad id', name: '坏', role: 'admin', passwordHash: 'h',
            sessionVersion: 1, disabled: false,
            createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
          },
          // 缺字段
          { nope: true },
        ],
      }),
      'utf8',
    )
    const list = await listUsers()
    expect(list.map(u => u.name)).toEqual(['好'])
  })
})
