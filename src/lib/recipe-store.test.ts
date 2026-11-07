// 菜谱文件存储单测：临时目录放 /tmp/opencode 下，每用例独立目录，通过末位 dir 参数注入（不改环境变量，那是 T4 的事）
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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
} from './recipe-store'
import type { DraftRecipe, Recipe } from './recipe-types'

// 合法草稿：与 recipe-types.test.ts 保持一致
const goodDraft: DraftRecipe = {
  name: '番茄炒蛋', servings: 2, difficulty: '简单', totalTimeMin: 20,
  tags: ['家常菜'], ingredients: [{ name: '番茄', amount: '2个' }],
  steps: ['番茄切块'], source: 'ai',
}

// 构造完整菜谱（putRecipe / filterRecipes / 排序用例）
function makeRecipe(id: string, name: string, tags: string[], ingredientNames: string[]): Recipe {
  return {
    ...goodDraft, name, tags,
    ingredients: ingredientNames.map(n => ({ name: n, amount: '1份' })),
    id,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

describe('菜谱文件存储', () => {
  let dir: string

  beforeEach(async () => {
    dir = await fs.mkdtemp('/tmp/opencode/ai-eat-test-')
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
})
