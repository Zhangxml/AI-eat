// 菜谱文件存储：一菜一 JSON 文件，文件名即 id（设计文档 5.3）
// 服务启动时容忍非法 JSON 文件：跳过并在 invalidFiles 上报，不崩溃
// 并发策略（设计文档 §7）：单人使用，写临时文件 + fs.rename 原子替换，无需文件锁；本层无内存缓存，始终以磁盘为准
import { promises as fs } from 'node:fs'
import path from 'node:path'
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

// 原子写：先写 <目标>.tmp，再 rename 覆盖目标，失败时清理临时文件，不残留 .tmp
async function atomicWrite(file: string, data: string): Promise<void> {
  const tmp = `${file}.tmp`
  try {
    await fs.writeFile(tmp, data, 'utf8')
    await fs.rename(tmp, file)
  } finally {
    // rename 成功后 tmp 已不存在；仅在失败残留时才会真正删到东西
    await fs.rm(tmp, { force: true }).catch(() => {})
  }
}

// 列出全部菜谱：非法 JSON / schema 不合法 / 非 .json 文件跳过并进 invalidFiles；按 updatedAt 降序
export async function listRecipes(
  dir: string = recipesDir(),
): Promise<{ recipes: Recipe[]; invalidFiles: string[] }> {
  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch {
    // 目录不存在视为空库，不崩溃
    return { recipes: [], invalidFiles: [] }
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

// 按 id 取单个菜谱；文件不存在或内容非法返回 null
export async function getRecipe(id: string, dir: string = recipesDir()): Promise<Recipe | null> {
  return readRecipeFile(path.join(dir, `${id}.json`))
}

// 新建：补 id 与时间戳后原子写入
export async function createRecipe(draft: DraftRecipe, dir: string = recipesDir()): Promise<Recipe> {
  const now = new Date().toISOString()
  const recipe: Recipe = { ...draft, id: makeRecipeId(), createdAt: now, updatedAt: now }
  await atomicWrite(path.join(dir, `${recipe.id}.json`), JSON.stringify(recipe, null, 2))
  return recipe
}

// 更新：保留原 id 与 createdAt，刷新 updatedAt；菜谱不存在返回 null
export async function updateRecipe(
  id: string,
  draft: DraftRecipe,
  dir: string = recipesDir(),
): Promise<Recipe | null> {
  const existing = await getRecipe(id, dir)
  if (!existing) return null
  const recipe: Recipe = {
    ...draft,
    id,
    createdAt: existing.createdAt,
    updatedAt: new Date().toISOString(),
  }
  await atomicWrite(path.join(dir, `${id}.json`), JSON.stringify(recipe, null, 2))
  return recipe
}

// 删除：成功返回 true；文件不存在返回 false
export async function deleteRecipe(id: string, dir: string = recipesDir()): Promise<boolean> {
  try {
    await fs.unlink(path.join(dir, `${id}.json`))
    return true
  } catch {
    return false
  }
}

// 按原 id 直接写入完整菜谱（供备份导入，不改动 id 与时间戳）
export async function putRecipe(recipe: Recipe, dir: string = recipesDir()): Promise<void> {
  await atomicWrite(path.join(dir, `${recipe.id}.json`), JSON.stringify(recipe, null, 2))
}

// 纯函数过滤：q 大小写不敏感匹配名称或任一食材名 includes；tag 精确匹配；两者同时给定时取交集
export function filterRecipes(
  recipes: Recipe[],
  opts: { q?: string; tag?: string },
): Recipe[] {
  const q = opts.q?.trim().toLowerCase()
  const tag = opts.tag?.trim()
  return recipes.filter(r => {
    if (tag !== undefined && !r.tags.includes(tag)) return false
    if (q) {
      const hitName = r.name.toLowerCase().includes(q)
      const hitIngredient = r.ingredients.some(i => i.name.toLowerCase().includes(q))
      if (!hitName && !hitIngredient) return false
    }
    return true
  })
}
