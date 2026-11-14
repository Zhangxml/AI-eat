// 菜谱库 REST API 单测：直接 import route handler 函数调用（node 环境，无 HTTP 服务器）
// 数据目录经 process.env.AI_EAT_DATA_DIR 注入临时目录（store 每次调用时读 env，模块顶层默认值不受影响）
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import os from 'node:os'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { GET as listR, POST as createR } from './route'
import { GET as getR, PUT as putR, DELETE as delR } from './[id]/route'
import { enableMultiUser, makeSession } from '@/lib/test-helpers'
import type { DraftRecipe } from '@/lib/recipe-types'

// 合法草稿：与 recipe-store.test.ts 保持一致
const goodDraft: DraftRecipe = {
  name: '番茄炒蛋', servings: 2, difficulty: '简单', totalTimeMin: 20,
  tags: ['家常菜'], ingredients: [{ name: '番茄', amount: '2个' }],
  steps: ['番茄切块'], source: 'ai',
}

// 构造带 JSON body 的请求（handler 只读 body，不关心 method）；可选带会话 Cookie
const json = (body: unknown, cookie?: string) =>
  new Request('http://x', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: cookie
      ? { 'content-type': 'application/json', cookie }
      : { 'content-type': 'application/json' },
  })

// Next 15 动态路由 ctx：params 为 Promise
const ctxOf = (id: string) => ({ params: Promise.resolve({ id }) })

