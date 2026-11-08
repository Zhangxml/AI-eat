// POST /api/ai/recipes：AI 结构化菜谱生成（Task 10，设计 5.2/5.3）
// 契约：body { ingredients?: string[]; dish?: string; servings?: number }，ingredients 与 dish 至少一个
// → 200 { recipe: Recipe }（不写盘，入库由前端 POST /api/recipes 完成）
// | 400 { error }（参数缺失/非法）| 503 { error }（AI 未配置，loadAiConfig throw）
// | 502 { error: 'AI 输出两次均无法解析…' }（第一次解析失败重试一次，仍失败才 502）
import { loadAiConfig, aiComplete, type ChatMessage } from '@/lib/ai-client'
import { systemPromptWithLibrary, RECIPE_FORMAT_RULE, extractRecipeJson } from '@/lib/ai-prompts'
import { listRecipes } from '@/lib/recipe-store'
import { makeRecipeId, type Recipe } from '@/lib/recipe-types'
import { checkBodySize, bodyTooLarge, BODY_LIMIT_BYTES } from '@/lib/body-limit'
import { requireAuth } from '@/lib/auth'
import { appendAccessLog, clientIpOf } from '@/lib/access-log'
import { resolveTemperature } from '@/lib/ai-temperatures'
import { pickInspiration } from '@/lib/inspiration'

// 重试提示（第二次请求附在用户消息后；测试断言依赖此文案）
const RETRY_HINT = '上次输出无法解析，请严格按格式重发'

// 入参上限（审查修复）：食材条数/单项长度/菜名长度/份数都直接进提示词，
// 不设上限时超长输入会把单次调用成本放大（chat 与 nutrition 早已有限制，这里补齐）
const MAX_LIST_ITEMS = 50
const MAX_TEXT_CHARS = 500
const MAX_SERVINGS = 50

// 读取 JSON body 并做参数校验；非法返回 null（route 层转 400）
async function parseInput(
  req: Request,
): Promise<{ ingredients?: string[]; dish?: string; servings?: number } | null> {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return null
  }
  if (typeof body !== 'object' || body === null) return null
  const b = body as Record<string, unknown>

  // ingredients：可选字符串数组（每项 trim 后须非空；整体 trim 后全空视为未提供）
  // 上限（审查修复）：数组过长或单元素过长会把提示词放大，直接抬高 token 成本
  let ingredients: string[] | undefined
  if (b.ingredients !== undefined) {
    if (!Array.isArray(b.ingredients) || !b.ingredients.every(i => typeof i === 'string')) {
      return null
    }
    const trimmed = (b.ingredients as string[]).map(s => s.trim()).filter(s => s !== '')
    if (trimmed.length > MAX_LIST_ITEMS) return null
    if (trimmed.some(s => s.length > MAX_TEXT_CHARS)) return null
    if (trimmed.length > 0) ingredients = trimmed
  }

  // dish：可选非空字符串，超长拒绝
  let dish: string | undefined
  if (typeof b.dish === 'string') {
    const trimmed = b.dish.trim()
    if (trimmed.length > MAX_TEXT_CHARS) return null
    if (trimmed !== '') dish = trimmed
  }

  // servings：可选正整数，1~MAX_SERVINGS
  let servings: number | undefined
  if (b.servings !== undefined) {
    if (
      typeof b.servings !== 'number' ||
      !Number.isInteger(b.servings) ||
      b.servings < 1 ||
      b.servings > MAX_SERVINGS
    ) {
      return null
    }
    servings = b.servings
  }

  // ingredients 与 dish 至少一个非空，否则 400
  if (ingredients === undefined && dish === undefined) return null
  return { ingredients, dish, servings }
}

// 组装用户消息：食材/菜名/份量拼装
function buildUserMessage(input: {
  ingredients?: string[]
  dish?: string
  servings?: number
}): string {
  const parts: string[] = []
  if (input.ingredients) {
    parts.push(`现有食材：${input.ingredients.join('、')}，请推荐可用这些食材做的菜谱`)
  }
  if (input.dish) {
    parts.push(`我想做：${input.dish}`)
  }
  parts.push(input.servings ? `份数：${input.servings} 人份` : '份数：默认 2 人份')
  return parts.join('；') + '。'
}

