// 请求体体积上限单测（审计修复 #4）：checkBodySize 只读 content-length 头判断，
// 头缺失（Node 内部直调 handler）放行；上限常量与 413 响应形态一并锁定
import { describe, expect, it } from 'vitest'
import {
  checkBodySize,
  readJsonBody,
  bodyTooLarge,
  BODY_LIMIT_BYTES,
  BACKUP_BODY_LIMIT_BYTES,
} from './body-limit'

// 构造带 content-length 头的请求
const reqWithLen = (len: string | null) =>
  new Request('http://x', {
    method: 'POST',
    body: 'x',
    headers: len === null ? {} : { 'content-length': len },
  })

describe('body-limit', () => {
  it('content-length 缺失时放行（Node 内部调用无该头）', () => {
    expect(checkBodySize(reqWithLen(null), BODY_LIMIT_BYTES)).toBe(true)
  })

  it('头值非法（非数字/负数）放行，交由后续参数校验兜底', () => {
    expect(checkBodySize(reqWithLen('abc'), BODY_LIMIT_BYTES)).toBe(true)
    expect(checkBodySize(reqWithLen('-5'), BODY_LIMIT_BYTES)).toBe(true)
  })

  it('等于上限放行，超上限拒绝', () => {
    expect(checkBodySize(reqWithLen(String(BODY_LIMIT_BYTES)), BODY_LIMIT_BYTES)).toBe(true)
    expect(checkBodySize(reqWithLen(String(BODY_LIMIT_BYTES + 1)), BODY_LIMIT_BYTES)).toBe(false)
  })

  it('上限常量：通用 1MB / 备份 5MB', () => {
    expect(BODY_LIMIT_BYTES).toBe(1024 * 1024)
    expect(BACKUP_BODY_LIMIT_BYTES).toBe(5 * 1024 * 1024)
  })

  it('bodyTooLarge 返回 413 + 中文 error', async () => {
    const res = bodyTooLarge()
    expect(res.status).toBe(413)
    expect(((await res.json()) as { error: string }).error).toBe('请求体过大')
  })
})

describe('readJsonBody（真实体积上限，防 chunked 绕过）', () => {
  /** 构造「无 content-length」的流式请求，模拟 chunked 传输 */
  const chunkedReq = (payload: string) =>
    new Request('http://x', {
      method: 'POST',
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(payload))
          controller.close()
        },
      }),
      // Node 的 undici 要求流式 body 声明 duplex
      duplex: 'half',
    } as RequestInit)

  it('正常 JSON 可解析', async () => {
    const r = await readJsonBody(
      new Request('http://x', { method: 'POST', body: '{"a":1}', headers: { 'content-type': 'application/json' } }),
      BODY_LIMIT_BYTES,
    )
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toEqual({ a: 1 })
  })

  it('非法 JSON → 400', async () => {
    const r = await readJsonBody(new Request('http://x', { method: 'POST', body: '{oops' }), BODY_LIMIT_BYTES)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.response.status).toBe(400)
  })

  it('空 body → 400', async () => {
    const r = await readJsonBody(new Request('http://x', { method: 'POST' }), BODY_LIMIT_BYTES)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.response.status).toBe(400)
  })

  it('无 content-length 的超限流式请求 → 413（旧实现只看头，会放行）', async () => {
    const req = chunkedReq(JSON.stringify({ x: 'a'.repeat(2048) }))
    expect(req.headers.get('content-length')).toBeNull()
    const r = await readJsonBody(req, 512)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.response.status).toBe(413)
    // 旧的 checkBodySize 对同一请求会放行 —— 这正是被绕过的原因
    expect(checkBodySize(req, 512)).toBe(true)
  })

  it('恰好等于上限放行，超 1 字节拒绝', async () => {
    const text = 'a'.repeat(64)
    const exact = await readJsonBody(
      new Request('http://x', { method: 'POST', body: `"${text}"` }),
      text.length + 2,
    )
    expect(exact.ok).toBe(true)
    const over = await readJsonBody(
      new Request('http://x', { method: 'POST', body: `"${text}"` }),
      text.length + 1,
    )
    expect(over.ok).toBe(false)
    if (!over.ok) expect(over.response.status).toBe(413)
  })
})
