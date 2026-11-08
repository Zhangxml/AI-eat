// AI 提示词组装与结构化输出解析（Task 9，设计 5.2/5.3）
// 被 T10/T11/T13 三个 AI 接口消费：
// - systemPromptWithLibrary：中文人设 + 库摘要注入（仅防完全重复，不设已有菜优先级）
// - RECIPE_FORMAT_RULE：结构化输出格式约束（<recipe>{完整JSON}</recipe>），内嵌 5.3 番茄炒蛋示例
// - extractJson：平衡花括号扫描取首个完整 {...} 段（不用正则贪婪匹配——嵌套对象会出错）
// - extractRecipeJson：extractJson + validateRecipe，三形态（标签/栅栏/裸 JSON）均可解
import type { Recipe } from './recipe-types'
import { validateRecipe } from './recipe-types'

// extractRecipeJson = extractJson + validateRecipe：T10/T11/T13 的统一出口。
// 三形态均可解（<recipe> 标签包裹、markdown 代码栅栏包裹、前后杂文本裸 JSON）。
// 内部完成 JSON.parse（平衡扫描得到的是文本段）→ validateRecipe 完整 schema 校验；
// 文本段非法 JSON 或校验失败（字段缺失/类型错/多余字段）均返回 null，不产生半成品对象。
// 注：按完整 schema（recipeSchema）校验，id/时间戳由模型照示例输出（Task 10 侧「id/时间戳已补」由其自行保障）
export function extractRecipeJson(text: string): Recipe | null {
  return extractJson(text, seg => {
    try {
      return validateRecipe(JSON.parse(seg))
    } catch {
      return null
    }
  })
}

// 聊天内推荐清单 schema 与提取：{ dishes: [{ name, ingredient, reason }] }（zod 校验，轻量无步骤）。
// 与买什么接口的 menuSchema 不同：无 category/shopping，多 ingredient（主角食材，与用户输入联动）。
export interface ChatMenuDish {
  name: string
  ingredient: string
  reason: string
}

export interface ChatMenu {
  dishes: ChatMenuDish[]
}

// 提取 <menu>{JSON}</menu>（或裸 JSON/栅栏兜底）并校验；失败返回 null。
// 复用 extractJson 的三形态候选（标签正则按 <menu> 字面量新起一组），逐段尝试首个可解析段。
export function extractChatMenuJson(text: string): ChatMenu | null {
  const candidates: string[] = []
  const tagRe = /<menu>([\s\S]*?)<\/menu>/g
  for (const m of text.matchAll(tagRe)) candidates.push(m[1])
  // 栅栏与裸 JSON 兜底直接复用平衡扫描：从全文取所有顶层平衡段作为候选
  let cursor = 0
  while (true) {
    const start = text.indexOf('{', cursor)
    if (start === -1) break
    const seg = balancedJsonSegment(text, cursor)
    if (seg === null) break
    candidates.push(seg)
    cursor = start + seg.length
  }
  const dishShape = (v: unknown): ChatMenuDish | null => {
    if (typeof v !== 'object' || v === null) return null
    const o = v as Record<string, unknown>
    if (typeof o.name !== 'string' || o.name.trim() === '') return null
    if (typeof o.ingredient !== 'string' || o.ingredient.trim() === '') return null
    if (typeof o.reason !== 'string' || o.reason.trim() === '') return null
    return { name: o.name, ingredient: o.ingredient, reason: o.reason }
  }
  for (const seg of candidates) {
    try {
      const parsed: unknown = JSON.parse(seg)
      if (typeof parsed !== 'object' || parsed === null) continue
      const dishesRaw = (parsed as Record<string, unknown>).dishes
      if (!Array.isArray(dishesRaw) || dishesRaw.length === 0) continue
      const dishes = dishesRaw.map(dishShape)
      if (dishes.some(d => d === null)) continue
      return { dishes: dishes as ChatMenuDish[] }
    } catch {
      continue
    }
  }
  return null
}

// 系统提示词：人设 + 库摘要段（仅作防重复参考，不设优先级）+ 创意约束
export function systemPromptWithLibrary(recipes: Recipe[]): string {
  const lines: string[] = [
    '你是一个中餐家常菜 AI 菜谱助手，专门帮助用户解决「今天吃什么」的问题：可以按现有食材生成菜谱、',
    '根据人数和口味点菜搭配、回答烹饪相关问题。回答要实用、口语化，步骤清晰可操作。',
    '推荐时尽量给出有新意的搭配，避免总用最常见的大路菜；同一食材可以尝试不同做法。',
  ]
  if (recipes.length === 0) {
    lines.push('菜谱库为空。', '你生成的菜谱后续会被用户存入菜谱库。')
    return lines.join('\n')
  }
  lines.push(
    '用户有一个菜谱库，里面已有的菜如下（格式：名称｜食材:食材名列表）：',
    ...recipes.map(r => `${r.name}｜食材:${r.ingredients.map(i => i.name).join(',')}`),
    '以上清单仅供参考：避免推荐与库中完全相同的菜即可，不必优先推荐库中已有的菜。',
  )
  return lines.join('\n')
}

