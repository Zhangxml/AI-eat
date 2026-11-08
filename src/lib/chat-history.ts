// 聊天消息历史组包纯函数（Task 12，node 可测，无 React 依赖）
// 供 ChatView 发送时构造 POST /api/ai/chat 的 body.messages：
// 旧对话条目映射为 { role, content }（ChatItem 的 recipe/error 附件不进 history），末尾追加当前输入；
// text 为空串且无结构化输出的旧条目过滤掉（生成失败留下的 error-only 空气泡是噪音，发给 AI 无意义）
//
// 「继续」支持（方案 A）：结构化输出（menu 清单 / recipe 单菜谱）在界面里是独立对象，
// 不进气泡文本——模型因此看不到自己上次推荐过哪些菜。做法是把**全部轮次**的菜名累计去重后，
// 汇总成一行附在最后一条 assistant 消息上（只进请求，不改界面），提示词侧再约束「继续只出新菜」。
// 为什么不按轮次分别附加：全局去重需要完整名单，按轮裁剪会让早期菜名消失导致重复推荐；
// 单行汇总的体积也更小（与 systemPromptWithLibrary 的单行库摘要风格一致）。
export interface HistoryInput {
  role: 'user' | 'assistant'
  text: string
  /** 该轮响应中的推荐清单菜名（menu 事件） */
  menuDishNames?: string[]
  /** 该轮响应中直接生成的单个菜谱名（recipe 事件） */
  recipeName?: string
}

export interface HistoryMessage {
  role: 'user' | 'assistant'
  content: string
}

// 名单数量上限：防止长会话把 prompt 撑大
const MAX_RECORDED_DISHES = 60
// 摘要字符预算：60 个菜名最坏可到约 1500 字符，与单条 8000 字符上限之间留足余量
const MAX_SUMMARY_CHARS = 1000
// 单个菜名展示长度：过长名称会让该条 content 逼近服务端 8000 字符上限
const MAX_DISH_NAME_LEN = 24
// 只发送最近 N 轮对话（1 轮 = 1 条 user + 1 条 assistant）：
// 服务端限制 50 条消息，不裁剪的话第 25 次「继续」就会 400；同时控制累积 token 成本。
// 注意：菜名摘要不受此裁剪影响，仍按全部轮次累计（否则早期菜名丢失会导致重复推荐）。
const MAX_HISTORY_TURNS = 5

// 从后往前数 user 消息，定位最近 N 轮的起点；不足 N 轮时原样返回。
// 额外保留「首条用户消息」作为锚点：初始食材、忌口、人数等约束不能因为裁剪而丢失
// （否则第 6 轮起模型可能推荐忌口食物或算错份量）。
function recentTurnsOnly(items: HistoryInput[]): HistoryInput[] {
  let userCount = 0
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].role === 'user') {
      userCount++
      if (userCount === MAX_HISTORY_TURNS) {
        const window = items.slice(i)
        const anchorIdx = items.findIndex((it) => it.role === 'user' && it.text.trim() !== '')
        return anchorIdx !== -1 && anchorIdx < i ? [items[anchorIdx], ...window] : window
      }
    }
  }
  return items
}

// 菜名净化：换行压成空格（防止把多行指令块以「模型自己的话」身份回灌）、去首尾空白
function cleanDishName(raw: string): string {
  return raw.replace(/[\r\n]+/g, ' ').trim()
}

// 展示用截断：只在拼输出时截，不参与去重判定
// （否则「A×24 甲」与「A×24 乙」会被误判为同一道菜而漏记）
function truncateForDisplay(name: string): string {
  return name.length > MAX_DISH_NAME_LEN ? name.slice(0, MAX_DISH_NAME_LEN) : name
}

// 汇总全部轮次的菜名（去重、保序、限量）；无菜名返回空数组。
// 超限时保留**最新**的：模型最容易重复的是最近一轮推荐的菜（近因偏差），
// 若保留最早的 60 个，长会话里新菜名永远进不了摘要，去重反而失效。
export function collectRecommendedDishes(items: HistoryInput[]): string[] {
  const seen = new Set<string>()
  const all: string[] = []
  for (const it of items) {
    // 只从 assistant 轮次取：菜名是模型输出，不应出现在用户消息里
    if (it.role !== 'assistant') continue
    const names = it.menuDishNames && it.menuDishNames.length > 0
      ? it.menuDishNames
      : it.recipeName
        ? [it.recipeName]
        : []
    for (const raw of names) {
      const name = cleanDishName(raw)
      if (name === '' || seen.has(name)) continue
      seen.add(name)
      all.push(name)
    }
  }

  // 从最新往回取，受「数量上限」与「字符预算」双重约束，最后恢复时间顺序
  const picked: string[] = []
  let chars = 0
  for (let i = all.length - 1; i >= 0; i--) {
    if (picked.length >= MAX_RECORDED_DISHES) break
    const shown = truncateForDisplay(all[i])
    if (chars + shown.length + 1 > MAX_SUMMARY_CHARS) break
    picked.push(shown)
    chars += shown.length + 1
  }
  return picked.reverse()
}

export function buildHistory(items: HistoryInput[], text: string): HistoryMessage[] {
  // 摘要用**全部**轮次累计：裁剪后的历史里早期菜名已不存在，但去重必须知道完整名单
  const dishes = collectRecommendedDishes(items)
  // 历史只保留最近 MAX_HISTORY_TURNS 轮 + 首条用户锚点
  const recent = recentTurnsOnly(items)
  // 空文本但带结构化输出的轮次必须保留：服务端可能只发 menu/recipe 事件、不发正文（标签在开头时）
  const kept = recent.filter(
    (it) =>
      it.text !== '' ||
      (it.role === 'assistant' &&
        ((it.menuDishNames?.length ?? 0) > 0 || (it.recipeName?.trim() ?? '') !== '')),
  )

  const history: HistoryMessage[] = kept.map((it) => ({ role: it.role, content: it.text }))

  // 单行汇总附在最后一条 assistant 消息上；没有 assistant 轮次（首发）则无需注入
  if (dishes.length > 0) {
    const summary = `（此前已推荐，勿重复：${dishes.join('、')}）`
    const lastAssistant = [...history].reverse().find((m) => m.role === 'assistant')
    if (lastAssistant) {
      lastAssistant.content = `${lastAssistant.content}\n${summary}`
    } else if (history.length > 0) {
      // 窗口内全是失败轮（连续 5 次空正文且无结构化输出）：合成一条 assistant 承载摘要，
      // 否则去重名单彻底丢失，下一次「继续」必然重复推荐
      history.push({ role: 'assistant', content: summary })
    }
  }

  history.push({ role: 'user', content: text })
  return history
}
