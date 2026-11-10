// 原子写的并发安全单测
// 背景（已复现的真缺陷）：原实现用固定 `${file}.tmp` 作临时名，两个并发写会互相覆盖同一临时文件——
// 实测 50 轮并发中 41 轮出现「一方报 ENOENT/500，但磁盘上是另一方内容」，
// 即状态码与真实结果不一致：失败方的修改被静默吞掉（用户看到 500，实际数据已被别人覆盖）。
// 修法：临时名带随机后缀（randomUUID），每个写手独占自己的临时文件。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { atomicWriteFile } from './atomic-write'

describe('atomicWriteFile 原子写', () => {
  let dir: string

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-eat-atomic-'))
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('写入后可读回内容', async () => {
    const file = path.join(dir, 'a.json')
    await atomicWriteFile(file, '{"v":1}')
    expect(await fs.readFile(file, 'utf8')).toBe('{"v":1}')
  })

  it('父目录不存在时自动创建（全新部署首次写）', async () => {
    const file = path.join(dir, 'nested', 'deep', 'a.json')
    await atomicWriteFile(file, 'x')
    expect(await fs.readFile(file, 'utf8')).toBe('x')
  })

  it('不残留 .tmp 文件', async () => {
    await atomicWriteFile(path.join(dir, 'a.json'), 'x')
    expect((await fs.readdir(dir)).filter(f => f.endsWith('.tmp'))).toEqual([])
  })

  it('两个并发写同一文件：两个都成功，最终内容是其中之一（不出现 ENOENT）', async () => {
    const file = path.join(dir, 'r.json')
    await fs.writeFile(file, '{"writer":"init"}', 'utf8')

    // 原实现（固定 tmp 名）在这里会稳定复现：一方 ENOENT、磁盘是另一方内容
    const results = await Promise.allSettled([
      atomicWriteFile(file, '{"writer":"A"}'),
      atomicWriteFile(file, '{"writer":"B"}'),
    ])

    const rejected = results.filter(r => r.status === 'rejected')
    expect(rejected.map(r => (r as PromiseRejectedResult).reason?.code)).toEqual([])

    const disk = JSON.parse(await fs.readFile(file, 'utf8')).writer
    expect(['A', 'B']).toContain(disk)
    // 最终内容必须是某一次完整写入，不能是拼接/空
    expect((await fs.readFile(file, 'utf8')).length).toBeGreaterThan(10)
  })

  it('50 轮并发写：零失败、每轮内容都是完整的一次写入', async () => {
    const file = path.join(dir, 'r.json')
    for (let i = 0; i < 50; i++) {
      await fs.writeFile(file, '{"writer":"init"}', 'utf8')
      const results = await Promise.allSettled([
        atomicWriteFile(file, '{"writer":"A"}'),
        atomicWriteFile(file, '{"writer":"B"}'),
      ])
      expect(results.every(r => r.status === 'fulfilled'), `第 ${i} 轮出现失败`).toBe(true)
      const raw = await fs.readFile(file, 'utf8')
      expect(JSON.parse(raw).writer, `第 ${i} 轮内容异常: ${raw}`).toMatch(/^[AB]$/)
    }
    expect((await fs.readdir(dir)).filter(f => f.endsWith('.tmp'))).toEqual([])
  })

  it('写入失败时抛错且清理临时文件（不把半成品留下）', async () => {
    const file = path.join(dir, 'a.json')
    // 用一个目录占住目标路径 → rename 会失败（EISDIR）
    await fs.mkdir(file)
    await expect(atomicWriteFile(file, 'x')).rejects.toThrow()
    // 目标仍为目录，且无 .tmp 残留
    expect((await fs.stat(file)).isDirectory()).toBe(true)
    expect((await fs.readdir(dir)).filter(f => f.endsWith('.tmp'))).toEqual([])
  })
})
