// AI 提示词组装与结构化输出解析（Task 9，设计 5.2/5.3）
// 被 T10/T11/T13 三个 AI 接口消费：
// - systemPromptWithLibrary：中文人设 + 菜谱库摘要注入，让 AI 优先推荐库中已有菜
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

// 系统提示词：人设部分自拟（中文、AI 菜谱助手、鼓励优先推荐库中已有菜）+ 库摘要段
export function systemPromptWithLibrary(recipes: Recipe[]): string {
  const lines: string[] = [
    '你是一个中餐家常菜 AI 菜谱助手，专门帮助用户解决「今天吃什么」的问题：可以按现有食材生成菜谱、',
    '根据人数和口味点菜搭配、回答烹饪相关问题。回答要实用、口语化，步骤清晰可操作。',
  ]
  if (recipes.length === 0) {
    lines.push('菜谱库为空。', '你生成的菜谱后续会被用户存入菜谱库。')
    return lines.join('\n')
  }
  lines.push(
    '用户有一个菜谱库，里面已有的菜如下（格式：名称｜食材:食材名列表）：',
    ...recipes.map(r => `${r.name}｜食材:${r.ingredients.map(i => i.name).join(',')}`),
    '推荐时优先推荐菜谱库中已有的菜，不要重复生成库里已经有的菜谱；只有当库中没有合适的菜时才生成新菜谱。',
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
// 1. <recipe>...</recipe> 标签内
// 2. markdown 代码栅栏（```json 或 ```）内
// 3. 全文平衡扫描（容忍前后杂文本）
// 某段 parse 失败（返回 null）则继续尝试下一段，全部失败返回 null
export function extractJson<T>(text: string, parse: (s: string) => T | null): T | null {
  const candidates: string[] = []
  // 形态 1：<recipe> 标签（多次出现时每个标签段都作为候选，按出现顺序）
  const tagRe = /<recipe>([\s\S]*?)<\/recipe>/g
  for (const m of text.matchAll(tagRe)) candidates.push(m[1])
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