describe('菜谱库 REST API', () => {
  let dir: string

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-eat-api-'))
    process.env.AI_EAT_DATA_DIR = `${dir}/recipes` // 指向子目录：日志落到独立的 ${dir}/logs，避免污染共享日志目录
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
    delete process.env.AI_EAT_DATA_DIR
  })

  it('GET 返回 facets（分类行全量、标签行随 category 收敛），并支持 category 过滤', async () => {
    const drafts = [
      { ...goodDraft, name: '红烧肉', category: '荤菜' as const, tags: ['家常菜', '下饭菜'] },
      { ...goodDraft, name: '青椒肉丝', category: '荤菜' as const, tags: ['家常菜', '快手菜'] },
      { ...goodDraft, name: '番茄蛋汤', category: '汤' as const, tags: ['清淡'] },
      { ...goodDraft, name: '蛋炒饭', category: '主食' as const, tags: ['快手菜'] },
    ]
    for (const d of drafts) expect((await createR(json(d))).status).toBe(201)

    // 无筛选：categories 按固定顺序，tags 全量按频次降序
    const allRes = await listR(new Request('http://x/api/recipes'))
    const all = (await allRes.json()) as {
      recipes: unknown[]
      facets: { categories: string[]; tags: string[] }
    }
    expect(all.recipes).toHaveLength(4)
    expect(all.facets.categories).toEqual(['荤菜', '汤', '主食'])
    // 家常菜与快手菜都是 2 次，同频按字典序 → 「家常菜」在前
    expect(all.facets.tags.slice(0, 2)).toEqual(['家常菜', '快手菜'])
    expect(all.facets.tags).toContain('清淡')

    // 指定 category=荤菜：结果只剩 2 道，tags 收敛（不含汤/主食独有的「清淡」）
    const meatRes = await listR(new Request('http://x/api/recipes?category=荤菜'))
    const meat = (await meatRes.json()) as {
      recipes: unknown[]
      facets: { categories: string[]; tags: string[] }
    }
    expect(meat.recipes).toHaveLength(2)
    expect(meat.facets.categories).toEqual(['荤菜', '汤', '主食']) // 分类行不收敛
    expect(meat.facets.tags).not.toContain('清淡')
    expect(new Set(meat.facets.tags)).toEqual(new Set(['家常菜', '下饭菜', '快手菜']))

    // category 空串 = 全部（不报错、不过滤）
    const blankRes = await listR(new Request('http://x/api/recipes?category='))
    expect(((await blankRes.json()) as { recipes: unknown[] }).recipes).toHaveLength(4)

    // category + tag 交集
    const bothRes = await listR(new Request('http://x/api/recipes?category=荤菜&tag=下饭菜'))
    const both = (await bothRes.json()) as {
      recipes: { name: string }[]
      facets: { tags: string[] }
    }
    expect(both.recipes.map(r => r.name)).toEqual(['红烧肉'])
    // 关键：facets.tags 只受 category 影响，**不受当前 tag 影响**——
    // 若误用过滤后的结果算 facets，选中标签后标签行会塌缩成只剩它自己，无法切换
    expect(new Set(both.facets.tags)).toEqual(new Set(['家常菜', '下饭菜', '快手菜']))

    // 同理：facets.tags 不受搜索词影响
    const qRes = await listR(new Request('http://x/api/recipes?q=红烧肉'))
    const q = (await qRes.json()) as { facets: { tags: string[] } }
    expect(q.facets.tags).toContain('清淡') // 清淡只在汤里，搜索红烧肉（荤菜）也仍在 facets
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
    // （数据目录已指向 <tmp>/recipes，故写入该子目录）
    await fs.writeFile(`${dir}/recipes/broken.json`, '{oops', 'utf8')
    await fs.writeFile(`${dir}/recipes/notes.txt`, 'hello', 'utf8')
    const list = await (await listR(new Request('http://x/api/recipes'))).json()
    expect(list.recipes).toHaveLength(1)
    expect(list.invalidFiles).toEqual(['broken.json'])
  })

  it('启用多用户后未带会话 → 401；带会话 → 200（守卫前置，未读 body 未触 store）', async () => {
    const admin = await enableMultiUser()
    // 先带会话建一条，确保后续断言有数据
    const created = await (
      await createR(json(goodDraft, admin.cookie))
    ).json()

    // 无 Cookie：列表/单个/创建/更新/删除一律 401
    expect((await listR(new Request('http://x/api/recipes'))).status).toBe(401)
    expect((await getR(new Request('http://x'), ctxOf(created.id))).status).toBe(401)
    expect((await createR(json(goodDraft))).status).toBe(401)
    expect((await putR(json(goodDraft), ctxOf(created.id))).status).toBe(401)
    expect((await delR(new Request('http://x'), ctxOf(created.id))).status).toBe(401)
    // 401 拦截在前：未消费 body 的请求带着非法 body 也先被守卫拦下（守卫是 handler 首行）
    expect((await createR(new Request('http://x', { method: 'POST', body: '{oops' }))).status).toBe(401)

    // 带合法会话：列表 200，能取到既有菜谱
    const ok = await listR(new Request('http://x/api/recipes', { headers: { cookie: admin.cookie } }))
    expect(ok.status).toBe(200)
    const body = await ok.json()
    expect(body.recipes).toHaveLength(1)
    expect(body.recipes[0].id).toBe(created.id)
    // 带会话的删除也走通
    expect((await delR(new Request('http://x', { headers: { cookie: admin.cookie } }), ctxOf(created.id))).status).toBe(204)
  })

  it('跨用户隔离：他人菜谱对本用户不可见（列表不出现、直接访问 404）', async () => {
    await enableMultiUser()
    const alice = await makeSession('爱丽丝', 'member')
    const bob = await makeSession('鲍勃', 'member')

    const mine = await (await createR(json(goodDraft, alice.cookie))).json()

    // 列表：爱丽丝看得到，鲍勃看不到
    const aList = await (await listR(new Request('http://x/api/recipes', { headers: { cookie: alice.cookie } }))).json()
    const bList = await (await listR(new Request('http://x/api/recipes', { headers: { cookie: bob.cookie } }))).json()
    expect(aList.recipes.map((r: { id: string }) => r.id)).toEqual([mine.id])
    expect(bList.recipes).toHaveLength(0)

    // 直接访问：鲍勃 → 404（不是 403，避免探测存在性）
    const bGet = await getR(new Request('http://x', { headers: { cookie: bob.cookie } }), ctxOf(mine.id))
    expect(bGet.status).toBe(404)
    // 鲍勃也不能改/删
    const bPut = await putR(json({ ...goodDraft, name: '被改' }, bob.cookie), ctxOf(mine.id))
    expect(bPut.status).toBe(404)
    const bDel = await delR(new Request('http://x', { headers: { cookie: bob.cookie } }), ctxOf(mine.id))
    expect(bDel.status).toBe(404)

    // 爱丽丝自己一切正常
    expect((await getR(new Request('http://x', { headers: { cookie: alice.cookie } }), ctxOf(mine.id))).status).toBe(200)
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
      process.env.AI_EAT_DATA_DIR = `${dir}/recipes` // 指向子目录：日志落到独立的 ${dir}/logs，避免污染共享日志目录
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

  // 审查 Important：store 写失败（磁盘满/权限）此前会冒泡成 Next 默认 500，且 POST 已先记了 201 审计
  it('写入失败（目录只读）→ 500 中文错误，且审计记 500 而非 201', async () => {
    // 把数据目录设为只读，模拟 EACCES/ENOSPC 类故障
    await fs.chmod(dir, 0o555)
    try {
      const res = await createR(json(goodDraft))
      expect(res.status).toBe(500)
      expect(((await res.json()) as { error: string }).error).toMatch(/保存失败|服务器/)
      const logFile = path.join(dir, 'logs', 'access.jsonl')
      let auditLines: string[] = []
      try {
        auditLines = (await fs.readFile(logFile, 'utf8')).split('\n').filter(Boolean)
      } catch {
        /* 日志目录同样在只读目录下，未创建属正常 */
      }
      const statuses = auditLines.map((l) => (JSON.parse(l) as { status: number }).status)
      expect(statuses).not.toContain(201)
    } finally {
      await fs.chmod(dir, 0o755)
    }
  })
})
