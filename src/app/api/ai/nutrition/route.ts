// POST /api/ai/nutrition：独立营养估算（温度 0.5 求稳，不再为估算营养生成整份菜谱）
// 契约：body { dish?: string; ingredients?: string[]; steps?: string[] }
// → 200 { nutrition } | 400 { error } | 413 { error } | 503 { error } | 502 { error }
import { aiComplete, loadAiConfig, type ChatMessage } from '@/lib/ai-client'
import { extractJson, NUTRITION_FORMAT_RULE } from '@/lib/ai-prompts'
import { validateNutrition, type Nutrition } from '@/lib/recipe-types'
import { readJsonBody, BODY_LIMIT_BYTES } from '@/lib/body-limit'
import { requireSession } from '@/lib/auth'
import { appendAccessLog, clientIpOf } from '@/lib/access-log'
import { resolveTemperature } from '@/lib/ai-temperatures'

const RETRY_HINT = '上次输出无法解析，请严格按格式重发'
const MAX_ITEMS = 50
const MAX_ITEM_CHARS = 500

type NutritionInput = { dish?: string; ingredients?: string[]; steps?: string[] }

// 读取并校验输入：dish 与 ingredients 至少一个；数组元素均为非空字符串，数量/长度有上限。
// 返回 { input } 或 { error } 以便给出准确的 400 文案（泛化成「至少提供一个」会误导用户）
type ParseResult = { input: NutritionInput; error?: never } | { input?: never; error: string }

function parseInput(body: unknown): ParseResult {
  if (typeof body !== 'object' || body === null) return { error: '请求体格式非法' }
  const raw = body as Record<string, unknown>

  const normalizeList = (value: unknown): string[] | null | undefined => {
    if (value === undefined) return undefined
    if (!Array.isArray(value) || value.length > MAX_ITEMS || !value.every(v => typeof v === 'string')) return null
    const list = (value as string[]).map(v => v.trim()).filter(v => v !== '')
    if (list.some(v => v.length > MAX_ITEM_CHARS)) return null
    return list.length > 0 ? list : undefined
  }

  let dish: string | undefined
  if (raw.dish !== undefined) {
    if (typeof raw.dish !== 'string') return { error: 'dish 须为字符串' }
    const trimmed = raw.dish.trim()
    if (trimmed.length > MAX_ITEM_CHARS) return { error: `dish 过长：不超过 ${MAX_ITEM_CHARS} 字符` }
    if (trimmed !== '') dish = trimmed
  }
  const ingredients = normalizeList(raw.ingredients)
  const steps = normalizeList(raw.steps)
  // 分别给出具体原因：泛化成「至少提供一个」会误导（dish 明明已提供，实际是数组超限）
  if (ingredients === null) return { error: `ingredients 非法：最多 ${MAX_ITEMS} 项，每项不超过 ${MAX_ITEM_CHARS} 字符` }
  if (steps === null) return { error: `steps 非法：最多 ${MAX_ITEMS} 项，每项不超过 ${MAX_ITEM_CHARS} 字符` }
  if (!dish && !ingredients) return { error: '菜品信息缺失：dish 与 ingredients 至少提供一个' }
  return { input: { dish, ingredients, steps } }
}

function buildUserMessage(input: NutritionInput): string {
  const parts: string[] = []
  if (input.dish) parts.push(`菜名：${input.dish}`)
  if (input.ingredients) parts.push(`食材：${input.ingredients.join('、')}`)
  if (input.steps) parts.push(`烹饪步骤：${input.steps.join('；')}`)
  parts.push('请估算这道菜的营养数据')
  return parts.join('\n')
}

function parseNutrition(text: string): Nutrition | null {
  return extractJson(text, segment => {
    try {
      return validateNutrition(JSON.parse(segment))
    } catch {
      return null
    }
  })
}

export async function POST(req: Request): Promise<Response> {
  const auth = await requireSession(req)
  if (!auth.ok) return auth.res
  const ip = clientIpOf(req)
  const bodyResult = await readJsonBody(req, BODY_LIMIT_BYTES)
  if (!bodyResult.ok) {
    if (bodyResult.response.status === 413) {
      await appendAccessLog({ ip, user: auth.user.name, method: 'POST', path: '/api/ai/nutrition', status: 413 })
    }
    return bodyResult.response
  }
  const parsed = parseInput(bodyResult.value)
  if (parsed.error !== undefined) {
    await appendAccessLog({ ip, user: auth.user.name, method: 'POST', path: '/api/ai/nutrition', status: 400 })
    return Response.json({ error: parsed.error }, { status: 400 })
  }
  const input = parsed.input

  let cfg
  try {
    cfg = loadAiConfig()
  } catch (e) {
    await appendAccessLog({ ip, user: auth.user.name, method: 'POST', path: '/api/ai/nutrition', status: 503 })
    return Response.json({ error: e instanceof Error ? e.message : 'AI 配置缺失' }, { status: 503 })
  }

  const system: ChatMessage = {
    role: 'system',
    content: [
      '你是一位专业营养师，请根据菜名、食材和烹饪方式估算营养数据。',
      '数据应合理、保守，不能把估算值说成实测值。',
      NUTRITION_FORMAT_RULE,
    ].join('\n'),
  }
  const baseUser: ChatMessage = { role: 'user', content: buildUserMessage(input) }
  const aiOptions = { temperature: resolveTemperature('nutrition') }

  let nutrition: Nutrition | null = null
  let lastError: string | null = null
  try {
    nutrition = parseNutrition(await aiComplete(cfg, [system, baseUser], aiOptions))
  } catch (e) {
    lastError = e instanceof Error ? e.message : String(e)
  }
  if (!nutrition) {
    try {
      nutrition = parseNutrition(
        await aiComplete(cfg, [system, { ...baseUser, content: `${baseUser.content}\n${RETRY_HINT}` }], aiOptions),
      )
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e)
    }
  }
  if (!nutrition) {
    await appendAccessLog({ ip, user: auth.user.name, method: 'POST', path: '/api/ai/nutrition', status: 502 })
    const detail = lastError ? `（${lastError}）` : ''
    return Response.json({ error: `AI 输出两次均无法解析为合法营养数据${detail}` }, { status: 502 })
  }

  await appendAccessLog({ ip, user: auth.user.name, method: 'POST', path: '/api/ai/nutrition', status: 200 })
  return Response.json({ nutrition })
}
