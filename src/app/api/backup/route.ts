// 备份接口（Task 15，设计 5.8）：GET 导出全部菜谱 / POST 导入备份文件
// GET 契约：200 { exportedAt: string; recipes: Recipe[] }，响应头
//   Content-Disposition: attachment; filename=ai-eat-backup-<YYYYMMDD>.json（触发浏览器下载）
// POST 契约（上游裁定 2）：
//   body { recipes: unknown[] } 顶层经 zod 宽校验（顶层结构错误才 400：缺 recipes 键 / recipes 非数组 / 非法 JSON；
//   顶层多余字段不 400——用户可能从旧版本或手改文件导入，不用 strict 语义卡死整体）
//   数组元素逐条校验：合法 → 按 id 判重，库中无此 id 计入 imported 并 putRecipe 按原 id/时间戳写入；
//   库中已有同 id 计入 skipped 并记 skippedIds；单条 schema 不过计入 invalid 并记 invalidIds
//   → 200 { imported: number; skipped: number; skippedIds: string[]; invalidIds: string[] }
// 错误路径统一 { error: 中文文案 }
import { z } from 'zod'
import { listRecipes, getRecipe, putRecipe } from '@/lib/recipe-store'
import { validateRecipe } from '@/lib/recipe-types'
import type { Recipe } from '@/lib/recipe-types'
import { checkBodySize, bodyTooLarge, BACKUP_BODY_LIMIT_BYTES } from '@/lib/body-limit'
import { requireSession } from '@/lib/auth'
import { recipesDirFor } from '@/lib/user-paths'
import { listUsers } from '@/lib/user-store'
import { appendAccessLog, clientIpOf } from '@/lib/access-log'

// 备份导入条数上限（审计修复 #4）：防御超大备份拖垮逐条导入循环
const BACKUP_MAX_RECIPES = 5000

// 顶层结构 schema：只约束「recipes 键存在且为数组」，元素类型 unknown 交由逐条校验，
// 不加 .strict()——顶层多余字段（如手改文件加的备注键）容忍，不卡死整体
const backupEnvelopeSchema = z.object({
  recipes: z.array(z.unknown()),
})

// 导出文件名日期：本地时区 YYYYMMDD（纯日期展示，无跨时区精确性要求）
function backupDateString(now: Date): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}${m}${d}`
}

// GET /api/backup → 200 { exportedAt; recipes } + attachment 头；菜谱库读取失败 → 500 中文（审计修复 #8）
// GET /api/backup：
// - member / 旧模式 → 200 { exportedAt, recipes }（自己的库，与原契约一致）
// - admin → 200 { exportedAt, users: [{ name, recipes }] }（全部用户；不含任何凭据）
// 读取失败 → 500 中文（审计修复 #8）
export async function GET(req: Request): Promise<Response> {
  const auth = await requireSession(req)
  if (!auth.ok) return auth.res

  const isAdminExport = auth.user.role === 'admin' && !(auth.legacy ?? false)
  if (!isAdminExport) {
    let recipes: Recipe[]
    try {
      recipes = (await listRecipes(recipesDirFor(auth.user.id))).recipes
    } catch {
      return Response.json({ error: '菜谱库读取失败，请检查服务器 data 目录权限' }, { status: 500 })
    }
    return jsonAttachment({ exportedAt: new Date().toISOString(), recipes })
  }

  // 管理员：导出全部用户。任一用户目录读失败不影响其余（记录哪些失败）
  const users = await listUsers()
  const bundles: { name: string; recipes: Recipe[] }[] = []
  const failed: string[] = []
  for (const u of users) {
    try {
      const { recipes } = await listRecipes(recipesDirFor(u.id))
      bundles.push({ name: u.name, recipes })
    } catch {
      failed.push(u.name)
    }
  }
  // 同时带上管理员自己的 recipes（顶层），使导出文件可直接被 POST /api/backup 回灌
  let ownRecipes: Recipe[] = []
  try {
    ownRecipes = (await listRecipes(recipesDirFor(auth.user.id))).recipes
  } catch {
    failed.push(auth.user.name)
  }
  if (failed.length > 0) {
    return Response.json(
      { error: `部分用户菜谱库读取失败：${failed.join('、')}，请检查 data 目录权限` },
      { status: 500 },
    )
  }
  return jsonAttachment({ exportedAt: new Date().toISOString(), recipes: ownRecipes, users: bundles })
}

/** 统一附件响应头（导出文件名带日期） */
function jsonAttachment(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Content-Disposition': `attachment; filename=ai-eat-backup-${backupDateString(new Date())}.json`,
    },
  })
}

// 单条导入结果：imported 表示已入库；skipId 非空表示该条被跳过（冲突或非法），附原因
interface ItemResult {
  imported: boolean
  skipId: string | null
  reason: 'duplicate' | 'invalid' | null
}

// 导入单条：validateRecipe（strict schema）不过 → invalid；
// id 取不到（非法条目无 id 可报）→ 用 #<数组序号> 占位；库中已有同 id → duplicate；
// putRecipe 对穿越 id throw（store 层白名单守卫）→ 捕获计为 invalid，不中断整体导入
async function importOne(item: unknown, index: number, dir: string): Promise<ItemResult> {
  const recipe: Recipe | null = validateRecipe(item)
  if (!recipe) {
    const raw = item as { id?: unknown } | null
    const rawId = typeof raw?.id === 'string' && raw.id !== '' ? raw.id : `#${index}`
    return { imported: false, skipId: rawId, reason: 'invalid' }
  }
  const existing = await getRecipe(recipe.id, dir)
  if (existing) {
    return { imported: false, skipId: recipe.id, reason: 'duplicate' }
  }
  try {
    await putRecipe(recipe, dir)
  } catch {
    return { imported: false, skipId: recipe.id, reason: 'invalid' }
  }
  return { imported: true, skipId: null, reason: null }
}

