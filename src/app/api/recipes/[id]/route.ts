// 菜谱库 REST API（单个资源）：Next 15 动态路由签名，params 为 Promise，薄封装 store
import { getRecipe, updateRecipe, deleteRecipe } from '@/lib/recipe-store'
import { validateDraft } from '@/lib/recipe-types'
import type { DraftRecipe } from '@/lib/recipe-types'

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

// GET /api/recipes/:id → 200 Recipe | 404 { error }
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const recipe = await getRecipe(id)
  if (!recipe) {
    return Response.json({ error: '菜谱不存在' }, { status: 404 })
  }
  return Response.json(recipe)
}

// PUT /api/recipes/:id（body: DraftRecipe）→ 200 Recipe | 400 { error } | 404 { error }
export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const draft = await parseDraft(req)
  if (!draft) {
    return Response.json({ error: '请求体不是合法的菜谱草稿' }, { status: 400 })
  }
  const recipe = await updateRecipe(id, draft)
  if (!recipe) {
    return Response.json({ error: '菜谱不存在' }, { status: 404 })
  }
  return Response.json(recipe)
}

// DELETE /api/recipes/:id → 204 无 body | 404 { error }
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const deleted = await deleteRecipe(id)
  if (!deleted) {
    return Response.json({ error: '菜谱不存在' }, { status: 404 })
  }
  return new Response(null, { status: 204 })
}
