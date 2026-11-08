// 聊天消息历史组包纯函数（Task 12，node 可测，无 React 依赖）
// 供 ChatView 发送时构造 POST /api/ai/chat 的 body.messages：
// 旧对话条目映射为 { role, content }（ChatItem 的 recipe/error 附件不进历史），末尾追加当前输入；
// text 为空串的旧条目过滤掉（生成失败留下的 error-only 空气泡是噪音，发给 AI 无意义）
//
// 「继续」支持（方案 A）：结构化输出（menu 清单 / recipe 单菜谱）在界面里是独立对象，
// 不进气泡文本——模型因此看不到自己上次推荐过哪些菜。这里把它们的菜名以纯文本摘要
// 追加到对应 assistant 消息的 content 里（只进请求，不改界面），并在提示词侧约束「继续只出新菜」。
// 仅保留最近 MAX_SUMMARY_TURNS 轮的摘要，防止长对话把 prompt 撑大。
export interface HistoryInput {
  role: 'user' | 'assistant'
  text: string
  /** 该轮响应中的推荐清单菜名（menu 事件）；有值时写入摘要供「继续」去重 */
  menuDishNames?: string[]
  /** 该轮响应中直接生成的单个菜谱名（recipe 事件） */
  recipeName?: string
}

export interface HistoryMessage {
  role: 'user' | 'assistant'
  content: string
}

// 只给最近 N 条带结构化输出的 assistant 消息附摘要（按轮次从新到旧）
const MAX_SUMMARY_TURNS = 3

// 构造某轮的菜名摘要；无菜名返回空串
function summaryOf(item: HistoryInput): string {
  const names = item.menuDishNames && item.menuDishNames.length > 0
    ? item.menuDishNames
    : item.recipeName
      ? [item.recipeName]
      : []
  return names.length === 0 ? '' : `\n（本轮已推荐：${names.join('、')}）`
}

export function buildHistory(items: HistoryInput[], text: string): HistoryMessage[] {
  const kept = items.filter((it) => it.text !== '')

  // 从后往前数，前 MAX_SUMMARY_TURNS 个「带菜名」的轮次才附摘要
  const summaryIndexes = new Set<number>()
  for (let i = kept.length - 1; i >= 0 && summaryIndexes.size < MAX_SUMMARY_TURNS; i--) {
    if (summaryOf(kept[i]) !== '') summaryIndexes.add(i)
  }

  const history: HistoryMessage[] = kept.map((it, i) => ({
    role: it.role,
    content: summaryIndexes.has(i) ? `${it.text}${summaryOf(it)}` : it.text,
  }))
  history.push({ role: 'user', content: text })
  return history
}
