// POST /api/ai/menu：AI 点菜接口（Task 13，设计 5.2）
// 契约：body { people: number; days?: number; preference?: string }（people 必填 1~50；days 可选 1~7 缺省 1；preference 可选）
// → 200 { dishes: { name; category: '荤菜'|'素菜'|'汤'|'主食'|'其他'; reason }[]; shopping: { group; items[] }[] }
//   （zod schema 轻量校验，不含步骤；菜单构成考虑人数/荤素搭配/创意方向，库摘要仅防完全重复）
// | 400 { error }（people 缺失/非法）| 503 { error }（AI 未配置，loadAiConfig throw）
// | 502 { error: 'AI 输出两次均无法解析…' }（第一次解析失败重试一次，仍失败才 502，模式与 Task 10 一致）
// 说明：menu 的 zod schema 仅本接口单一消费者，放在 route 文件内，不独立 lib
import { z } from 'zod'
import { loadAiConfig, aiComplete, type ChatMessage } from '@/lib/ai-client'
import { systemPromptWithLibrary, extractJson, MENU_FORMAT_RULE, SHOPPING_GROUPS } from '@/lib/ai-prompts'
import { listRecipes } from '@/lib/recipe-store'
import { readSettings } from '@/lib/settings-store'
import type { Recipe } from '@/lib/recipe-types'
import { checkBodySize, bodyTooLarge, BODY_LIMIT_BYTES } from '@/lib/body-limit'
import { requireSession } from '@/lib/auth'
import { recipesDirFor } from '@/lib/user-paths'
import { appendAccessLog, clientIpOf } from '@/lib/access-log'
import { resolveTemperature } from '@/lib/ai-temperatures'
import { pickInspiration, type InspirationStyle } from '@/lib/inspiration'
// 人数/天数/偏好上限与点菜页共用同一份定义（前端先拦一次，服务端独立校验，口径不漂移）
import { MAX_DAYS, MAX_PEOPLE, MAX_TEXT_CHARS } from '@/lib/menu-form'

// 重试提示（第二次请求附在用户消息后；测试断言依赖此文案，与 Task 10/11 同款）
const RETRY_HINT = '上次输出无法解析，请严格按格式重发'

// 入参上限（审查修复）：people 过大或 preference 过长都会把提示词放大到不成比例，
// 直接抬高一次 AI 调用的 token 成本（曾实测 people=1000000 可正常出菜单）
// 菜数指引：每天约 3 道（荤/素+汤/主食的自然组合），封顶 21 道防质量下滑
const DISHES_PER_DAY = 3
const MAX_DISHES = 21

// 菜单项：轻量三字段（不含步骤/食材明细），category 限五枚举，name/reason 必填非空。
// 不用 .strict()：模型偶尔自作主张加字段（difficulty/servings 等），zod 默认会剥离未知键，
// 认得的三字段仍照常校验。若用 strict，一个多余键会让整份 7 天菜单作废并重试
// （代价 35 秒 + 3.5k tokens），风险与收益不对称。缺必填字段仍会被拒（结构错误不放行）。
const dishSchema = z.object({
  name: z.string().min(1),
  category: z.enum(['荤菜', '素菜', '汤', '主食', '其他']),
  reason: z.string().min(1),
})

// 合并同名分组（模型偶尔把同一品类拆成多段）：保留首次出现顺序，items 顺序拼接。
// 必要性：前端以 group 作为 React key，同名分组会产生重复 key（reconciliation 异常 + 控制台告警），
// 且同一品类分散多处也不利于照着买。
function mergeShoppingGroups(groups: { group: string; items: string[] }[]): {
  group: string
  items: string[]
}[] {
  const order: string[] = []
  const itemsByGroup = new Map<string, string[]>()
  for (const g of groups) {
    if (g.items.length === 0) continue // 空分组不展示
    const existing = itemsByGroup.get(g.group)
    if (existing) {
      existing.push(...g.items)
    } else {
      itemsByGroup.set(g.group, [...g.items])
      order.push(g.group)
    }
  }
  return order.map(group => ({ group, items: itemsByGroup.get(group) as string[] }))
}

