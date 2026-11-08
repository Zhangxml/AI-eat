// 菜谱库 REST API（列表 + 创建）：薄封装 store，解析查询参数后调 Task 3 函数，错误路径统一 { error: 中文文案 }
import { listRecipes, createRecipe, filterRecipes } from '@/lib/recipe-store'
import { validateDraft } from '@/lib/recipe-types'
import type { DraftRecipe, Recipe } from '@/lib/recipe-types'
import { checkBodySize, bodyTooLarge, BODY_LIMIT_BYTES } from '@/lib/body-limit'
import { requireAuth } from '@/lib/auth'
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

// GET /api/recipes?q=&tag= → 200 { recipes, invalidFiles }（读操作，方案 A 不记日志）
// listRecipes 非 ENOENT 故障（权限/磁盘等）→ 500 { error: 中文 }（不再静默当空库，误导用户）
export async function GET(req: Request) {
  const denied = requireAuth(req)
  if (denied) return denied
  const url = new URL(req.url)
  const q = url.searchParams.get('q') ?? undefined
  const tag = url.searchParams.get('tag') ?? undefined
  // route 层与 Task 3 filterRecipes 相同的 trim 语义：空白参数视为未提供
  const qTrimmed = q?.trim() || undefined
  const trimTag = tag?.trim() || undefined
  let recipes: Recipe[]
  let invalidFiles: string[]
  try {
    const listed = await listRecipes()
    recipes = listed.recipes
    invalidFiles = listed.invalidFiles
  } catch {
    return Response.json({ error: '菜谱库读取失败，请检查服务器 data 目录权限' }, { status: 500 })
  }
  const filtered = filterRecipes(recipes, { q: qTrimmed, tag: trimTag })
  // Task 3 invalidFiles 语义偏宽（可能含非 .json 条目），route 层过滤只保留 .json 结尾的条目再返回
  const jsonInvalidFiles = invalidFiles.filter(f => f.endsWith('.json'))
  return Response.json({ recipes: filtered, invalidFiles: jsonInvalidFiles })
}

// POST /api/recipes（body: DraftRecipe）→ 201 Recipe | 400 { error } | 413 { error }（超 1MB）
export async function POST(req: Request) {
  const denied = requireAuth(req)
  if (denied) return denied
  // body 体积前置闸门（审计修复 #4）：content-length 超 1MB 直接 413，不进解析
  if (!checkBodySize(req, BODY_LIMIT_BYTES)) return bodyTooLarge()
  const draft = await parseDraft(req)
  // 访问日志（方案 A：写操作记录；路径不含查询串）。await 但失败已被 access-log 内部吞掉，不影响主流程
  await appendAccessLog({ ip: clientIpOf(req), method: 'POST', path: '/api/recipes', status: draft ? 201 : 400 })
  if (!draft) {
    return Response.json({ error: '请求体不是合法的菜谱草稿' }, { status: 400 })
  }
  const recipe = await createRecipe(draft)
  return Response.json(recipe, { status: 201 })
}
