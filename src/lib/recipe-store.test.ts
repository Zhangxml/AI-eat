// 菜谱文件存储单测：临时目录放系统 tmpdir 下，每用例独立目录，通过末位 dir 参数注入（不改环境变量，那是 T4 的事）
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import os from 'node:os'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  recipesDir,
  listRecipes,
  getRecipe,
  createRecipe,
  updateRecipe,
  deleteRecipe,
  putRecipe,
  filterRecipes,
  buildFacets,
} from './recipe-store'
import type { DraftRecipe, Recipe } from './recipe-types'

// 合法草稿：与 recipe-types.test.ts 保持一致
const goodDraft: DraftRecipe = {
  name: '番茄炒蛋', servings: 2, difficulty: '简单', totalTimeMin: 20,
  tags: ['家常菜'], ingredients: [{ name: '番茄', amount: '2个' }],
  steps: ['番茄切块'], source: 'ai',
}

// 构造完整菜谱（putRecipe / filterRecipes / 排序用例）
// category 为可选末参：不传则不设该字段（与既有用例保持一致）
function makeRecipe(
  id: string,
  name: string,
  tags: string[],
  ingredientNames: string[],
  category?: Recipe['category'],
): Recipe {
  return {
    ...goodDraft, name, tags,
    ...(category !== undefined ? { category } : {}),
    ingredients: ingredientNames.map(n => ({ name: n, amount: '1份' })),
    id,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

describe('菜谱文件存储', () => {
  let dir: string

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-eat-test-'))
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('recipesDir 默认落在 <cwd>/data/recipes', () => {
    expect(recipesDir()).toBe(path.join(process.cwd(), 'data', 'recipes'))
  })

  it('create→list→get 全链路', async () => {
    const r = await createRecipe(goodDraft, dir)
    expect(r.id).toMatch(/^r-\d+-[0-9a-f]{6}$/)
    expect((await listRecipes(dir)).recipes).toHaveLength(1)
    expect(await getRecipe(r.id, dir)).toMatchObject({ name: '番茄炒蛋' })
  })

  it('落盘为 <id>.json，清缓存场景：新读实例仍可读', async () => {
    const r = await createRecipe(goodDraft, dir)
    await expect(fs.access(path.join(dir, `${r.id}.json`))).resolves.toBeUndefined()
    // 存储无内存缓存：重新 list 仍从磁盘读到该记录
    expect((await listRecipes(dir)).recipes.map(x => x.id)).toEqual([r.id])
  })

  it('非法 JSON 文件被跳过并上报', async () => {
    await fs.writeFile(path.join(dir, 'broken.json'), '{oops', 'utf8')
    const { recipes, invalidFiles } = await listRecipes(dir)
    expect(recipes).toHaveLength(0)
    expect(invalidFiles).toEqual(['broken.json'])
  })

  it('schema 不合法的 .json 同样跳过并上报（.strict() 拒绝多余字段）', async () => {
    // 设计文档 5.3 既定处置：多余字段判非法 → 跳过并在 invalidFiles 上报，不改 Task 2 的 schema
    await fs.writeFile(
      path.join(dir, 'dirty.json'),
      JSON.stringify({ ...goodDraft, id: 'r-x', createdAt: 'x', updatedAt: 'x', extra: 1 }),
      'utf8',
    )
    const { recipes, invalidFiles } = await listRecipes(dir)
    expect(recipes).toHaveLength(0)
    expect(invalidFiles).toEqual(['dirty.json'])
  })

  it('原子写不残留 .tmp 文件', async () => {
    await createRecipe(goodDraft, dir)
    expect((await fs.readdir(dir)).filter(f => f.endsWith('.tmp'))).toEqual([])
  })

  it('fresh 目录（不存在）直接 createRecipe 成功', async () => {
    // data/ 不入库，全新部署首跑时目录不存在：写入前应自动创建，而非 ENOENT 500
    const fresh = path.join(dir, 'nested', 'fresh-create')
    await expect(fs.access(fresh)).rejects.toThrow() // 先断言目录确实不存在
    const r = await createRecipe(goodDraft, fresh)
    expect(await getRecipe(r.id, fresh)).toMatchObject({ name: '番茄炒蛋' })
  })

  it('fresh 目录直接 putRecipe 成功', async () => {
    const fresh = path.join(dir, 'nested', 'fresh-put')
    await expect(fs.access(fresh)).rejects.toThrow() // 先断言目录确实不存在
    const full = makeRecipe('r-fresh-put', '凉拌黄瓜', ['凉菜'], ['黄瓜'])
    await putRecipe(full, fresh)
    expect(await getRecipe('r-fresh-put', fresh)).toEqual(full)
  })

  it('update 刷新 updatedAt 且保留 id', async () => {
    const r = await createRecipe(goodDraft, dir)
    await new Promise(resolve => setTimeout(resolve, 5)) // 保证时间戳可区分
    const updated = await updateRecipe(r.id, { ...goodDraft, name: '西红柿炒蛋' }, dir)
    expect(updated).not.toBeNull()
    expect(updated?.id).toBe(r.id) // id 不变
    expect(updated?.name).toBe('西红柿炒蛋') // 内容已更新
    expect(updated?.createdAt).toBe(r.createdAt) // createdAt 保留
    expect(updated?.updatedAt).not.toBe(r.updatedAt) // updatedAt 刷新
    expect(await getRecipe(r.id, dir)).toMatchObject({ name: '西红柿炒蛋' }) // 落盘生效
  })

  it('getRecipe / updateRecipe 对不存在 id 返回 null', async () => {
    await expect(getRecipe('r-none', dir)).resolves.toBeNull()
    await expect(updateRecipe('r-none', goodDraft, dir)).resolves.toBeNull()
  })

  it('id 白名单：路径穿越 id 被拦截——getRecipe/updateRecipe 返回 null 且不触碰越界文件', async () => {
    // 越界目标：store 目录外层放一份「合法菜谱」金丝雀（若守卫生效则绝不可被读到/覆写）；
    // 用合法菜谱而非任意 JSON，确保 RED 阶段无守卫时真的读得回来（package.json 会被 schema 拒掉，测不出真红）
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-eat-trav-'))
    try {
      const store = path.join(root, 'store')
      const outside = makeRecipe('r-outside', '越界菜谱', ['其他'], ['土豆'])
      await fs.writeFile(path.join(root, 'outside.json'), JSON.stringify(outside), 'utf8')
      await expect(getRecipe('../outside', store)).resolves.toBeNull()
      await expect(updateRecipe('../outside', goodDraft, store)).resolves.toBeNull()
      // 越界文件原样：既未被读到（内容未被改写），也未被 update 覆写
      await expect(fs.readFile(path.join(root, 'outside.json'), 'utf8')).resolves.toBe(JSON.stringify(outside))
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('id 白名单：deleteRecipe 拒绝穿越 id，项目根 package.json 不被误删', async () => {
    // 真实攻击面：默认目录 <cwd>/data/recipes 下 '../../package' 恰好指向项目根 package.json
    await expect(deleteRecipe('../../package')).resolves.toBe(false)
    const pkg = JSON.parse(await fs.readFile(path.join(process.cwd(), 'package.json'), 'utf8')) as { name: string }
    expect(pkg.name).toBe('ai-eat')
  })

  it('id 白名单：putRecipe 对穿越 id 抛错（不静默吞掉，让备份导入计入 invalidIds）', async () => {
    const evil = makeRecipe('../evil', '穿越菜谱', ['其他'], ['土豆'])
    await expect(putRecipe(evil, dir)).rejects.toThrow('非法的菜谱 id')
  })

  it('delete 返回 true，二次 delete 返回 false', async () => {
    const r = await createRecipe(goodDraft, dir)
    await expect(deleteRecipe(r.id, dir)).resolves.toBe(true)
    await expect(fs.access(path.join(dir, `${r.id}.json`))).rejects.toThrow()
    await expect(deleteRecipe(r.id, dir)).resolves.toBe(false)
  })

  it('putRecipe 按原 id 写入', async () => {
    const full = makeRecipe('r-backup-1', '红烧肉', ['硬菜'], ['五花肉'])
    await putRecipe(full, dir)
    expect(await getRecipe('r-backup-1', dir)).toEqual(full)
  })

  it('listRecipes 按 updatedAt 降序排列', async () => {
    const older = makeRecipe('r-old', '旧菜', ['其他'], ['土豆'])
    const newer = makeRecipe('r-new', '新菜', ['其他'], ['白菜'])
    newer.updatedAt = '2026-06-01T00:00:00.000Z'
    await putRecipe(older, dir) // updatedAt 为 2026-01-01
    await putRecipe(newer, dir)
    expect((await listRecipes(dir)).recipes.map(r => r.id)).toEqual(['r-new', 'r-old'])
  })

  it('目录不存在时 listRecipes 返回空列表不崩溃', async () => {
    const notExist = path.join(dir, 'not-exist')
    expect(await listRecipes(notExist)).toEqual({ recipes: [], invalidFiles: [] })
  })

  it('listRecipes 错误分级（审计修复 #8）：ENOENT 空库；其余 errno（如 EACCES/普通文件路径）throw', async () => {
    // ENOENT：全新部署首跑常态，保持空库语义（既有用例已覆盖，这里保留显式断言）
    const notExist = path.join(dir, 'not-exist-either')
    expect(await listRecipes(notExist)).toEqual({ recipes: [], invalidFiles: [] })
    // 非 ENOENT：路径是一个普通文件（readdir 得 ENOTDIR）→ 必须 throw，不得静默当空库
    const filePath = path.join(dir, 'plain-file')
    await fs.writeFile(filePath, 'x', 'utf8')
    await expect(listRecipes(filePath)).rejects.toThrow()
  })

  it('filterRecipes：q 命中名称或食材名，tag 精确', async () => {
    const a = makeRecipe('r-a', '番茄炒蛋', ['家常菜'], ['番茄', '鸡蛋'])
    const b = makeRecipe('r-b', 'Beef Salad', ['西式'], ['BEEF', 'Lettuce'])
    const all = [a, b]
    // q 命中名称
    expect(filterRecipes(all, { q: '番茄' })).toEqual([a])
    // q 命中食材名，且大小写不敏感
    expect(filterRecipes(all, { q: 'beef' })).toEqual([b])
    // q 无命中返回空
    expect(filterRecipes(all, { q: '不存在的菜' })).toEqual([])
    // tag 精确匹配（非 includes）
    expect(filterRecipes(all, { tag: '西式' })).toEqual([b])
    expect(filterRecipes(all, { tag: '家' })).toEqual([])
    // q 与 tag 组合过滤
    expect(filterRecipes(all, { q: '番茄', tag: '家常菜' })).toEqual([a])
  })

  it('filterRecipes：category 精确过滤，且与 q/tag 取交集', () => {
    const meat = makeRecipe('r-m', '红烧肉', ['家常菜', '下饭菜'], ['五花肉'], '荤菜')
    const soup = makeRecipe('r-s', '番茄蛋汤', ['家常菜', '清淡'], ['番茄', '鸡蛋'], '汤')
    const staple = makeRecipe('r-t', '蛋炒饭', ['快手菜'], ['米饭'], '主食')
    const all = [meat, soup, staple]

    expect(filterRecipes(all, { category: '荤菜' })).toEqual([meat])
    expect(filterRecipes(all, { category: '不存在的分类' })).toEqual([])
    // category 为 undefined / 空串：不过滤
    expect(filterRecipes(all, {})).toEqual(all)
    expect(filterRecipes(all, { category: undefined })).toEqual(all)
    expect(filterRecipes(all, { category: '  ' })).toEqual(all)

    // 分类 + 标签 交集：家常菜在荤菜与汤里都有，用分类收窄
    expect(filterRecipes(all, { category: '荤菜', tag: '家常菜' })).toEqual([meat])
    expect(filterRecipes(all, { category: '汤', tag: '家常菜' })).toEqual([soup])
    // 交集为空
    expect(filterRecipes(all, { category: '主食', tag: '下饭菜' })).toEqual([])
    // 三条件交集：q 命中食材 + 分类 + 标签
    expect(filterRecipes(all, { q: '五花肉', category: '荤菜', tag: '下饭菜' })).toEqual([meat])
    expect(filterRecipes(all, { q: '五花肉', category: '汤', tag: '下饭菜' })).toEqual([])
  })
})

describe('buildFacets 筛选面板数据', () => {
  const meat1 = makeRecipe('r-m1', '红烧肉', ['家常菜', '下饭菜'], ['五花肉'], '荤菜')
  const meat2 = makeRecipe('r-m2', '青椒肉丝', ['家常菜', '快手菜'], ['猪肉'], '荤菜')
  const soup = makeRecipe('r-s1', '番茄蛋汤', ['家常菜', '清淡'], ['番茄'], '汤')
  const staple = makeRecipe('r-p1', '蛋炒饭', ['快手菜'], ['米饭'], '主食')
  const all = [meat1, meat2, soup, staple]

  it('无分类时：categories 只含实际存在的分类，且按固定顺序（荤菜→素菜→汤→主食→其他）', () => {
    const { categories } = buildFacets(all)
    expect(categories).toEqual(['荤菜', '汤', '主食'])
  })

  it('无分类时：tags 为该范围内全部标签，按频次降序（同频按字典序，保证稳定）', () => {
    const { tags } = buildFacets(all)
    // 家常菜 3 次、快手菜 2 次，其余各 1 次
    expect(tags[0]).toBe('家常菜')
    expect(tags[1]).toBe('快手菜')
    expect(tags).toHaveLength(new Set(all.flatMap(r => r.tags)).size)
    // 同频（都是 1 次）时保持字典序稳定
    expect(tags.slice(2)).toEqual([...tags.slice(2)].sort((a, b) => a.localeCompare(b)))
  })

  it('指定分类时：tags 只含该分类内实际出现的标签（按该分类内频次）', () => {
    const { tags } = buildFacets(all, '荤菜')
    expect(new Set(tags)).toEqual(new Set(['家常菜', '下饭菜', '快手菜']))
    // 「清淡」「早餐」这类只在汤/主食里的标签不得出现
    expect(tags).not.toContain('清淡')
  })

  it('指定分类时：categories 仍返回全量（分类行不随分类收敛）', () => {
    expect(buildFacets(all, '荤菜').categories).toEqual(['荤菜', '汤', '主食'])
  })

  it('空库：categories 与 tags 都为空数组', () => {
    expect(buildFacets([])).toEqual({ categories: [], tags: [] })
    expect(buildFacets([], '荤菜')).toEqual({ categories: [], tags: [] })
  })

  it('菜谱无 category 字段时：不计入 categories，但其余标签照常统计', () => {
    const noCat = makeRecipe('r-n', '无分类菜', ['野路子'], ['x'])
    const r = buildFacets([noCat, meat1])
    expect(r.categories).toEqual(['荤菜'])
    expect(r.tags).toContain('野路子')
  })

  it('指定一个不存在的分类：tags 为空、categories 仍全量', () => {
    const r = buildFacets(all, '其他')
    expect(r.tags).toEqual([])
    expect(r.categories).toEqual(['荤菜', '汤', '主食'])
  })
})
