// 菜谱库 REST API（单个资源）：Next 15 动态路由签名，params 为 Promise，薄封装 store
import { getRecipe, updateRecipe, deleteRecipe } from '@/lib/recipe-store'
import { validateDraft } from '@/lib/recipe-types'
import type { DraftRecipe } from '@/lib/recipe-types'
import { requireAuth } from '@/lib/auth'
import { appendAccessLog, clientIpOf } from '@/lib/access-log'
import { timingSafeEqual } from 'node:crypto'

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
  const denied = requireAuth(_req)
  if (denied) return denied
  const { id } = await ctx.params
  const recipe = await getRecipe(id)
  if (!recipe) {
    return Response.json({ error: '菜谱不存在' }, { status: 404 })
  }
  return Response.json(recipe)
}

// PUT /api/recipes/:id（body: DraftRecipe）→ 200 Recipe | 400 { error } | 404 { error }
export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = requireAuth(req)
  if (denied) return denied
  const { id } = await ctx.params
  const draft = await parseDraft(req)
  if (!draft) {
    // 访问日志（方案 A：写操作；400 也如实记录）
    await appendAccessLog({ ip: clientIpOf(req), method: 'PUT', path: `/api/recipes/${id}`, status: 400 })
    return Response.json({ error: '请求体不是合法的菜谱草稿' }, { status: 400 })
  }
  const recipe = await updateRecipe(id, draft)
  // 访问日志：200 更新成功 / 404 菜谱不存在
  await appendAccessLog({ ip: clientIpOf(req), method: 'PUT', path: `/api/recipes/${id}`, status: recipe ? 200 : 404 })
  if (!recipe) {
    return Response.json({ error: '菜谱不存在' }, { status: 404 })
  }
  return Response.json(recipe)
}

// DELETE /api/recipes/:id → 204 无 body | 403 { error }（删除密码校验失败）| 404 { error }
// 删除保护（可选启用）：env DELETE_ENABLED=true 且 DELETE_PASSWORD 非空时，
// 请求必须携带 { deletePassword } 且与服务端值恒时比较通过才能删除；未启用时行为不变
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = requireAuth(req)
  if (denied) return denied
  const ip = clientIpOf(req)
  // 删除保护开关：显式 DELETE_ENABLED=true 且密码非空才启用（两个条件缺一不可，防只配一半半失效）
  const deleteGuardEnabled = process.env.DELETE_ENABLED === 'true' && Boolean(process.env.DELETE_PASSWORD)
  let suppliedPassword: string | undefined
  if (deleteGuardEnabled) {
    // 启用保护时必须读 body 取密码；格式非法按校验失败处理（403 与密码错误同文案，不泄漏具体原因）
    let body: unknown
    try {
      body = await req.json()
    } catch {
      await appendAccessLog({ ip, method: 'DELETE', path: '/api/recipes/:id', status: 403 })
      return Response.json({ error: '删除密码校验失败' }, { status: 403 })
    }
    if (typeof body !== 'object' || body === null) {
      await appendAccessLog({ ip, method: 'DELETE', path: '/api/recipes/:id', status: 403 })
      return Response.json({ error: '删除密码校验失败' }, { status: 403 })
    }
    const b = body as Record<string, unknown>
    if (typeof b.deletePassword !== 'string') {
      await appendAccessLog({ ip, method: 'DELETE', path: '/api/recipes/:id', status: 403 })
      return Response.json({ error: '删除密码校验失败' }, { status: 403 })
    }
    suppliedPassword = b.deletePassword
    // 恒时比较（复用 auth 的 timingSafeEqual 语义，防时序侧信道）
    const expected = process.env.DELETE_PASSWORD ?? ''
    const a = Buffer.from(suppliedPassword, 'utf8')
    const bb = Buffer.from(expected, 'utf8')
    if (a.length !== bb.length || !timingSafeEqual(a, bb)) {
      await appendAccessLog({ ip, method: 'DELETE', path: '/api/recipes/:id', status: 403 })
      return Response.json({ error: '删除密码校验失败' }, { status: 403 })
    }
  }
  const { id } = await ctx.params
  const deleted = await deleteRecipe(id)
  // 访问日志：路径带真实 id（删除的是哪道菜可追溯）；403 的路径不带 id（密码还没验过，id 不可信）
  await appendAccessLog({ ip, method: 'DELETE', path: `/api/recipes/${id}`, status: deleted ? 204 : 404 })
  if (!deleted) {
    return Response.json({ error: '菜谱不存在' }, { status: 404 })
  }
  return new Response(null, { status: 204 })
}