// 结构化输出格式规则（T10/T11/T13 拼进系统提示词）：
// 介绍文字后必须输出 <recipe>{完整 JSON}</recipe>；字段模板与示例照设计文档 5.3；
// source 恒为 "ai"；营养为估算值（estimated 恒 true）。示例 JSON 可被本模块 extractRecipeJson 完整解出（单测保障）
export const RECIPE_FORMAT_RULE = [
  '输出格式强制要求：你可以先用一两句话介绍，介绍文字之后必须输出一个 <recipe> 标签，',
  '标签内放置一份完整的菜谱 JSON（不要在 JSON 外再加其他文字），最后以 </recipe> 结束。',
  'JSON 字段模板如下（所有字段都必须出现）：',
  '{',
  '  "id": "<菜谱id，格式 r-<毫秒时间戳>-<6位hex>>",',
  '  "name": "<菜名>",',
  '  "category": "<荤菜|素菜|汤|主食|其他 之一>",',
  '  "servings": <份数，正整数>,',
  '  "difficulty": "<难度，如 简单>",',
  '  "totalTimeMin": <总耗时分钟数，正整数>,',
  '  "tags": ["<标签>"],',
  '  "ingredients": [{ "name": "<食材名>", "amount": "<用量>" }],',
  '  "steps": ["<步骤>", "<步骤>"],',
  '  "nutrition": { "caloriesKcal": <千卡>, "proteinG": <克>, "fatG": <克>, "carbG": <克>, "estimated": true },',
  '  "source": "ai",',
  '  "createdAt": "<ISO 8601 时间，如 2026-11-07T12:00:00.000Z>",',
  '  "updatedAt": "<ISO 8601 时间，同 createdAt>"',
  '}',
  '其中 "source" 恒为 "ai"；"nutrition.estimated" 恒为 true（营养均为估算值，非实测）。',
  '完整示例（番茄炒蛋）：',
  '<recipe>{"id":"r-1730000000-ab12cd","name":"番茄炒蛋","category":"荤菜","servings":2,"difficulty":"简单","totalTimeMin":20,"tags":["家常菜","快手菜"],"ingredients":[{"name":"番茄","amount":"2个（约300g）"},{"name":"鸡蛋","amount":"3个"}],"steps":["番茄切块……","热锅下油……"],"nutrition":{"caloriesKcal":180,"proteinG":8,"fatG":10,"carbG":12,"estimated":true},"source":"ai","createdAt":"2026-11-07T12:00:00.000Z","updatedAt":"2026-11-07T12:00:00.000Z"}</recipe>',
].join('\n')

// 聊天内食材推荐清单格式规则（chat 接口专用）：用户给出食材时输出 <menu> 清单而非直接生成完整菜谱。
// 与买什么（/api/ai/menu）的区别：这边有食材输入——每道菜标注主角食材，菜数由食材自然搭配决定
// （可合并成一道菜，不要求菜数等于食材数；每种主要食材都要在推荐里有用途）；
// 那边无食材——按人数配一桌菜 + 采购清单。清单确认后由前端逐菜调 /api/ai/recipes 生成完整菜谱。
export const CHAT_MENU_FORMAT_RULE = [
  '回答规则：',
  '- 当用户列出一种或多种食材、想用来做菜时：先用一两句话说明搭配思路，然后输出一个 <menu> 标签，',
  '  标签内为 JSON（不要在 JSON 外再加其他文字），最后以 </menu> 结束。JSON 格式：',
  '  {"dishes":[{"name":"<菜名>","ingredient":"<该菜主要使用的食材>","reason":"<推荐理由，一两句话>"}]}',
  '  dishes 的数量由食材的自然搭配决定，不要为了凑数量而硬拆菜：',
  '  首轮清单需让每种主要食材都有用途（作为某道菜的主料或重要配料）；',
  '  能自然搭配成一道菜的食材可以合并（例如只有番茄和鸡蛋时，推荐番茄炒蛋即可，不必拆成两道）；',
  '  如果这些食材本身就是一道菜的完整搭配，就只推荐这一道，不要为了多给选择而再造一道；',
  '  只有在搭配合理、确实还想再吃一道时才增加菜品。',
  '  可少量使用用户未列出的常见辅料（葱姜蒜、调味料等），但主角应是用户提供的食材。',
  '  为每种食材给出不常见但有依据的做法（例如番茄可做番茄炖牛腩/番茄啫啫煲，而不只是番茄炒蛋）；',
  '  避免与对话历史中已推荐过的菜重复。',
  '  在 reason 中说明该菜用到了哪些用户提供的食材，便于用户核对没有遗漏。',
  '  当用户说「继续」「再来几道」「还有别的吗」时：只推荐此前尚未推荐过的新菜（菜品名不得重复，这是第一约束）；',
  '  若某些食材尚未用到，可在搭配自然的前提下优先考虑（次要偏好，不要生硬组合）；',
  '  继续轮以「新菜、自然」为先，不要为了覆盖剩余食材而编造牵强搭配——确实没有自然的新搭配时，可如实说明并建议更换主料。',
  '  当用户说「就这些」「够了」时：不再输出 <menu> 清单，简短确认即可。',
  '  当用户说「开始做」「做这道」并指明或指向某道菜时：优先输出 <recipe> 完整菜谱（不要只回复确认）；未指明菜名时反问想做哪道。',
  '  清单阶段不要生成完整菜谱（不要输出 <recipe> 标签），等用户确认想做哪道后再生成。',
  '- 当用户询问烹饪知识、技巧、或与食材推荐无关的闲聊时：正常文字回答，不输出 <menu> 标签。',
  '- 当用户明确要求生成某道菜的完整做法/菜谱时：正常输出 <recipe> 标签（按下方菜谱格式规则）。',
  '- 优先级：用户明确指定菜名或要求做法时，<recipe> 优先于 <menu> 清单与「继续」去重要求。',
].join('\n')