// POST handler：参数校验 → 400；AI 配置 → 503；生成+解析（失败重试一次）→ 200/502
// 访问日志（方案 A）：AI 调用是成本敏感操作，成功失败都记录（400/502/503/200）
export async function POST(req: Request): Promise<Response> {
  const denied = requireAuth(req)
  if (denied) return denied
  // body 体积前置闸门（审计修复 #4）：超 1MB 直接 413，不进解析
  if (!checkBodySize(req, BODY_LIMIT_BYTES)) return bodyTooLarge()
  const input = await parseInput(req)
  if (!input) {
    await appendAccessLog({ ip: clientIpOf(req), method: 'POST', path: '/api/ai/recipes', status: 400 })
    return Response.json(
      {
        error: `参数缺失或非法：ingredients（≤${MAX_LIST_ITEMS} 项、每项 ≤${MAX_TEXT_CHARS} 字符）与 dish（≤${MAX_TEXT_CHARS} 字符）至少提供一个，servings 须为 1~${MAX_SERVINGS} 的整数`,
      },
      { status: 400 },
    )
  }

  // AI 未配置：loadAiConfig throw 中文错误 → 503（env 真实路径，测试只 mock aiComplete）
  let cfg
  try {
    cfg = loadAiConfig()
  } catch (e) {
    await appendAccessLog({ ip: clientIpOf(req), method: 'POST', path: '/api/ai/recipes', status: 503 })
    return Response.json({ error: e instanceof Error ? e.message : 'AI 配置缺失' }, { status: 503 })
  }

  // 系统消息 = 人设 + 库摘要 + 格式规则；用户消息 = 食材/菜名/份量拼装；
  // 菜谱库读取失败（权限等）→ 500 中文（审计修复 #8）
  let recipes: Recipe[]
  try {
    recipes = (await listRecipes()).recipes
  } catch {
    await appendAccessLog({ ip: clientIpOf(req), method: 'POST', path: '/api/ai/recipes', status: 500 })
    return Response.json({ error: '菜谱库读取失败，请检查服务器 data 目录权限' }, { status: 500 })
  }
  const system: ChatMessage = {
    role: 'system',
    content: [systemPromptWithLibrary(recipes), RECIPE_FORMAT_RULE].join('\n'),
  }
  // 有食材、未指定菜名时才加灵感种子：帮助跳出固定搭配；用户明确指定菜名时严格按菜名生成，不跑偏。
  const inspiration = input.ingredients && !input.dish ? `；${pickInspiration()}（合理范围内参考，不必硬套）` : ''
  const baseUser: ChatMessage = { role: 'user', content: `${buildUserMessage(input)}${inspiration}` }
  // 温度分层：完整菜谱字段多，固定 0.7 优先保证结构化 JSON 成功率。
  const aiOptions = { temperature: resolveTemperature('recipe') }

  // 第一次调用；解析失败（含上游异常）则附重试提示再调一次，两次都失败才 502
  let firstError: string | null = null
  let recipe: Recipe | null = null
  try {
    recipe = extractRecipeJson(await aiComplete(cfg, [system, baseUser], aiOptions))
  } catch (e) {
    firstError = e instanceof Error ? e.message : String(e)
  }

  if (!recipe) {
    const retryUser: ChatMessage = { ...baseUser, content: `${baseUser.content}${RETRY_HINT}` }
    try {
      recipe = extractRecipeJson(await aiComplete(cfg, [system, retryUser], aiOptions))
    } catch (e) {
      firstError = e instanceof Error ? e.message : String(e)
    }
  }
  if (!recipe) {
    // 502 文案带首轮错误详情，便于排查上游异常
    const detail = firstError ? `（${firstError}）` : ''
    await appendAccessLog({ ip: clientIpOf(req), method: 'POST', path: '/api/ai/recipes', status: 502 })
    return Response.json({ error: `AI 输出两次均无法解析为合法菜谱${detail}` }, { status: 502 })
  }

  // 硬条件：AI 可能照抄提示词示例的 id/时间戳（r-1730000000-ab12cd 能过 strict schema 校验），
  // 因此解析成功后必须无条件覆写三字段 + 强制 source='ai'，AI 提供的这三字段只当格式合规信号
  recipe.id = makeRecipeId()
  const now = new Date().toISOString()
  recipe.createdAt = now
  recipe.updatedAt = now
  recipe.source = 'ai'

  // 访问日志：生成成功
  await appendAccessLog({ ip: clientIpOf(req), method: 'POST', path: '/api/ai/recipes', status: 200 })

  // 不写盘：直接返回 recipe，入库由前端 POST /api/recipes 完成
  return Response.json({ recipe })
}
