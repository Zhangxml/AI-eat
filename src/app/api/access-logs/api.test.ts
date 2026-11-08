// 访问日志接口单测：直接 import handler（node 环境）；数据目录经 AI_EAT_DATA_DIR 注入临时目录
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { GET } from './route'
import { appendAccessLog, clientIpOf, readAccessLogs } from '@/lib/access-log'

describe('访问日志', () => {
  let dir: string

  beforeEach(async () => {
    dir = await fs.mkdtemp('/tmp/opencode/ai-eat-access-log-')
    // AI_EAT_DATA_DIR 指向 data/recipes，日志落在其父目录 data/logs/
    process.env.AI_EAT_DATA_DIR = `${dir}/data/recipes`
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
    delete process.env.AI_EAT_DATA_DIR
  })

  it('clientIpOf：默认不信任 XFF（取 socket/unknown）；TRUST_PROXY=true 才读 XFF 首段', () => {
    // 默认（直连部署）：XFF 即使存在也一律不读——该头可伪造，防审计 IP 被污染（审计修复 #15）
    const withFwd = new Request('http://x', { headers: { 'x-forwarded-for': '192.168.1.5, 10.0.0.1' } })
    expect(clientIpOf(withFwd)).toBe('unknown')
    // 反代部署：显式声明信任代理后才取 XFF 首段
    process.env.TRUST_PROXY = 'true'
    try {
      expect(clientIpOf(withFwd)).toBe('192.168.1.5')
    } finally {
      delete process.env.TRUST_PROXY
    }
    const noFwd = new Request('http://x')
    expect(clientIpOf(noFwd)).toBe('unknown')
  })

  it('appendAccessLog 追加 → readAccessLogs 最新在前', async () => {
    await appendAccessLog({ ip: '192.168.1.5', method: 'POST', path: '/api/recipes', status: 201 })
    await appendAccessLog({ ip: '192.168.1.9', method: 'DELETE', path: '/api/recipes/r-1', status: 204 })
    const logs = await readAccessLogs()
    expect(logs).toHaveLength(2)
    expect(logs[0]).toMatchObject({ ip: '192.168.1.9', method: 'DELETE', status: 204 }) // 最新在前
    expect(logs[1]).toMatchObject({ ip: '192.168.1.5', method: 'POST', status: 201 })
    expect(typeof logs[0].time).toBe('string')
  })

  it('容量滚动：超过上限（200）丢弃最旧条目', async () => {
    // 直接写满上限+2 条（快速循环，绕过 append 的多次读改写）
    const file = `${dir}/data/logs/access.jsonl`
    await fs.mkdir(`${dir}/data/logs`, { recursive: true })
    const lines = Array.from({ length: 202 }, (_, i) =>
      JSON.stringify({ time: 't', ip: `ip-${i}`, method: 'GET', path: '/x', status: 200 }),
    ).join('\n')
    await fs.writeFile(file, lines + '\n', 'utf8')
    // 再追加一条：应丢弃最旧（ip-0~ip-2），总数回到 200
    await appendAccessLog({ ip: 'new-ip', method: 'POST', path: '/y', status: 200 })
    const logs = await readAccessLogs()
    expect(logs).toHaveLength(200)
    expect(logs[0].ip).toBe('new-ip') // 最新在前
    expect(logs[1].ip).toBe('ip-201') // 次新
    expect(logs[199].ip).toBe('ip-3') // 最旧的保留者（ip-0~ip-2 已被滚动丢弃）
  })

  it('坏行容忍：手改文件留下的非法行被跳过不崩溃', async () => {
    const file = `${dir}/data/logs/access.jsonl`
    await fs.mkdir(`${dir}/data/logs`, { recursive: true })
    await fs.writeFile(file, '{oops\n' + JSON.stringify({ time: 't', ip: 'a', method: 'GET', path: '/', status: 200 }) + '\n', 'utf8')
    const logs = await readAccessLogs()
    expect(logs).toHaveLength(1)
  })

  it('GET /api/access-logs：返回日志数组；日志读取本身不产生新日志', async () => {
    await appendAccessLog({ ip: '192.168.1.5', method: 'POST', path: '/api/recipes', status: 201 })
    const res = await GET(new Request('http://x/api/access-logs'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { logs: unknown[] }
    expect(body.logs).toHaveLength(1)
    // 读接口不写日志：再读一次数量不变
    const again = await GET(new Request('http://x/api/access-logs'))
    expect(((await again.json()) as { logs: unknown[] }).logs).toHaveLength(1)
  })

  it('启用 PASSWORD 后未带会话 → 401', async () => {
    process.env.PASSWORD = 'pw-test'
    try {
      const res = await GET(new Request('http://x/api/access-logs'))
      expect(res.status).toBe(401)
    } finally {
      delete process.env.PASSWORD
    }
  })
})
