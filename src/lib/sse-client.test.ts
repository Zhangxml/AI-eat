// readSse 单测（Task 12）：锁定前端 SSE 解析契约——分帧 / 缺省 event / 多行 data 拼接
// 用 new Response(sseText) 构造响应体，node 环境可测（不依赖浏览器 EventSource）
// 服务端编码契约见 src/lib/sse.ts：`event: <name>\ndata: <json>\n\n`
import { describe, expect, it } from 'vitest'
import { readSse } from './sse-client'

// 构造一条「建立了连接但永不出数据」的流：模拟网络切换/上游挂起时 reader.read() 既不 resolve 也不 reject。
// 这正是此前 ChatView 永久卡死的根因——`pending` 只在 finally 复位，而 finally 永不到达。
function hangingResponse(): Response {
  const stream = new ReadableStream<Uint8Array>({
    start() {
      /* 故意不 enqueue、不 close */
    },
    cancel() {
      /* no-op */
    },
  })
  return new Response(stream)
}

describe('readSse 解析', () => {
  it('按事件类型分发且 data 已 JSON 解析', async () => {
    const seen: string[] = []
    await readSse(
      new Response('event: message\ndata: {"t":"a"}\n\nevent: done\ndata: {}\n\n'),
      async (e) => {
        seen.push(e)
      },
    )
    expect(seen).toEqual(['message', 'done'])
  })

  it('缺省 event 行按 message 分发，data 为 JSON.parse 后的对象', async () => {
    const events: Array<{ event: string; data: unknown }> = []
    await readSse(new Response('data: {"t":"番茄炒蛋"}\n\n'), (e, d) => {
      events.push({ event: e, data: d })
    })
    expect(events).toEqual([{ event: 'message', data: { t: '番茄炒蛋' } }])
  })

  it('多行 data 行以换行拼接后整体 JSON 解析（标准 SSE）', async () => {
    const events: Array<{ event: string; data: unknown }> = []
    await readSse(new Response('event: recipe\ndata: {"name":"蛋"\ndata: ,"x":1}\n\n'), (e, d) => {
      events.push({ event: e, data: d })
    })
    expect(events).toEqual([{ event: 'recipe', data: { name: '蛋', x: 1 } }])
  })

  it('容忍 CRLF 行尾', async () => {
    const seen: string[] = []
    await readSse(
      new Response('event: message\r\ndata: {"t":"a"}\r\n\r\nevent: done\r\ndata: {}\r\n\r\n'),
      (e) => {
        seen.push(e)
      },
    )
    expect(seen).toEqual(['message', 'done'])
  })

  it('注释行忽略，无 data 的帧不分发', async () => {
    const seen: string[] = []
    await readSse(new Response(': ping\n\nevent: x\n\n'), (e) => {
      seen.push(e)
    })
    expect(seen).toEqual([])
  })

  it('data 非法 JSON 的帧跳过，不影响后续帧', async () => {
    const seen: string[] = []
    await readSse(new Response('data: not-json\n\nevent: done\ndata: {}\n\n'), (e) => {
      seen.push(e)
    })
    expect(seen).toEqual(['done'])
  })

  it('流未以空行收尾时仍分发最后一帧', async () => {
    const seen: string[] = []
    await readSse(new Response('event: done\ndata: {}'), (e) => {
      seen.push(e)
    })
    expect(seen).toEqual(['done'])
  })

  it('逐字节慢速流：跨 chunk 半行/半帧拼装正确，多字节汉字不被截坏', async () => {
    const sse = 'event: message\ndata: {"t":"好"}\n\nevent: done\ndata: {}\n\n'
    const bytes = new TextEncoder().encode(sse)
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (const b of bytes) c.enqueue(new Uint8Array([b]))
        c.close()
      },
    })
    const events: Array<{ event: string; data: unknown }> = []
    await readSse(new Response(stream), (e, d) => {
      events.push({ event: e, data: d })
    })
    expect(events).toEqual([
      { event: 'message', data: { t: '好' } },
      { event: 'done', data: {} },
    ])
  })
})

describe('readSse 空闲超时（防永久挂起）', () => {
  it('流建立后一直无数据 → 超时抛错，不会永久挂起', async () => {
    await expect(
      readSse(hangingResponse(), () => {}, { idleTimeoutMs: 50 }),
    ).rejects.toThrow(/超时|timeout/i)
  })

  it('数据持续流动时不触发超时（每帧间隔小于阈值）', async () => {
    const seen: string[] = []
    // 3 帧，每帧间隔 ~10ms，阈值 200ms → 不应超时
    const stream = new ReadableStream<Uint8Array>({
      async start(c) {
        for (let i = 0; i < 3; i++) {
          await new Promise(r => setTimeout(r, 10))
          c.enqueue(new TextEncoder().encode(`data: {"i":${i}}\n\n`))
        }
        c.close()
      },
    })
    await readSse(new Response(stream), () => {
      seen.push('x')
    }, { idleTimeoutMs: 200 })
    expect(seen).toHaveLength(3)
  })

  it('不传 idleTimeoutMs 时保持原有语义（不设超时）', async () => {
    const seen: string[] = []
    await readSse(new Response('data: {"a":1}\n\n'), () => {
      seen.push('x')
    })
    expect(seen).toHaveLength(1)
  })
})
