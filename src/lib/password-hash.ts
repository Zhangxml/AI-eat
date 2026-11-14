// 密码哈希：Node 内置 scrypt（内存硬，抗 GPU 爆破），零第三方依赖。
// 存储格式：`scrypt$N$r$p$<salt-base64>$<hash-base64>`（自带参数，便于将来调参而不破坏旧哈希）。
// 设计要点：
// - 每用户独立随机盐（16 字节）→ 相同密码的哈希也不同，防彩虹表
// - 参数 N=16384/r=8/p=1（约 16MB 内存、数十毫秒），本项目的并发量下可接受
// - 校验失败/格式非法一律返回 false，绝不抛错（损坏的 users.json 不能让登录接口 500）
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'

// scrypt 参数：N 必须是 2 的幂；r*p 影响块大小
const SCRYPT_N = 16384
const SCRYPT_R = 8
const SCRYPT_P = 1
const KEY_LEN = 64
const SALT_LEN = 16
// 内存上限：scrypt 需要约 128*N*r 字节（16384*8*128 ≈ 16MB），留一倍余量
const MAX_MEM = 64 * 1024 * 1024

function deriveKey(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      KEY_LEN,
      { N: n, r, p, maxmem: MAX_MEM },
      (err, key) => (err ? reject(err) : resolve(key)),
    )
  })
}

/** 生成哈希串（含参数与随机盐） */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LEN)
  const key = await deriveKey(password, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P)
  return [
    'scrypt',
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString('base64'),
    key.toString('base64'),
  ].join('$')
}

/** 校验密码；存储串非法、参数异常、长度不符一律返回 false（不抛错） */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (typeof stored !== 'string' || stored === '') return false
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false

  const n = Number(parts[1])
  const r = Number(parts[2])
  const p = Number(parts[3])
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false
  if (n <= 1 || r < 1 || p < 1) return false

  let salt: Buffer
  let expected: Buffer
  try {
    salt = Buffer.from(parts[4], 'base64')
    expected = Buffer.from(parts[5], 'base64')
  } catch {
    return false
  }
  if (salt.length === 0 || expected.length === 0) return false

  let actual: Buffer
  try {
    actual = await deriveKey(password, salt, n, r, p)
  } catch {
    // 参数过大导致内存超限等情况：视为校验失败，不冒泡
    return false
  }
  if (actual.length !== expected.length) return false
  return timingSafeEqual(actual, expected)
}
