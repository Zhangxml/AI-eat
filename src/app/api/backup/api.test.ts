// 备份接口单测（Task 15）：GET 导出 / POST 导入，node 环境直接 import route handler 调用
// 数据目录经 process.env.AI_EAT_DATA_DIR 注入临时目录（store 每次调用时读 env，模块顶层默认值不受影响）
// Task 16 起本接口受守卫保护：PASSWORD 未设时放行（本文件不带 Cookie 直调）；若设 PASSWORD 须带会话 Cookie
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { GET, POST } from './route'
import { getRecipe, putRecipe } from '@/lib/recipe-store'
import type { Recipe } from '@/lib/recipe-types'

// 构造 GET 请求（守卫只读 Cookie 头；PASSWORD 未启用时不带 Cookie 亦可）
const getReq = () => new Request('http://x/api/backup')

// 合法完整菜谱夹具：与 recipe-store.test.ts / ai 测试同款形状，id 可过 strict schema
const baseRecipe: Recipe = {
  id: 'r-1730000000-ab12cd',
  name: '番茄炒蛋',
  category: '荤菜',
  servings: 2,
  difficulty: '简单',
  totalTimeMin: 20,
  tags: ['家常菜'],
  ingredients: [{ name: '番茄', amount: '2个' }],
  steps: ['番茄切块', '热锅下油炒蛋'],
  nutrition: { caloriesKcal: 180, proteinG: 8, fatG: 10, carbG: 12, estimated: true },
  source: 'ai',
  createdAt: '2020-01-01T00:00:00.000Z',
  updatedAt: '2020-01-01T00:00:00.000Z',
}

// 第二条夹具：不同 id/名称，用于「两条全导出」「一新一旧导入」场景
const otherRecipe: Recipe = {
  ...baseRecipe,
  id: 'r-1730000001-cd34ef',
  name: '清炒时蔬',
  source: 'manual',
}

// 构造带 JSON body 的 POST 请求（handler 只读 body）
const jsonReq = (body: unknown) =>
  new Request('http://x', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })

// 构造文本 body 的 POST 请求（测非法 JSON 路径）
const rawReq = (text: string) =>
  new Request('http://x', { method: 'POST', body: text, headers: { 'content-type': 'application/json' } })

