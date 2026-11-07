// buildHistory 单测（Task 12 修复 Critical 1）：锁定聊天发送的消息历史组包契约
// 背景：修复前 ChatView 从旧 items 构造 history，当前输入从未进入 POST body（首发 messages 为空数组被服务端 400 拒绝）
import { describe, expect, it } from 'vitest'
import { buildHistory } from './chat-history'

describe('buildHistory 组包', () => {
  it('首发：空历史 + 当前输入 → messages 末尾是当前用户消息', () => {
    expect(buildHistory([], '冰箱有番茄和鸡蛋，做个菜')).toEqual([
      { role: 'user', content: '冰箱有番茄和鸡蛋，做个菜' },
    ])
  })

  it('过滤 text 为空串的旧条目（生成失败留下的 error-only 空气泡不进历史）', () => {
    const items = [
      { role: 'user' as const, text: '你好' },
      { role: 'assistant' as const, text: '' }, // error-only 空气泡
      { role: 'user' as const, text: '' }, // 理论不出现的空 user 条目，同样过滤
    ]
    expect(buildHistory(items, '再来一个')).toEqual([
      { role: 'user', content: '你好' },
      { role: 'user', content: '再来一个' },
    ])
  })

  it('多轮映射 role/content 顺序正确，当前消息追加在末尾', () => {
    const items = [
      { role: 'user' as const, text: 'q1' },
      { role: 'assistant' as const, text: 'a1' },
      { role: 'user' as const, text: 'q2' },
      { role: 'assistant' as const, text: 'a2' },
    ]
    expect(buildHistory(items, 'q3')).toEqual([
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' },
      { role: 'assistant', content: 'a2' },
      { role: 'user', content: 'q3' },
    ])
  })
})
