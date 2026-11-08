// POST /api/ai/menu：AI 点菜接口（Task 13，设计 5.2）
// 契约：body { people: number; preference?: string }（people 必填 ≥1 整数，preference 可选口味偏好）
// → 200 { dishes: { name; category: '荤菜'|'素菜'|'汤'|'主食'|'其他'; reason }[]; shopping: string[] }
//   （zod schema 轻量校验，不含步骤；菜单构成考虑人数/荤素搭配/创意方向，库摘要仅防完全重复）
// | 400 { error }（people 缺失/非法）| 503 { error }（AI 未配置，loadAiConfig throw）
// | 502 { error: 'AI 输出两次均无法解析…' }（第一次解析失败重试一次，仍失败才 502，模式与 Task 10 一致）
// 说明：menu 的 zod schema 仅本接口单一消费者，放在 route 文件内，不独立 lib
import { z } from 'zod'
import { loadAiConfig, aiComplete, type ChatMessage } from '@/lib/ai-client'
import { systemPromptWithLibrary, extractJson } from '@/lib/ai-prompts'
import { listRecipes } from '@/lib/recipe-store'
import { readSettings } from '@/lib/settings-store'
import type { Recipe } from '@/lib/recipe-types'
import { checkBodySize, bodyTooLarge, BODY_LIMIT_BYTES } from '@/lib/body-limit'
import { requireAuth } from '@/lib/auth'
import { appendAccessLog, clientIpOf } from '@/lib/access-log'
import { resolveTemperature } from '@/lib/ai-temperatures'
import { pickInspiration, type InspirationStyle } from '@/lib/inspiration'

// 重试提示（第二次请求附在用户消息后；测试断言依赖此文案，与 Task 10/11 同款）
const RETRY_HINT = '上次输出无法解析，请严格按格式重发'

// 入参上限（审查修复）：people 过大或 preference 过长都会把提示词放大到不成比例，
// 直接抬高一次 AI 调用的 token 成本（曾实测 people=1000000 可正常出菜单）
const MAX_PEOPLE = 50
const MAX_TEXT_CHARS = 500

// 菜单项：轻量三字段（不含步骤/食材明细），category 限五枚举，name/reason 必填非空
const dishSchema = z
  .object({
    name: z.string().min(1),
    category: z.enum(['荤菜', '素菜', '汤', '主食', '其他']),
    reason: z.string().min(1),
  })
  .strict()

// 菜单整体：dishes 至少一道（推荐结果不允许为空），shopping 为采购清单字符串数组
const menuSchema = z
  .object({
    dishes: z.array(dishSchema).min(1),
    shopping: z.array(z.string()),
  })
  .strict()

// 解析 AI 输出为合法菜单：extractJson 三形态均可解（<menu> 标签内的 JSON 由全文平衡扫描兜底命中），
// JSON 非法或 zod 校验失败返回 null，不产生半成品
function extractMenuJson(text: string): z.infer<typeof menuSchema> | null {
  return extractJson(text, seg => {
    try {
      const result = menuSchema.safeParse(JSON.parse(seg))
      return result.success ? result.data : null
    } catch {
      return null
    }
  })
}

// 读取 JSON body 并做参数校验；非法返回 null（route 层转 400）
async function parseInput(
  req: Request,
): Promise<{ people: number; preference?: string } | null> {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return null
  }
  if (typeof body !== 'object' || body === null) return null
  const b = body as Record<string, unknown>

  // people：必填正整数，1~MAX_PEOPLE（上限防「people=1e9」生成超长提示词、放大 token 成本）
  if (typeof b.people !== 'number' || !Number.isInteger(b.people) || b.people < 1 || b.people > MAX_PEOPLE) {
    return null
  }

  // preference：可选字符串；提供了但类型非法（非 string）或超长 → 400，不静默丢弃用户意图
  let preference: string | undefined
  if (b.preference !== undefined) {
    if (typeof b.preference !== 'string') return null
    const trimmed = b.preference.trim()
    if (trimmed.length > MAX_TEXT_CHARS) return null
    if (trimmed !== '') preference = trimmed
  }
  return { people: b.people, preference }
}

// 组装用户消息：人数（含份量级提示：people≥4 建议菜数不少于人数）、口味偏好、荤素搭配、
// 风格档位约束（home=经典家常优先 / creative=中式创意）+ 灵感方向。
// 说明：已移除「菜谱库已有菜优先」要求（产品决定）——菜单追求新意，不因库中已有而优先复用。
function buildUserMessage(input: {
  people: number
  preference?: string
  style: InspirationStyle
}): string {
  const parts: string[] = [`今天 ${input.people} 人吃饭`]
  // 份量级提示：人数多时建议菜数水涨船高，避免 AI 只给两三道
  if (input.people >= 4) {
    parts.push(`建议菜数不少于 ${input.people} 道`)
  }
  if (input.preference) {
    parts.push(`口味偏好：${input.preference}`)
  }
  parts.push('请注意荤素搭配，合理组合荤菜、素菜、汤和主食')
  // 风格档位约束（替代早期的反大路菜黑名单——那会把默认输出推向不家常）
  parts.push(
    input.style === 'creative'
      ? '菜单要有新意：避免番茄炒蛋、青椒肉丝、麻婆豆腐、土豆丝等大路菜，优先中式地方风味的特色搭配'
      : '菜品以经典家常菜为主，做法简单、好吃下饭',
  )
  parts.push(pickInspiration(input.style))
  return parts.join('；') + '。'
}

