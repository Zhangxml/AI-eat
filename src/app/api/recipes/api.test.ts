// 菜谱库 REST API 单测：直接 import route handler 函数调用（node 环境，无 HTTP 服务器）
// 数据目录经 process.env.AI_EAT_DATA_DIR 注入临时目录（store 每次调用时读 env，模块顶层默认值不受影响）
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { GET as listR, POST as createR } from './route'
import { GET as getR, PUT as putR, DELETE as delR } from './[id]/route'
import type { DraftRecipe } from '@/lib/recipe-types'

// 合法草稿：与 recipe-store.test.ts 保持一致
const goodDraft: DraftRecipe = {
  name: '番茄炒蛋', servings: 2, difficulty: '简单', totalTimeMin: 20,
  tags: ['家常菜'], ingredients: [{ name: '番茄', amount: '2个' }],
  steps: ['番茄切块'], source: 'ai',
}

// 构造带 JSON body 的请求（handler 只读 body，不关心 method）
const json = (body: unknown) =>
  new Request('http://x', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })

// Next 15 动态路由 ctx：params 为 Promise
const ctxOf = (id: string) => ({ params: Promise.resolve({ id }) })

describe('菜谱库 REST API', () => {
  let dir: string

  beforeEach(async () => {
    dir = await fs.mkdtemp('/tmp/opencode/ai-eat-api-')
    process.env.AI_EAT_DATA_DIR = dir
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
    delete process.env.AI_EAT_DATA_DIR
  })

  it('POST 创建并 GET 列表拿到', async () => {
    const res = await createR(json(goodDraft))
    expect(res.status).toBe(201)
    const created = await res.json()
    expect(created).toMatchObject({ name: '番茄炒蛋' })
    expect(created.id).toMatch(/^r-\d+-[0-9a-f]{6}$/)
    const list = await (await listR(new Request('http://x/api/recipes'))).json()
    expect(list.recipes).toHaveLength(1)
    expect(list.recipes[0]).toMatchObject({ id: created.id, name: '番茄炒蛋' })
  })

  it('GET 单个：存在 200 / 不存在 404 + 中文 error', async () => {
    const created = await (await createR(json(goodDraft))).json()
    const ok = await getR(new Request('http://x'), ctxOf(created.id))
    expect(ok.status).toBe(200)
    expect((await ok.json()).id).toBe(created.id)
    const miss = await getR(new Request('http://x'), ctxOf('r-none'))
    expect(miss.status).toBe(404)
    expect((await miss.json()).error).toBeTruthy()
  })

  it('POST 非法 body 返回 400 + 中文 error', async () => {
    const res = await createR(json({ name: '' }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBeTruthy()
  })

  it('PUT 更新 / PUT 不存在 404 / PUT 非法 body 400 / DELETE 204 无 body / 二次 DELETE 404', async () => {
    const created = await (await createR(json(goodDraft))).json()
    // PUT 更新：200，保留 id
    const put = await putR(json({ ...goodDraft, name: '西红柿炒蛋' }), ctxOf(created.id))
    expect(put.status).toBe(200)
    const updated = await put.json()
    expect(updated.name).toBe('西红柿炒蛋')
    expect(updated.id).toBe(created.id)
    // PUT 不存在的 id：404
    expect((await putR(json(goodDraft), ctxOf('r-none'))).status).toBe(404)
    // PUT 非法 body：400
    expect((await putR(json({ name: '' }), ctxOf(created.id))).status).toBe(400)
    // DELETE 成功：204 且无 body
    const del = await delR(new Request('http://x'), ctxOf(created.id))
    expect(del.status).toBe(204)
    expect(await del.text()).toBe('')
    // 删除生效：列表为空；二次 DELETE：404
    const list = await (await listR(new Request('http://x/api/recipes'))).json()
    expect(list.recipes).toHaveLength(0)
    expect((await delR(new Request('http://x'), ctxOf(created.id))).status).toBe(404)
  })

  it('q 与 tag 查询参数生效（q 命中名称/食材，tag 精确，组合取交集）', async () => {
    await createR(json(goodDraft)) // 番茄炒蛋，tags: ['家常菜']
    await createR(json({
      ...goodDraft, name: 'Beef Salad', tags: ['西式'],
      ingredients: [{ name: 'Beef', amount: '200g' }],
    }))
    // q 命中名称
    const byQ = await (await listR(new Request('http://x/api/recipes?q=番茄'))).json()
    expect(byQ.recipes.map((r: { name: string }) => r.name)).toEqual(['番茄炒蛋'])
    // q 命中食材名（大小写不敏感）
    const byIng = await (await listR(new Request('http://x/api/recipes?q=beef'))).json()
    expect(byIng.recipes.map((r: { name: string }) => r.name)).toEqual(['Beef Salad'])
    // tag 精确匹配
    const byTag = await (await listR(new Request('http://x/api/recipes?tag=西式'))).json()
    expect(byTag.recipes.map((r: { name: string }) => r.name)).toEqual(['Beef Salad'])
    // q + tag 组合：交集为空
    const both = await (await listR(new Request('http://x/api/recipes?q=番茄&tag=西式'))).json()
    expect(both.recipes).toHaveLength(0)
  })

  it('invalidFiles 只保留 .json 条目（route 层过滤 Task 3 的宽语义）', async () => {
    await createR(json(goodDraft))
    // 模拟 Task 3 裁定的宽语义：非法 JSON 与非 .json 文件都会进 store 的 invalidFiles
    await fs.writeFile(`${dir}/broken.json`, '{oops', 'utf8')
    await fs.writeFile(`${dir}/notes.txt`, 'hello', 'utf8')
    const list = await (await listR(new Request('http://x/api/recipes'))).json()
    expect(list.recipes).toHaveLength(1)
    expect(list.invalidFiles).toEqual(['broken.json'])
  })
})