// POST /api/backup → 逐条导入 → 200 { imported; skipped; skippedIds; invalidIds } | 400 { error } | 413（超 5MB）
// 访问日志（方案 A）：导入是批量写操作，成功/失败都记录
export async function POST(req: Request): Promise<Response> {
  const auth = await requireSession(req)
  if (!auth.ok) return auth.res
  // 导入永远只写自己的库（即使管理员，也不支持把备份灌进别人目录——避免误操作）
  const dir = recipesDirFor(auth.user.id)
  const ip = clientIpOf(req)
  // body 体积前置闸门（审计修复 #4）：备份整库合法体积更大，上限放宽到 5MB
  if (!checkBodySize(req, BACKUP_BODY_LIMIT_BYTES)) return bodyTooLarge()
  let body: unknown
  try {
    body = await req.json()
  } catch {
    await appendAccessLog({ ip, user: auth.user.name, method: 'POST', path: '/api/backup', status: 400 })
    return Response.json({ error: '请求体不是合法 JSON' }, { status: 400 })
  }
  // 顶层宽校验：仅 recipes 键存在且为数组，失败即整体 400（顶层结构错误）
  const parsed = backupEnvelopeSchema.safeParse(body)
  if (!parsed.success) {
    await appendAccessLog({ ip, user: auth.user.name, method: 'POST', path: '/api/backup', status: 400 })
    return Response.json({ error: '备份文件结构非法：缺少 recipes 数组' }, { status: 400 })
  }
  // 条数上限（审计修复 #4）：recipes 超过 5000 条整体 400 中文
  if (parsed.data.recipes.length > BACKUP_MAX_RECIPES) {
    await appendAccessLog({ ip, user: auth.user.name, method: 'POST', path: '/api/backup', status: 400 })
    return Response.json(
      { error: `备份条目过多：最多 ${BACKUP_MAX_RECIPES} 条，当前 ${parsed.data.recipes.length} 条` },
      { status: 400 },
    )
  }

  // 逐条处理：非法条目跳过并报告，不中断整体导入
  const skippedIds: string[] = []
  const invalidIds: string[] = []
  let imported = 0
  let skipped = 0
  for (let i = 0; i < parsed.data.recipes.length; i++) {
    const r = await importOne(parsed.data.recipes[i], i, dir)
    if (r.imported) {
      imported++
    } else {
      skipped++
      if (r.reason === 'duplicate') skippedIds.push(r.skipId as string)
      else invalidIds.push(r.skipId as string)
    }
  }
  // 访问日志：导入完成（imported 计数附在路径尾，一眼看出导入规模）
  await appendAccessLog({ ip, user: auth.user.name, method: 'POST', path: `/api/backup (imported=${imported})`, status: 200 })
  return Response.json({ imported, skipped, skippedIds, invalidIds })
}
