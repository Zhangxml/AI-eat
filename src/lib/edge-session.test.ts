// Edge 会话验签单测：签名有效/无效/过期/格式非法，且必须与 node 侧 issueSession 互通
import { describe, expect, it } from 'vitest'
import { verifySessionEdge } from './edge-session'
import { issueSession } from './session'

const NOW = 1_800_000_000_000

describe('verifySessionEdge（middleware 用）', () => {
  it('与 node 侧 issueSession 签发的 token 互通', async () => {
    process.env.SESSION_SECRET = 'edge-test-secret-0123456789abcdef'
    try {
      const token = await issueSession({ uid: 'u-a1b2c3d4', ver: 3 }, NOW)
      const claims = await verifySessionEdge(token, 'edge-test-secret-0123456789abcdef', NOW + 1000)
      expect(claims).toEqual({ uid: 'u-a1b2c3d4', ver: 3, exp: NOW + 30 * 86400_000 })
    } finally {
      delete process.env.SESSION_SECRET
    }
  })

  it('密钥不符（例如来自其它实例）→ null', async () => {
    process.env.SESSION_SECRET = 'secret-A-0123456789abcdef'
    let token: string
    try {
      token = await issueSession({ uid: 'u-a1b2c3d4', ver: 1 }, NOW)
    } finally {
      delete process.env.SESSION_SECRET
    }
    expect(await verifySessionEdge(token, 'secret-B-0123456789abcdef', NOW)).toBeNull()
  })

  it('过期 token → null', async () => {
    process.env.SESSION_SECRET = 'edge-test-secret-0123456789abcdef'
    try {
      const token = await issueSession({ uid: 'u-a1b2c3d4', ver: 1 }, NOW)
      expect(await verifySessionEdge(token, 'edge-test-secret-0123456789abcdef', NOW + 31 * 86400_000)).toBeNull()
    } finally {
      delete process.env.SESSION_SECRET
    }
  })

  it('篡改载荷 → 签名不符 → null', async () => {
    process.env.SESSION_SECRET = 'edge-test-secret-0123456789abcdef'
    try {
      const token = await issueSession({ uid: 'u-a1b2c3d4', ver: 1 }, NOW)
      const [, sig] = token.split('.')
      const forged = Buffer.from(
        JSON.stringify({ uid: 'u-deadbeef', ver: 1, exp: NOW + 1000 }),
      ).toString('base64url')
      expect(await verifySessionEdge(`${forged}.${sig}`, 'edge-test-secret-0123456789abcdef', NOW)).toBeNull()
    } finally {
      delete process.env.SESSION_SECRET
    }
  })

  it('格式非法 / 空密钥 → null，不抛错', async () => {
    for (const bad of ['', 'abc', 'a.b.c', '.', 'a.']) {
      await expect(verifySessionEdge(bad, 'k'.repeat(32), NOW)).resolves.toBeNull()
    }
    await expect(verifySessionEdge('a.b', '', NOW)).resolves.toBeNull()
  })

  it('签名合法但载荷为 JSON null / 非对象 → null，不抛错', async () => {
    // 只在签名先通过后才会解析载荷：这里用真实算法签一个 "null"，验证不会因
    // 解引用 payload.uid 抛 TypeError（middleware 里抛异常 = 500）
    const secret = 'edge-test-secret-0123456789abcdef'
    const { createHmac } = await import('node:crypto')
    for (const raw of ['null', '123', '"str"', '[]']) {
      const payloadB64 = Buffer.from(raw).toString('base64url')
      const sig = createHmac('sha256', secret).update(payloadB64).digest('hex')
      await expect(verifySessionEdge(`${payloadB64}.${sig}`, secret, NOW)).resolves.toBeNull()
    }
  })
})
