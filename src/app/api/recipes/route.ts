// 菜谱库 REST API（列表 + 创建）：薄封装 store，解析查询参数后调 Task 3 函数，错误路径统一 { error: 中文文案 }
import { listRecipes, createRecipe, filterRecipes, buildFacets } from '@/lib/recipe-store'
import { validateDraft } from '@/lib/recipe-types'
import type { DraftRecipe, Recipe } from '@/lib/recipe-types'
import { checkBodySize, bodyTooLarge, BODY_LIMIT_BYTES } from '@/lib/body-limit'
import { requireSession } from '@/lib/auth'
import { recipesDirFor } from '@/lib/user-paths'
import { appendAccessLog, clientIpOf } from '@/lib/access-log'

// 读取 JSON body 并用 zod 校验为草稿；解析失败或校验失败返回 null
async function parseDraft(req: Request): Promise<DraftRecipe | null> {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return null
  }
  return validateDraft(body)
}

// GET /api/recipes?q=&category=&tag= → 200 { recipes, invalidFiles, facets }（读操作，方案 A 不记日志）
// facets 供前端渲染「分类 / 标签」两行筛选 chips；tags 随 category 收敛（见 buildFacets 注释）
// listRecipes 非 ENOENT 故障（权限/磁盘等）→ 500 { error: 中文 }（不再静默当空库，误导用户）
export async function GET(req: Request) {
  const auth = await requireSession(req)
  if (!auth.ok) return auth.res
  const dir = recipesDirFor(auth.user.id)
  const url = new URL(req.url)
  const q = url.searchParams.get('q') ?? undefined
  const category = url.searchParams.get('category') ?? undefined
  const tag = url.searchParams.get('tag') ?? undefined
  // route 层与 Task 3 filterRecipes 相同的 trim 语义：空白参数视为未提供
  const qTrimmed = q?.trim() || undefined
  const trimCategory = category?.trim() || undefined
  const trimTag = tag?.trim() || undefined
  let recipes: Recipe[]
  let invalidFiles: string[]
  try {
    const listed = await listRecipes(dir)
    recipes = listed.recipes
    invalidFiles = listed.invalidFiles
  } catch {
    return Response.json({ error: '菜谱库读取失败，请检查服务器 data 目录权限' }, { status: 500 })
  }
  const filtered = filterRecipes(recipes, { q: qTrimmed, category: trimCategory, tag: trimTag })
  // facets 用同一份 listRecipes 快照计算：保证 chips 与实际数据一致（不会因并发改库而错位）
  const facets = buildFacets(recipes, trimCategory)
  // Task 3 invalidFiles 语义偏宽（可能含非 .json 条目），route 层过滤只保留 .json 结尾的条目再返回
  const jsonInvalidFiles = invalidFiles.filter(f => f.endsWith('.json'))
  return Response.json({ recipes: filtered, invalidFiles: jsonInvalidFiles, facets })
}

// POST /api/recipes（body: DraftRecipe）→ 201 Recipe | 400 { error } | 413 | 500 { error }
export async function POST(req: Request) {
  const auth = await requireSession(req)
  if (!auth.ok) return auth.res
  const dir = recipesDirFor(auth.user.id)
  // body 体积前置闸门（审计修复 #4）：content-length 超 1MB 直接 413，不进解析
  if (!checkBodySize(req, BODY_LIMIT_BYTES)) {
    await appendAccessLog({ ip: clientIpOf(req), user: auth.user.name, method: 'POST', path: '/api/recipes', status: 413 })
    return bodyTooLarge()
  }
  const ip = clientIpOf(req)
  const draft = await parseDraft(req)
  if (!draft) {
    await appendAccessLog({ ip, user: auth.user.name, method: 'POST', path: '/api/recipes', status: 400 })
    return Response.json({ error: '请求体不是合法的菜谱草稿' }, { status: 400 })
  }
  // 写盘可能因磁盘满/权限失败（审查修复）：捕获后返回 500 中文错误，
  // 审计按真实结果记录（此前先记 201，写失败也留了一条假的成功记录）
  try {
    const recipe = await createRecipe(draft, dir)
    await appendAccessLog({ ip, user: auth.user.name, method: 'POST', path: '/api/recipes', status: 201 })
    return Response.json(recipe, { status: 201 })
  } catch {
    await appendAccessLog({ ip, user: auth.user.name, method: 'POST', path: '/api/recipes', status: 500 })
    return Response.json({ error: '保存失败：请检查服务器 data 目录权限与磁盘空间' }, { status: 500 })
  }
}