// 采购清单：新格式为分组数组；同时兼容模型退回旧的扁平字符串数组（归一化为单组「采购清单」）。
// 容错放在解析层而非重试层——旧格式本身是合法输出，不该因结构差异浪费一次 AI 调用。
const shoppingSchema = z.union([
  z
    .array(z.string())
    .transform(items => (items.length > 0 ? [{ group: '采购清单', items }] : [])),
  z
    .array(z.object({
      group: z.string().min(1),
      items: z.array(z.string()),
    }))
    .transform(groups => mergeShoppingGroups(groups)),
])

// 菜单整体：dishes 至少一道（推荐结果不允许为空），shopping 为分组采购清单
const menuSchema = z.object({
  dishes: z.array(dishSchema).min(1),
  shopping: shoppingSchema,
})

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
): Promise<{ people: number; days: number; preference?: string } | null> {
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

  // days：可选用餐天数，缺省 1；硬上限 MAX_DAYS（天数过大 → 菜数与输出 token 成倍膨胀）。
  // 提供了但非法（非 1~MAX_DAYS 整数）→ 400，不静默收敛成 1（避免用户以为买了 7 天的量）
  let days = 1
  if (b.days !== undefined) {
    if (typeof b.days !== 'number' || !Number.isInteger(b.days) || b.days < 1 || b.days > MAX_DAYS) {
      return null
    }
    days = b.days
  }

  // preference：可选字符串；提供了但类型非法（非 string）或超长 → 400，不静默丢弃用户意图
  let preference: string | undefined
  if (b.preference !== undefined) {
    if (typeof b.preference !== 'string') return null
    const trimmed = b.preference.trim()
    if (trimmed.length > MAX_TEXT_CHARS) return null
    if (trimmed !== '') preference = trimmed
  }
  return { people: b.people, days, preference }
}

// 组装用户消息：人数/天数（含菜数指引）、口味偏好、荤素搭配、风格档位约束、采购总量基准、灵感方向。
// 说明：已移除「菜谱库已有菜优先」要求（产品决定）——菜单追求新意，不因库中已有而优先复用。
// days=1 保持原有文案（不出现天数/采购基准），保证「按一餐点菜」的行为与改造前完全一致。
function buildUserMessage(input: {
  people: number
  days: number
  preference?: string
  style: InspirationStyle
}): string {
  const multiDay = input.days > 1
  const parts: string[] = [
    multiDay ? `今天 ${input.people} 人吃饭，要买 ${input.days} 天的菜` : `今天 ${input.people} 人吃饭`,
  ]
  if (multiDay) {
    // 菜数指引：约 3 道/天，封顶 21 道；不按天排（真实买菜是买一批、每天看冰箱决定吃什么）
    const target = Math.min(input.days * DISHES_PER_DAY, MAX_DISHES)
    parts.push(`建议菜数约 ${target} 道，覆盖这 ${input.days} 天（不必按天排列，给足可挑选的菜即可）`)
  } else if (input.people >= 4) {
    // 份量级提示：人数多时建议菜数水涨船高，避免 AI 只给两三道
    parts.push(`建议菜数不少于 ${input.people} 道`)
  }
  if (input.preference) {
    parts.push(`口味偏好：${input.preference}`)
  }
  parts.push('请注意荤素搭配，合理组合荤菜、素菜、汤和主食')
  // 风格档位约束（替代早期的反大路菜黑名单——那会把默认输出推向不家常）；home=湖北家常
  parts.push(
    input.style === 'creative'
      ? '菜单要有新意：避免番茄炒蛋、青椒肉丝、麻婆豆腐、土豆丝等大路菜，优先中式地方风味的特色搭配'
      : '菜品以湖北家常菜为主：多用粉蒸、煨汤、腊味，常见藕与鱼鲜，做法简单、好吃下饭',
  )
  if (multiDay) {
    // 采购清单按「人数 × 天数」估算总量，并给出人均日消耗基准（不让模型瞎猜）
    parts.push(
      `采购清单按 ${input.people} 人 ${input.days} 天的总消耗量估算，按品类分组` +
        `（${SHOPPING_GROUPS.join('/')}）；用量折算成好买的单位（斤/把/盒/袋），四舍五入到整数；` +
        '易坏食材注明「建议几天内先吃」，耐存食材注明「可冷冻/久放」；' +
        '调料只列需要补货的，不要罗列盐糖油等家里常备的',
    )
    parts.push(
      '人均日消耗基准：肉类 150~200g、蔬菜 300~500g、蛋 1 个、主食 200~300g（按此折算总量）',
    )
  }
  parts.push(pickInspiration(input.style))
  return parts.join('；') + '。'
}

