// 菜谱文件存储：一菜一 JSON 文件，文件名即 id（设计文档 5.3）
// 服务启动时容忍非法 JSON 文件：跳过并在 invalidFiles 上报，不崩溃
// 并发策略（设计文档 §7）：单人使用，写临时文件 + fs.rename 原子替换，无需文件锁；本层无内存缓存，始终以磁盘为准
import { promises as fs } from 'node:fs'
import path from 'node:path'
// 原子写（带随机临时名，并发安全）收敛在 atomic-write，三个写入函数共用
import { atomicWriteFile } from './atomic-write'
import type { Recipe, DraftRecipe } from './recipe-types'
import { validateRecipe, makeRecipeId } from './recipe-types'

// 数据目录：可由环境变量覆盖（T4 API 侧使用），默认落在 <cwd>/data/recipes
export function recipesDir(): string {
  return process.env.AI_EAT_DATA_DIR || path.join(process.cwd(), 'data', 'recipes')
}

// 读取单个菜谱文件；文件不存在、非法 JSON 或 schema 不合法返回 null
async function readRecipeFile(file: string): Promise<Recipe | null> {
  let raw: string
  try {
    raw = await fs.readFile(file, 'utf8')
  } catch {
    return null
  }
  try {
    return validateRecipe(JSON.parse(raw))
  } catch {
    return null
  }
}

// 列出全部菜谱：非法 JSON / schema 不合法 / 非 .json 文件跳过并进 invalidFiles；按 updatedAt 降序。
// 错误分级（审计修复 #8）：readdir 仅 ENOENT（目录不存在，全新部署首跑常态）返回空库；
// 其余 errno（EACCES 权限、EIO 等）一律 throw——静默吞掉会让用户误以为「菜谱全没了」，
// 而实际是权限/磁盘故障，必须让上层（route）感知并返回 500 提示排查
export async function listRecipes(
  dir: string = recipesDir(),
): Promise<{ recipes: Recipe[]; invalidFiles: string[] }> {
  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      // 目录不存在视为空库，不崩溃
      return { recipes: [], invalidFiles: [] }
    }
    throw e
  }
  const recipes: Recipe[] = []
  const invalidFiles: string[] = []
  for (const name of entries) {
    const recipe = name.endsWith('.json') ? await readRecipeFile(path.join(dir, name)) : null
    if (recipe) {
      recipes.push(recipe)
    } else {
      invalidFiles.push(name)
    }
  }
  // updatedAt 为 ISO 字符串，字典序即时间序，可直接比较
  recipes.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
  return { recipes, invalidFiles }
}

// id 白名单守卫（单一事实来源，四个按 id 拼路径的入口共用）：
// id 仅允许字母/数字/下划线/连字符，杜绝 `..%2F..%2Fpackage` 类路径穿越越出数据目录
export function isSafeId(id: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(id)
}

// 按 id 取单个菜谱；文件不存在、非法 id 或内容非法返回 null
export async function getRecipe(id: string, dir: string = recipesDir()): Promise<Recipe | null> {
  if (!isSafeId(id)) return null
  return readRecipeFile(path.join(dir, `${id}.json`))
}

// 新建：补 id 与时间戳后原子写入
export async function createRecipe(draft: DraftRecipe, dir: string = recipesDir()): Promise<Recipe> {
  const now = new Date().toISOString()
  const recipe: Recipe = { ...draft, id: makeRecipeId(), createdAt: now, updatedAt: now }
  await atomicWriteFile(path.join(dir, `${recipe.id}.json`), JSON.stringify(recipe, null, 2))
  return recipe
}

// 更新：保留原 id 与 createdAt，刷新 updatedAt；菜谱不存在返回 null
export async function updateRecipe(
  id: string,
  draft: DraftRecipe,
  dir: string = recipesDir(),
): Promise<Recipe | null> {
  if (!isSafeId(id)) return null
  const existing = await getRecipe(id, dir)
  if (!existing) return null
  const recipe: Recipe = {
    ...draft,
    id,
    createdAt: existing.createdAt,
    updatedAt: new Date().toISOString(),
  }
  await atomicWriteFile(path.join(dir, `${id}.json`), JSON.stringify(recipe, null, 2))
  return recipe
}

// 删除：成功返回 true；文件不存在或非法 id 返回 false；
// 其余 IO 故障（EACCES/EIO 等）抛出，由路由映射 500——与 listRecipes 的 ENOENT 分级保持一致
// （此前一律返回 false 会被误报成「菜谱不存在」）
export async function deleteRecipe(id: string, dir: string = recipesDir()): Promise<boolean> {
  if (!isSafeId(id)) return false
  try {
    await fs.unlink(path.join(dir, `${id}.json`))
    return true
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw e
  }
}

// 按原 id 直接写入完整菜谱（供备份导入，不改动 id 与时间戳）
// 非法 id 直接 throw（不静默返回）：备份导入侧靠捕获该异常把该条计入 invalidIds
export async function putRecipe(recipe: Recipe, dir: string = recipesDir()): Promise<void> {
  if (!isSafeId(recipe.id)) throw new Error('非法的菜谱 id')
  await atomicWriteFile(path.join(dir, `${recipe.id}.json`), JSON.stringify(recipe, null, 2))
}

// 分类展示顺序：固定语义顺序（荤→素→汤→主食→其他），不按数量排序——
// 分类是枚举而非热度榜，顺序稳定才符合直觉
export const CATEGORY_ORDER = ['荤菜', '素菜', '汤', '主食', '其他'] as const

// 纯函数过滤：q 大小写不敏感匹配名称或任一食材名；category 与 tag 精确匹配；
// 三者同时给定时取交集（任一维度为空/空白则忽略该维度）
export function filterRecipes(
  recipes: Recipe[],
  opts: { q?: string; category?: string; tag?: string },
): Recipe[] {
  const q = opts.q?.trim().toLowerCase()
  const tag = opts.tag?.trim() || undefined
  const category = opts.category?.trim() || undefined
  return recipes.filter(r => {
    if (category !== undefined && r.category !== category) return false
    if (tag !== undefined && !r.tags.includes(tag)) return false
    if (q) {
      const hitName = r.name.toLowerCase().includes(q)
      const hitIngredient = r.ingredients.some(i => i.name.toLowerCase().includes(q))
      if (!hitName && !hitIngredient) return false
    }
    return true
  })
}

// 筛选面板数据（facets）：给前端渲染「分类」「标签」两行 chips 用。
// 关键语义：tags 随 category 收敛——选定分类后只返回该分类内实际出现过的标签，
// 避免用户点出「主食 + 下饭菜」这类必然为空的组合（实测真实数据里 69% 的分类×标签组合为空）。
// categories 则始终返回全量实际存在的分类：分类行不随自身选择收敛，否则切走就回不来了。
export function buildFacets(
  recipes: Recipe[],
  category?: string,
): { categories: string[]; tags: string[] } {
  const present = new Set(recipes.map(r => r.category).filter((c): c is NonNullable<typeof c> => c !== undefined))
  const categories = CATEGORY_ORDER.filter(c => present.has(c))

  // tags 统计范围：指定分类时只看该分类内的菜谱
  const scope = category === undefined ? recipes : recipes.filter(r => r.category === category)
  const counts = new Map<string, number>()
  for (const r of scope) {
    for (const t of r.tags) counts.set(t, (counts.get(t) ?? 0) + 1)
  }
  const tags = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([t]) => t)

  return { categories, tags }
}
