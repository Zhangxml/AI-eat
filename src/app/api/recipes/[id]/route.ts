// 菜谱库 REST API（单个资源）：Next 15 动态路由签名，params 为 Promise，薄封装 store
import { getRecipe, updateRecipe, deleteRecipe } from '@/lib/recipe-store'
import { validateDraft } from '@/lib/recipe-types'
import type { DraftRecipe } from '@/lib/recipe-types'
import { readJsonBody, BODY_LIMIT_BYTES } from '@/lib/body-limit'
import { requireSession } from '@/lib/auth'
import { recipesDirFor } from '@/lib/user-paths'
import { appendAccessLog, clientIpOf } from '@/lib/access-log'
import { timingSafeEqual } from 'node:crypto'

// 用 zod 校验草稿；结构非法返回 null（JSON 解析与体积上限由 readJsonBody 负责）
function parseDraft(body: unknown): DraftRecipe | null {
  return validateDraft(body)
}

// GET /api/recipes/:id → 200 Recipe | 404 { error }
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireSession(req)
  if (!auth.ok) return auth.res
  const { id } = await ctx.params
  // 按用户目录取：他人菜谱不在本目录 → 自然 404（不暴露存在性）
  const recipe = await getRecipe(id, recipesDirFor(auth.user.id))
  if (!recipe) {
    return Response.json({ error: '菜谱不存在' }, { status: 404 })
  }
  return Response.json(recipe)
}

// PUT /api/recipes/:id（body: DraftRecipe）→ 200 Recipe | 400 | 404 | 413 | 500
export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireSession(req)
  if (!auth.ok) return auth.res
  const dir = recipesDirFor(auth.user.id)
  const { id } = await ctx.params
  const ip = clientIpOf(req)
  // 体积闸门 + JSON 解析（流式累计，chunked 也绕不过）
  const parsed = await readJsonBody(req, BODY_LIMIT_BYTES)
  if (!parsed.ok) {
    await appendAccessLog({ ip, user: auth.user.name, method: 'PUT', path: `/api/recipes/${id}`, status: parsed.response.status })
    return parsed.response
  }
  const draft = parseDraft(parsed.value)
  if (!draft) {
    // 访问日志（方案 A：写操作；400 也如实记录）
    await appendAccessLog({ ip, user: auth.user.name, method: 'PUT', path: `/api/recipes/${id}`, status: 400 })
    return Response.json({ error: '请求体不是合法的菜谱草稿' }, { status: 400 })
  }
  // 写盘失败（权限/磁盘）→ 500 中文错误，审计按真实结果记录（此前该路径完全无审计）
  try {
    const recipe = await updateRecipe(id, draft, dir)
    await appendAccessLog({ ip, user: auth.user.name, method: 'PUT', path: `/api/recipes/${id}`, status: recipe ? 200 : 404 })
    if (!recipe) {
      return Response.json({ error: '菜谱不存在' }, { status: 404 })
    }
    return Response.json(recipe)
  } catch {
    await appendAccessLog({ ip, user: auth.user.name, method: 'PUT', path: `/api/recipes/${id}`, status: 500 })
    return Response.json({ error: '保存失败：请检查服务器 data 目录权限与磁盘空间' }, { status: 500 })
  }
}

// DELETE /api/recipes/:id → 204 无 body | 403 { error }（删除密码校验失败）| 404 { error }
// 删除保护（可选启用）：env DELETE_ENABLED=true 且 DELETE_PASSWORD 非空时，
// 请求必须携带 { deletePassword } 且与服务端值恒时比较通过才能删除；未启用时行为不变
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireSession(req)
  if (!auth.ok) return auth.res
  const dir = recipesDirFor(auth.user.id)
  const ip = clientIpOf(req)
  // 删除保护开关：显式 DELETE_ENABLED=true 且密码非空才启用（两个条件缺一不可，防只配一半半失效）
  const deleteGuardEnabled = process.env.DELETE_ENABLED === 'true' && Boolean(process.env.DELETE_PASSWORD)
  let suppliedPassword: string | undefined
  if (deleteGuardEnabled) {
    // 启用保护时才读 body。体积/JSON 非法一律按「密码校验失败」返回 403（与密码错同文案，不泄漏原因）
    const parsed = await readJsonBody(req, BODY_LIMIT_BYTES)
    if (!parsed.ok) {
      await appendAccessLog({ ip, user: auth.user.name, method: 'DELETE', path: '/api/recipes/:id', status: 403 })
      return Response.json({ error: '删除密码校验失败' }, { status: 403 })
    }
    const body = parsed.value
    if (typeof body !== 'object' || body === null) {
      await appendAccessLog({ ip, user: auth.user.name, method: 'DELETE', path: '/api/recipes/:id', status: 403 })
      return Response.json({ error: '删除密码校验失败' }, { status: 403 })
    }
    const b = body as Record<string, unknown>
    if (typeof b.deletePassword !== 'string') {
      await appendAccessLog({ ip, user: auth.user.name, method: 'DELETE', path: '/api/recipes/:id', status: 403 })
      return Response.json({ error: '删除密码校验失败' }, { status: 403 })
    }
    suppliedPassword = b.deletePassword
    // 恒时比较（复用 auth 的 timingSafeEqual 语义，防时序侧信道）
    const expected = process.env.DELETE_PASSWORD ?? ''
    const a = Buffer.from(suppliedPassword, 'utf8')
    const bb = Buffer.from(expected, 'utf8')
    if (a.length !== bb.length || !timingSafeEqual(a, bb)) {
      await appendAccessLog({ ip, user: auth.user.name, method: 'DELETE', path: '/api/recipes/:id', status: 403 })
      return Response.json({ error: '删除密码校验失败' }, { status: 403 })
    }
  }
  const { id } = await ctx.params
  // 删除失败（权限/IO）→ 500 中文错误；ENOENT 已由 store 返回 false（→404）
  try {
    const deleted = await deleteRecipe(id, dir)
    // 访问日志：路径带真实 id（删除的是哪道菜可追溯）；403 的路径不带 id（密码还没验过，id 不可信）
    await appendAccessLog({ ip, user: auth.user.name, method: 'DELETE', path: `/api/recipes/${id}`, status: deleted ? 204 : 404 })
    if (!deleted) {
      return Response.json({ error: '菜谱不存在' }, { status: 404 })
    }
    return new Response(null, { status: 204 })
  } catch {
    await appendAccessLog({ ip, user: auth.user.name, method: 'DELETE', path: `/api/recipes/${id}`, status: 500 })
    return Response.json({ error: '删除失败：请检查服务器 data 目录权限' }, { status: 500 })
  }
}
