// 密码哈希单测：scrypt + 每用户独立盐
// 安全要求（设计文档 3.2）：不存明文、盐随机、算法参数可解析、任何非法输入一律返回 false 且不抛
import { describe, expect, it } from 'vitest'
import { hashPassword, verifyPassword } from './password-hash'

describe('hashPassword / verifyPassword', () => {
  it('哈希后可校验通过', async () => {
    const stored = await hashPassword('correct horse battery staple')
    expect(await verifyPassword('correct horse battery staple', stored)).toBe(true)
  })

  it('错误密码校验失败', async () => {
    const stored = await hashPassword('abc123')
    expect(await verifyPassword('abc124', stored)).toBe(false)
    expect(await verifyPassword('', stored)).toBe(false)
    expect(await verifyPassword('abc123 ', stored)).toBe(false)
  })

  it('同一密码两次哈希结果不同（盐随机）', async () => {
    const a = await hashPassword('same-password')
    const b = await hashPassword('same-password')
    expect(a).not.toBe(b)
    // 但两者都能校验通过
    expect(await verifyPassword('same-password', a)).toBe(true)
    expect(await verifyPassword('same-password', b)).toBe(true)
  })

  it('哈希串格式可解析：scrypt$N$r$p$salt$hash，且不含明文', async () => {
    const stored = await hashPassword('my-secret-pw')
    const parts = stored.split('$')
    expect(parts).toHaveLength(6)
    expect(parts[0]).toBe('scrypt')
    expect(Number(parts[1])).toBeGreaterThanOrEqual(16384) // N
    expect(Number(parts[2])).toBe(8) // r
    expect(Number(parts[3])).toBe(1) // p
    expect(parts[4].length).toBeGreaterThan(0) // salt
    expect(parts[5].length).toBeGreaterThan(0) // hash
    expect(stored).not.toContain('my-secret-pw')
  })

  it('空密码允许哈希（是否允许由上层策略决定），且能校验', async () => {
    const stored = await hashPassword('')
    expect(await verifyPassword('', stored)).toBe(true)
    expect(await verifyPassword('x', stored)).toBe(false)
  })

  it('非法存储串一律返回 false，不抛错', async () => {
    for (const bad of ['', 'plain', 'scrypt$16384', 'md5$1$2$3$4$5', 'scrypt$broken$8$1$aa$bb', 'scrypt$16384$8$1$$']) {
      await expect(verifyPassword('x', bad)).resolves.toBe(false)
    }
  })

  it('超长密码不抛错（scrypt 本身无长度限制）', async () => {
    const long = 'a'.repeat(4096)
    const stored = await hashPassword(long)
    expect(await verifyPassword(long, stored)).toBe(true)
  })
})
