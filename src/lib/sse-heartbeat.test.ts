// SSE 心跳单测：服务端在「长时间不产生正文」的窗口定期发注释帧，防止客户端把合法等待判成断流。
// 背景（已实测）：聊天接口在「结构化输出解析失败 → 非流式重试」期间不向客户端发任何帧，
// 而该重试最多需要 120 秒；加上流式首 token 的 120 秒上限，最坏无帧时长可达 240 秒。
// 客户端任何空闲超时阈值只要小于它，就会误杀合法请求——实测出现过「服务端 200 且已产出菜谱，
// 客户端已放弃 → 聊天记录不持久化 → 用户永久丢失该菜谱」。
// 服务端每 10 秒发一帧 `: ping`（SSE 注释行，EventSource 与我们的 readSse 都会忽略），
// 客户端空闲计时器因此持续被重置，阈值可以保持很短（快速发现真断网）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startSseHeartbeat } from './sse-heartbeat'

describe('startSseHeartbeat', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('按间隔周期性发送注释帧（SSE 注释行格式）', () => {
    const chunks: string[] = []
    startSseHeartbeat(c => chunks.push(c), 10_000)

    expect(chunks).toEqual([])
    vi.advanceTimersByTime(10_000)
    expect(chunks).toEqual([': ping\n\n'])
    vi.advanceTimersByTime(20_000)
    expect(chunks).toEqual([': ping\n\n', ': ping\n\n', ': ping\n\n'])
  })

  it('返回的 stop 函数能停止心跳（避免流关闭后继续写）', () => {
    const chunks: string[] = []
    const stop = startSseHeartbeat(c => chunks.push(c), 1000)

    vi.advanceTimersByTime(3000)
    expect(chunks).toHaveLength(3)

    stop()
    vi.advanceTimersByTime(10_000)
    expect(chunks).toHaveLength(3) // 停止后不再增加
  })

  it('重复调用 stop 安全（幂等，不抛错）', () => {
    const stop = startSseHeartbeat(() => {}, 1000)
    stop()
    expect(() => stop()).not.toThrow()
  })

  it('emit 抛错（流已关闭）时心跳不炸掉进程，也不中断后续心跳', () => {
    let calls = 0
    const stop = startSseHeartbeat(() => {
      calls++
      throw new Error('Controller is already closed')
    }, 1000)

    // 定时器回调抛错不应让 vitest 挂掉；这里只断言它被反复调用、且 stop 仍可停止
    expect(() => vi.advanceTimersByTime(3000)).not.toThrow()
    expect(calls).toBe(3)
    stop()
    vi.advanceTimersByTime(5000)
    expect(calls).toBe(3)
  })
})
