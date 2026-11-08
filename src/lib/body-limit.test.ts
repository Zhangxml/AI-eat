// 请求体体积上限单测（审计修复 #4）：checkBodySize 只读 content-length 头判断，
// 头缺失（Node 内部直调 handler）放行；上限常量与 413 响应形态一并锁定
import { describe, expect, it } from 'vitest'
import {
  checkBodySize,
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
