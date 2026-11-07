// 聊天消息历史组包纯函数（Task 12，node 可测，无 React 依赖）
// 供 ChatView 发送时构造 POST /api/ai/chat 的 body.messages：
// 旧对话条目映射为 { role, content }（ChatItem 的 recipe/error 附件不进历史），末尾追加当前输入；
// text 为空串的旧条目过滤掉（生成失败留下的 error-only 空气泡是噪音，发给 AI 无意义）
export interface HistoryInput {
  role: 'user' | 'assistant'
  text: string
}

export interface HistoryMessage {
  role: 'user' | 'assistant'
  content: string
}

export function buildHistory(items: HistoryInput[], text: string): HistoryMessage[] {
  const history = items
    .filter((it) => it.text !== '')
    .map((it) => ({ role: it.role, content: it.text }))
  history.push({ role: 'user', content: text })
  return history
}
