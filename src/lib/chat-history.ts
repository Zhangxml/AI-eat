// 聊天消息历史组包纯函数（Task 12，node 可测，无 React 依赖）
// 供 ChatView 发送时构造 POST /api/ai/chat 的 body.messages：
// 旧对话条目映射为 { role, content }（ChatItem 的 recipe/error 附件不进历史），末尾追加当前输入；
// text 为空串且无菜名的旧条目过滤掉（生成失败留下的 error-only 空气泡是噪音，发给 AI 无意义）
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

// 名单上限：防止长会话把 prompt 撑大（60 个菜名 ≈ 数百字符，足够覆盖自用场景）
const MAX_RECORDED_DISHES = 60
// 单个菜名最大长度：过长名称会让该条 content 逼近服务端 8000 字符上限
const MAX_DISH_NAME_LEN = 24

// 菜名净化：换行压成空格（防止把指令性文本以"模型自己的话"身份回灌）、去首尾空白、截断
function sanitizeDishName(name: string): string {
  return name.replace(/[\r\n]+/g, ' ').trim().slice(0, MAX_DISH_NAME_LEN)
}

// 汇总全部轮次的菜名（去重、保序、限量）；无菜名返回空数组
export function collectRecommendedDishes(items: HistoryInput[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const it of items) {
    // 只从 assistant 轮次取：菜名是模型输出，不应出现在用户消息里
    if (it.role !== 'assistant') continue
    const names = it.menuDishNames && it.menuDishNames.length > 0
      ? it.menuDishNames
      : it.recipeName
        ? [it.recipeName]
        : []
    for (const raw of names) {
      const name = sanitizeDishName(raw)
      if (name === '' || seen.has(name)) continue
      if (out.length >= MAX_RECORDED_DISHES) return out
      seen.add(name)
      out.push(name)
    }
  }
  return out
}

export function buildHistory(items: HistoryInput[], text: string): HistoryMessage[] {
  const dishes = collectRecommendedDishes(items)
  // 空文本但带结构化输出的轮次必须保留：服务端可能只发 menu/recipe 事件、不发正文（标签在开头时）
  const kept = items.filter(
    (it) =>
      it.text !== '' ||
      (it.role === 'assistant' && ((it.menuDishNames?.length ?? 0) > 0 || it.recipeName !== undefined)),
  )

  const history: HistoryMessage[] = kept.map((it) => ({ role: it.role, content: it.text }))

  // 单行汇总附在最后一条 assistant 消息上；没有 assistant 轮次（首发）则无需注入
  if (dishes.length > 0) {
    const lastAssistant = [...history].reverse().find((m) => m.role === 'assistant')
    if (lastAssistant) {
      lastAssistant.content = `${lastAssistant.content}\n（此前已推荐，勿重复：${dishes.join('、')}）`
    }
  }

  history.push({ role: 'user', content: text })
  return history
}