// POST handler：参数校验 → 400；AI 配置 → 503；生成+解析（失败重试一次）→ 200/502
// 访问日志（方案 A）：AI 调用是成本敏感操作，成功失败都记录（400/502/503/200）
export async function POST(req: Request): Promise<Response> {
  const auth = await requireSession(req)
  if (!auth.ok) return auth.res
  const dir = recipesDirFor(auth.user.id)
  // body 体积前置闸门（审计修复 #4）：超 1MB 直接 413，不进解析
  if (!checkBodySize(req, BODY_LIMIT_BYTES)) return bodyTooLarge()
  const input = await parseInput(req)
  if (!input) {
    await appendAccessLog({ ip: clientIpOf(req), user: auth.user.name, method: 'POST', path: '/api/ai/menu', status: 400 })
    return Response.json(
      { error: `参数缺失或非法：people 须为 1~${MAX_PEOPLE} 的整数，days 须为 1~${MAX_DAYS} 的整数，preference 须为不超过 ${MAX_TEXT_CHARS} 字符的字符串` },
      { status: 400 },
    )
  }

  // 推荐风格档位：全局设置（data/settings.json）决定，前端不再传参
  const style: InspirationStyle = (await readSettings(auth.user.id)).style

  // AI 未配置：loadAiConfig throw 中文错误 → 503（env 真实路径，测试只 mock aiComplete）
  let cfg
  try {
    cfg = loadAiConfig()
  } catch (e) {
    await appendAccessLog({ ip: clientIpOf(req), user: auth.user.name, method: 'POST', path: '/api/ai/menu', status: 503 })
    return Response.json({ error: e instanceof Error ? e.message : 'AI 配置缺失' }, { status: 503 })
  }

  // 系统消息 = 人设（含湖北家常/中餐档位）+ 库摘要 + <menu> 格式规则；用户消息 = 人数/偏好/荤素搭配/档位约束/灵感；
  // （「菜谱库已有菜优先」要求已按产品决定移除，库摘要仅用于避免完全重复）
  // 菜谱库读取失败（权限等）→ 500 中文（审计修复 #8）
  let recipes: Recipe[]
  try {
    recipes = (await listRecipes(dir)).recipes
  } catch {
    await appendAccessLog({ ip: clientIpOf(req), user: auth.user.name, method: 'POST', path: '/api/ai/menu', status: 500 })
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
    await appendAccessLog({ ip: clientIpOf(req), user: auth.user.name, method: 'POST', path: '/api/ai/menu', status: 502 })
    return Response.json({ error: `AI 输出两次均无法解析为合法菜单${detail}` }, { status: 502 })
  }

  // 访问日志：生成成功
  await appendAccessLog({ ip: clientIpOf(req), user: auth.user.name, method: 'POST', path: '/api/ai/menu', status: 200 })

  // 不写盘：直接返回菜单与采购清单，入库由前端自行决定
  return Response.json({ dishes: menu.dishes, shopping: menu.shopping })
}