// 营养估算格式规则（/api/ai/nutrition 专用，温度 0.5 求稳）：
// 只输出 <nutrition> 标签包裹的 JSON，字段与 recipe-types 的 nutritionSchema 一致（estimated 恒 true）
export const NUTRITION_FORMAT_RULE = [
  '输出格式强制要求：只输出一个 <nutrition> 标签，标签内为 JSON（不要在 JSON 外再加其他文字），最后以 </nutrition> 结束。',
  'JSON 字段模板：',
  '{"caloriesKcal":<千卡>,"proteinG":<克>,"fatG":<克>,"carbG":<克>,"estimated":true}',
  '其中 "estimated" 恒为 true（营养为估算值，非实测）；四项数值均为非负数。',
].join('\n')

// 平衡花括号扫描：从 from 开始找第一个 {，逐字符（UTF-16 码元）扫描并统计嵌套深度，
// 跳过字符串字面量（双引号内，含 \" \\ 等转义，按 JSON 规范），返回首个平衡 {...} 段（含两端）；找不到返回 null
// 注：代理对（emoji 等）按码元逐个比较，永远不会误判为 "{ } \" \\"，无需按码点拆分
function balancedJsonSegment(text: string, from: number): string | null {
  const start = text.indexOf('{', from)
  if (start === -1) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (ch === '\\') {
        escaped = true
      } else if (ch === '"') {
        inString = false
      }
      continue
    }
    if (ch === '"') {
      inString = true
    } else if (ch === '{') {
      depth++
    } else if (ch === '}') {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}

// 从 AI 输出文本中依次尝试三种形态提取首个 {...} 段（优先级：标签 > 栅栏 > 全文扫描），逐段交给 parse，任一成功即返回：
// 1. <recipe>...</recipe> / <nutrition>...</nutrition> 标签内（菜单有独立字段 schema，走 extractChatMenuJson）
// 2. markdown 代码栅栏（```json 或 ```）内
// 3. 全文平衡扫描（容忍前后杂文本）
// 某段 parse 失败（返回 null）则继续尝试下一段，全部失败返回 null
export function extractJson<T>(text: string, parse: (s: string) => T | null): T | null {
  const candidates: string[] = []
  // 形态 1：<recipe>/<nutrition> 标签（多次出现时每个标签段都作为候选，按出现顺序）
  for (const tag of ['recipe', 'nutrition']) {
    const tagRe = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'g')
    for (const m of text.matchAll(tagRe)) candidates.push(m[1])
  }
  // 形态 2：代码栅栏（``` 或 ```json 等语言标记，非贪婪取每个栅栏块）
  const fenceRe = /```[^\n`]*\n([\s\S]*?)```/g
  for (const m of text.matchAll(fenceRe)) candidates.push(m[1])
  // 形态 3：全文平衡扫描，取所有顶层平衡段（前一段解析失败时还有机会命中后续段）
  let cursor = 0
  while (true) {
    const start = text.indexOf('{', cursor)
    if (start === -1) break
    const seg = balancedJsonSegment(text, cursor)
    if (seg === null) break
    candidates.push(seg)
    cursor = start + seg.length
  }
  for (const seg of candidates) {
    const out = parse(seg)
    if (out !== null) return out
  }
  return null
}
