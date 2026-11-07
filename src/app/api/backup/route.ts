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
import { requireAuth } from '@/lib/auth'

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

// GET /api/backup → 200 { exportedAt; recipes } + attachment 头
export async function GET(req: Request): Promise<Response> {
  const denied = requireAuth(req)
  if (denied) return denied
  const { recipes } = await listRecipes()
  const body = JSON.stringify({ exportedAt: new Date().toISOString(), recipes })
  return new Response(body, {
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
async function importOne(item: unknown, index: number): Promise<ItemResult> {
  const recipe: Recipe | null = validateRecipe(item)
  if (!recipe) {
    const raw = item as { id?: unknown } | null
    const rawId = typeof raw?.id === 'string' && raw.id !== '' ? raw.id : `#${index}`
    return { imported: false, skipId: rawId, reason: 'invalid' }
  }
  const existing = await getRecipe(recipe.id)
  if (existing) {
    return { imported: false, skipId: recipe.id, reason: 'duplicate' }
  }
  try {
    await putRecipe(recipe)
  } catch {
    return { imported: false, skipId: recipe.id, reason: 'invalid' }
  }
  return { imported: true, skipId: null, reason: null }
}

// POST /api/backup → 逐条导入 → 200 { imported; skipped; skippedIds; invalidIds } | 400 { error }
export async function POST(req: Request): Promise<Response> {
  const denied = requireAuth(req)
  if (denied) return denied
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: '请求体不是合法 JSON' }, { status: 400 })
  }
  // 顶层宽校验：仅 recipes 键存在且为数组，失败即整体 400（顶层结构错误）
  const parsed = backupEnvelopeSchema.safeParse(body)
  if (!parsed.success) {
    return Response.json({ error: '备份文件结构非法：缺少 recipes 数组' }, { status: 400 })
  }

  // 逐条处理：非法条目跳过并报告，不中断整体导入
  const skippedIds: string[] = []
  const invalidIds: string[] = []
  let imported = 0
  let skipped = 0
  for (let i = 0; i < parsed.data.recipes.length; i++) {
    const r = await importOne(parsed.data.recipes[i], i)
    if (r.imported) {
      imported++
    } else {
      skipped++
      if (r.reason === 'duplicate') skippedIds.push(r.skipId as string)
      else invalidIds.push(r.skipId as string)
    }
  }
  return Response.json({ imported, skipped, skippedIds, invalidIds })
}
