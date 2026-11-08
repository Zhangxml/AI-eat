// 菜谱库 REST API 单测：直接 import route handler 函数调用（node 环境，无 HTTP 服务器）
// 数据目录经 process.env.AI_EAT_DATA_DIR 注入临时目录（store 每次调用时读 env，模块顶层默认值不受影响）
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { GET as listR, POST as createR } from './route'
import { GET as getR, PUT as putR, DELETE as delR } from './[id]/route'
import { issueToken } from '@/lib/auth'
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

  it('启用鉴权后未带会话 → 401；带合法会话 Cookie → 200（守卫前置，未读 body 未触 store）', async () => {
    const created = await (await createR(json(goodDraft))).json()
    try {
      process.env.PASSWORD = 'test-pw'
      // 无 Cookie：列表/单个/创建/更新/删除一律 401
      expect((await listR(new Request('http://x/api/recipes'))).status).toBe(401)
      expect((await getR(new Request('http://x'), ctxOf(created.id))).status).toBe(401)
      expect((await createR(json(goodDraft))).status).toBe(401)
      expect((await putR(json(goodDraft), ctxOf(created.id))).status).toBe(401)
      expect((await delR(new Request('http://x'), ctxOf(created.id))).status).toBe(401)
      // 401 拦截在前：未消费 body 的请求带着非法 body 也先被守卫拦下（守卫是 handler 首行）
      expect((await createR(new Request('http://x', { method: 'POST', body: '{oops' }))).status).toBe(401)
      // 带合法会话：列表 200，能取到既有菜谱
      const token = issueToken()
      const ok = await listR(new Request('http://x/api/recipes', { headers: { cookie: `ai-eat-session=${token}` } }))
      expect(ok.status).toBe(200)
      const body = await ok.json()
      expect(body.recipes).toHaveLength(1)
      expect(body.recipes[0].id).toBe(created.id)
      // 带会话的删除也走通（守卫放行后正常业务路径）
      expect((await delR(new Request('http://x', { headers: { cookie: `ai-eat-session=${token}` } }), ctxOf(created.id))).status).toBe(204)
    } finally {
      delete process.env.PASSWORD
    }
  })

  it('删除保护未启用：DELETE 不带密码直接 204（默认行为不变）', async () => {
    const created = await (await createR(json(goodDraft))).json()
    const res = await delR(new Request('http://x', { method: 'DELETE' }), ctxOf(created.id))
    expect(res.status).toBe(204)
  })

  it('删除保护启用：无密码/错密码/非字符串 → 403；正确密码 → 204（恒时比较）', async () => {
    const created = await (await createR(json(goodDraft))).json()
    try {
      process.env.DELETE_ENABLED = 'true'
      process.env.DELETE_PASSWORD = 'del-secret'
      const ctx = ctxOf(created.id)
      // 无 body / 非法 body / 密码字段缺失 / 非字符串 → 全部 403 同文案（不区分原因，防探测）
      expect((await delR(new Request('http://x', { method: 'DELETE' }), ctx)).status).toBe(403)
      const bad = await delR(new Request('http://x', { method: 'DELETE', body: '{oops' }), ctx)
      expect(bad.status).toBe(403)
      const wrong = await delR(json({ deletePassword: 'wrong' }), ctx)
      expect(wrong.status).toBe(403)
      expect(((await wrong.json()) as { error: string }).error).toContain('删除密码校验失败')
      expect((await delR(json({ deletePassword: 123 }), ctx)).status).toBe(403)
      // 正确密码 → 204 且菜谱真的删掉了
      expect((await delR(json({ deletePassword: 'del-secret' }), ctx)).status).toBe(204)
      expect((await getR(new Request('http://x'), ctx)).status).toBe(404)
      // 开关半配（DELETE_ENABLED=true 但密码为空）视为未启用：直接删除成功
      delete process.env.DELETE_PASSWORD
      const second = await (await createR(json(goodDraft))).json()
      expect((await delR(new Request('http://x', { method: 'DELETE' }), ctxOf(second.id))).status).toBe(204)
    } finally {
      delete process.env.DELETE_ENABLED
      delete process.env.DELETE_PASSWORD
    }
  })

  it('listRecipes 非 ENOENT 故障 → GET 列表 500 中文（审计修复 #8，不再静默当空库）', async () => {
    // 把数据目录指到一个普通文件上：readdir 抛 ENOTDIR（非 ENOENT），route 必须返回 500
    const filePath = path.join(dir, 'not-a-dir')
    await fs.writeFile(filePath, 'x', 'utf8')
    process.env.AI_EAT_DATA_DIR = filePath
    try {
      const res = await listR(new Request('http://x/api/recipes'))
      expect(res.status).toBe(500)
      expect(((await res.json()) as { error: string }).error).toContain('菜谱库读取失败')
    } finally {
      process.env.AI_EAT_DATA_DIR = dir
    }
  })

  it('POST 创建：content-length 超 1MB → 413 { error: 请求体过大 }（审计修复 #4）', async () => {
    const res = await createR(
      new Request('http://x', {
        method: 'POST',
        body: JSON.stringify(goodDraft),
        headers: { 'content-type': 'application/json', 'content-length': String(1024 * 1024 + 1) },
      }),
    )
    expect(res.status).toBe(413)
    expect(((await res.json()) as { error: string }).error).toBe('请求体过大')
  })
})