// <menu> 标签输出格式规则（拼进系统提示词；JSON 模板与 extractMenuJson 的 menuSchema 对应）
const MENU_FORMAT_RULE = [
  '输出格式强制要求：你可以先用一两句话介绍，介绍文字之后必须输出一个 <menu> 标签，',
  '标签内放置一份完整的菜单 JSON（不要在 JSON 外再加其他文字），最后以 </menu> 结束。',
  'JSON 字段模板如下：',
  '{',
  '  "dishes": [{ "name": "<菜名>", "category": "<荤菜|素菜|汤|主食|其他 之一>", "reason": "<推荐理由，一两句话>" }],',
  '  "shopping": ["<食材 用量，如：番茄 x2>", "<食材 用量>"]',
  '}',
  'dishes 至少一道；category 只能取 荤菜/素菜/汤/主食/其他 之一；shopping 为合并去重后的采购清单。',
  '完整示例（2 人餐）：',
  '<menu>{"dishes":[{"name":"番茄炒蛋","category":"荤菜","reason":"家常下饭，酸甜开胃"},{"name":"清炒油麦菜","category":"素菜","reason":"清爽解腻"}],"shopping":["番茄 x2","鸡蛋 x3","油麦菜 x1把"]}</menu>',
].join('\n')

// POST handler：参数校验 → 400；AI 配置 → 503；生成+解析（失败重试一次）→ 200/502
// 访问日志（方案 A）：AI 调用是成本敏感操作，成功失败都记录（400/502/503/200）
export async function POST(req: Request): Promise<Response> {
  const denied = requireAuth(req)
  if (denied) return denied
  // body 体积前置闸门（审计修复 #4）：超 1MB 直接 413，不进解析
  if (!checkBodySize(req, BODY_LIMIT_BYTES)) return bodyTooLarge()
  const input = await parseInput(req)
  if (!input) {
    await appendAccessLog({ ip: clientIpOf(req), method: 'POST', path: '/api/ai/menu', status: 400 })
    return Response.json(
      { error: `参数缺失或非法：people 须为 1~${MAX_PEOPLE} 的整数，preference 须为不超过 ${MAX_TEXT_CHARS} 字符的字符串` },
      { status: 400 },
    )
  }

  // 推荐风格档位：全局设置（data/settings.json）决定，前端不再传参
  const style: InspirationStyle = (await readSettings()).style

  // AI 未配置：loadAiConfig throw 中文错误 → 503（env 真实路径，测试只 mock aiComplete）
  let cfg
  try {
    cfg = loadAiConfig()
  } catch (e) {
    await appendAccessLog({ ip: clientIpOf(req), method: 'POST', path: '/api/ai/menu', status: 503 })
    return Response.json({ error: e instanceof Error ? e.message : 'AI 配置缺失' }, { status: 503 })
  }

  // 系统消息 = 人设（含档位）+ 库摘要 + <menu> 格式规则；用户消息 = 人数/偏好/荤素搭配/档位约束/灵感；
  // （「菜谱库已有菜优先」要求已按产品决定移除，库摘要仅用于避免完全重复）
  // 菜谱库读取失败（权限等）→ 500 中文（审计修复 #8）
  let recipes: Recipe[]
  try {
    recipes = (await listRecipes()).recipes
  } catch {
    await appendAccessLog({ ip: clientIpOf(req), method: 'POST', path: '/api/ai/menu', status: 500 })
    return Response.json({ error: '菜谱库读取失败，请检查服务器 data 目录权限' }, { status: 500 })
  }
  const system: ChatMessage = {
    role: 'system',
    content: [systemPromptWithLibrary(recipes, style), MENU_FORMAT_RULE].join('\n'),
  }
  const baseUser: ChatMessage = { role: 'user', content: buildUserMessage({ ...input, style }) }
  // 温度分层：一桌菜单是轻量结构，0.8 略偏创意；解析失败仍有一次重试兜底
  const aiOptions = { temperature: resolveTemperature('menu') }

  // 第一次调用；解析失败（含上游异常）则附重试提示再调一次，两次都失败才 502
  let firstError: string | null = null
  let menu: z.infer<typeof menuSchema> | null = null
  try {
    menu = extractMenuJson(await aiComplete(cfg, [system, baseUser], aiOptions))
  } catch (e) {
    firstError = e instanceof Error ? e.message : String(e)
  }

  if (!menu) {
    const retryUser: ChatMessage = { ...baseUser, content: `${baseUser.content}${RETRY_HINT}` }
    try {
      menu = extractMenuJson(await aiComplete(cfg, [system, retryUser], aiOptions))
    } catch (e) {
      firstError = e instanceof Error ? e.message : String(e)
    }
  }
  if (!menu) {
    // 502 文案带首轮错误详情，便于排查上游异常
    const detail = firstError ? `（${firstError}）` : ''
    await appendAccessLog({ ip: clientIpOf(req), method: 'POST', path: '/api/ai/menu', status: 502 })
    return Response.json({ error: `AI 输出两次均无法解析为合法菜单${detail}` }, { status: 502 })
  }

  // 访问日志：生成成功
  await appendAccessLog({ ip: clientIpOf(req), method: 'POST', path: '/api/ai/menu', status: 200 })

  // 不写盘：直接返回菜单与采购清单，入库由前端自行决定
  return Response.json({ dishes: menu.dishes, shopping: menu.shopping })
}