describe('备份接口 /api/backup', () => {
  let dir: string

  beforeEach(async () => {
    dir = await fs.mkdtemp('/tmp/opencode/ai-eat-backup-')
    process.env.AI_EAT_DATA_DIR = dir
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
    delete process.env.AI_EAT_DATA_DIR
  })

  it('GET 导出：200 + exportedAt + 全部菜谱 + Content-Disposition 附件头', async () => {
    await putRecipe(baseRecipe)
    await putRecipe(otherRecipe)
    const res = await GET(getReq())
    expect(res.status).toBe(200)
    // 附件下载头：attachment + ai-eat-backup-<YYYYMMDD>.json
    expect(res.headers.get('Content-Disposition')).toMatch(
      /^attachment; filename=ai-eat-backup-\d{8}\.json$/,
    )
    const body = (await res.json()) as { exportedAt: string; recipes: Recipe[] }
    expect(typeof body.exportedAt).toBe('string')
    // exportedAt 可被 Date 解析（ISO 字符串）
    expect(new Date(body.exportedAt).toISOString()).toBe(body.exportedAt)
    expect(body.recipes).toHaveLength(2)
    expect(body.recipes.map(r => r.id)).toEqual(expect.arrayContaining([baseRecipe.id, otherRecipe.id]))
  })

  it('GET 空库导出：recipes 为空数组，头与 exportedAt 仍齐备', async () => {
    const res = await GET(getReq())
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Disposition')).toMatch(/^attachment; filename=ai-eat-backup-\d{8}\.json$/)
    const body = await res.json()
    expect(body.recipes).toEqual([])
    expect(typeof body.exportedAt).toBe('string')
  })

  it('POST 导入：新 id 入库、库中已存在同 id 跳过并报告 skippedIds', async () => {
    // 预置 existing 于库中；fresh 不在库中
    await putRecipe(baseRecipe)
    const fresh: Recipe = { ...otherRecipe, createdAt: '2021-06-01T00:00:00.000Z', updatedAt: '2021-06-01T00:00:00.000Z' }
    const res = await POST(jsonReq({ recipes: [baseRecipe, fresh] }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ imported: 1, skipped: 1 })
    expect(body.skippedIds).toEqual([baseRecipe.id])
    // 新 id 按原样入库：id 与时间戳均不被改写（putRecipe 语义）
    const stored = await getRecipe(fresh.id)
    expect(stored).toEqual(fresh)
  })

  it('POST 导入按原 id 与原时间戳写入（空库全量导入）', async () => {
    const res = await POST(jsonReq({ recipes: [baseRecipe, otherRecipe] }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ imported: 2, skipped: 0 })
    expect(body.skippedIds).toEqual([])
    expect(body.invalidIds).toEqual([])
    expect(await getRecipe(baseRecipe.id)).toEqual(baseRecipe)
    expect(await getRecipe(otherRecipe.id)).toEqual(otherRecipe)
  })

  it('POST 单条非法：跳过该条计入 invalidIds，其余条目照常导入', async () => {
    // 四条混合：合法新条 / 带 id 但 strict schema 不过（多余字段）/ 纯字符串（无 id，用 #序号 占位）/ 库中已存在
    // skipped 语义（裁定 2）：冲突与非法均属「跳过」，imported + skipped = 总条数；
    // skippedIds 与 invalidIds 细分跳过构成（skipped = skippedIds.length + invalidIds.length）
    await putRecipe(baseRecipe)
    const invalidWithId = { ...otherRecipe, extraField: '脏数据' }
    const res = await POST(jsonReq({ recipes: [otherRecipe, invalidWithId, 'oops', baseRecipe] }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ imported: 1, skipped: 3 })
    expect(body.skippedIds).toEqual([baseRecipe.id])
    // 非法条目逐条报告：带 id 的报原 id，取不到 id 的报 #数组序号
    expect(body.invalidIds).toEqual([otherRecipe.id, '#2'])
    // skipped = skippedIds.length + invalidIds.length（细分构成守恒）
    expect(body.skipped).toBe(body.skippedIds.length + body.invalidIds.length)
    // 合法条目不受非法条目影响，照常入库
    expect(await getRecipe(otherRecipe.id)).toEqual(otherRecipe)
  })

  it('POST 单条 schema 合法但 id 非法：putRecipe 抛错被捕获，计入 invalidIds，不 500', async () => {
    // 手改备份文件可能带穿越 id（schema 只约束 min(1) 拦不住）：store 层 putRecipe throw，
    // importOne 必须捕获单条异常计入 invalid 分支，其余条目照常导入（I-1 衔接面）
    // 数据目录改用本用例专属嵌套路径：'../evil' 的越界落点 = dir/evil.json，作用域封闭可断言
    const nested = path.join(dir, 'nested-store')
    process.env.AI_EAT_DATA_DIR = nested
    const evilId: Recipe = { ...otherRecipe, id: '../evil' }
    const res = await POST(jsonReq({ recipes: [evilId, baseRecipe] }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ imported: 1, skipped: 1 })
    expect(body.invalidIds).toEqual(['../evil'])
    // 合法条目不受影响（落在嵌套 store 目录）
    expect(await getRecipe(baseRecipe.id)).toEqual(baseRecipe)
    // 越界落点（dir/evil.json）没有文件
    await expect(fs.access(path.join(dir, 'evil.json'))).rejects.toThrow()
    // 嵌套 store 目录里只有合法条目一个文件
    expect((await fs.readdir(nested)).sort()).toEqual([`${baseRecipe.id}.json`])
  })

  it('POST 非法结构 → 400 + 中文 error（缺 recipes / recipes 非数组 / 非法 JSON）', async () => {
    // 缺 recipes 键
    const miss = await POST(jsonReq({ exportedAt: '2026-01-01T00:00:00.000Z' }))
    expect(miss.status).toBe(400)
    expect((await miss.json()).error).toBeTruthy()
    // recipes 不是数组
    const notArray = await POST(jsonReq({ recipes: 'nope' }))
    expect(notArray.status).toBe(400)
    expect((await notArray.json()).error).toBeTruthy()
    // body 不是合法 JSON
    const broken = await POST(rawReq('{oops'))
    expect(broken.status).toBe(400)
    expect((await broken.json()).error).toBeTruthy()
  })

  it('POST 顶层多余字段不 400（裁定 2：不用 strict 卡死整体，容忍手改/旧版本文件）', async () => {
    const res = await POST(jsonReq({ recipes: [otherRecipe], appVersion: '手改备注' }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ imported: 1 })
  })

  it('round trip：导出 → 清库 → 导入 → 全量恢复', async () => {
    await putRecipe(baseRecipe)
    await putRecipe(otherRecipe)
    const exportRes = await GET(getReq())
    const backupBody = (await exportRes.json()) as { recipes: Recipe[] }
    // 清库
    await fs.rm(dir, { recursive: true, force: true })
    // 导入导出的原 body
    const importRes = await POST(jsonReq(backupBody))
    expect(importRes.status).toBe(200)
    const body = await importRes.json()
    expect(body).toMatchObject({ imported: 2, skipped: 0 })
    expect(await getRecipe(baseRecipe.id)).toEqual(baseRecipe)
    expect(await getRecipe(otherRecipe.id)).toEqual(otherRecipe)
  })
})
