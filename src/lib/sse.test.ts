// sse.ts 纯函数单测（Task 11）：锁定 SSE 输出协议编码，一字不差（T12 前端 readSse 依赖此格式）
import { describe, expect, it } from 'vitest'
import { sseEvent, sseHeaders } from './sse'

describe('SSE 编码纯函数', () => {
  it('sseEvent 编码格式', () =>
    expect(sseEvent('message', { t: '好' })).toBe('event: message\ndata: {"t":"好"}\n\n'))

  it('sseEvent done 事件编码为空对象 data {}', () =>
    expect(sseEvent('done', {})).toBe('event: done\ndata: {}\n\n'))

  it('sseHeaders 固定三头：text/event-stream / no-cache / keep-alive', () =>
    expect(sseHeaders()).toEqual({
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    }))
})
