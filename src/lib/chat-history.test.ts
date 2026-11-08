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

// 「继续」只追加新菜：菜单名需写回历史，否则模型看不到自己推荐过什么（实测会重复推荐同一道）
describe('buildHistory 菜单摘要（支持「继续」去重）', () => {
  it('带菜单的 assistant 轮次在 content 末尾附已推荐菜名', () => {
    const items = [
      { role: 'user' as const, text: '番茄和鸡蛋做什么' },
      {
        role: 'assistant' as const,
        text: '可以这样搭。',
        menuDishNames: ['番茄炒蛋', '番茄盅蒸蛋'],
      },
    ]
    const history = buildHistory(items, '继续')
    expect(history[1].content).toContain('可以这样搭。')
    expect(history[1].content).toContain('已推荐')
    expect(history[1].content).toContain('番茄炒蛋')
    expect(history[1].content).toContain('番茄盅蒸蛋')
  })

  it('纯闲聊轮次（无菜单）不追加摘要', () => {
    const items = [
      { role: 'user' as const, text: '你好' },
      { role: 'assistant' as const, text: '你好，想吃什么？' },
    ]
    expect(buildHistory(items, '继续')[1].content).toBe('你好，想吃什么？')
  })

  it('单菜谱直出的轮次也记录菜名', () => {
    const items = [
      { role: 'user' as const, text: '红烧鱼怎么做' },
      { role: 'assistant' as const, text: '这就来。', recipeName: '红烧鱼' },
    ]
    const history = buildHistory(items, '继续')
    expect(history[1].content).toContain('红烧鱼')
  })

  it('只保留最近 3 轮菜单摘要，更早轮次不再附加（防 prompt 膨胀）', () => {
    const items = [
      { role: 'user' as const, text: 'u1' },
      { role: 'assistant' as const, text: 'a1', menuDishNames: ['第一轮菜'] },
      { role: 'user' as const, text: 'u2' },
      { role: 'assistant' as const, text: 'a2', menuDishNames: ['第二轮菜'] },
      { role: 'user' as const, text: 'u3' },
      { role: 'assistant' as const, text: 'a3', menuDishNames: ['第三轮菜'] },
      { role: 'user' as const, text: 'u4' },
      { role: 'assistant' as const, text: 'a4', menuDishNames: ['第四轮菜'] },
    ]
    const history = buildHistory(items, '继续')
    const byContent = (prefix: string) => history.find(h => h.content.startsWith(prefix))!
    expect(byContent('a1').content).toBe('a1') // 超出窗口，不再附摘要
    expect(byContent('a2').content).toContain('第二轮菜')
    expect(byContent('a3').content).toContain('第三轮菜')
    expect(byContent('a4').content).toContain('第四轮菜')
  })

  it('不修改入参（纯函数，界面气泡文字保持不变）', () => {
    const items = [
      { role: 'assistant' as const, text: '可以这样搭。', menuDishNames: ['番茄炒蛋'] },
    ]
    const snapshot = JSON.parse(JSON.stringify(items))
    buildHistory(items, '继续')
    expect(items).toEqual(snapshot)
  })
})
