// 访问日志接口单测：直接 import handler（node 环境）；数据目录经 AI_EAT_DATA_DIR 注入临时目录
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import { promises as fs } from 'node:fs'
import { GET } from './route'
import { appendAccessLog, clientIpOf, readAccessLogs } from '@/lib/access-log'
import { enableMultiUser, makeSession } from '@/lib/test-helpers'

describe('访问日志', () => {
  let dir: string

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-eat-access-log-'))
    // AI_EAT_DATA_DIR 指向 data/recipes，日志落在其父目录 data/logs/
    process.env.AI_EAT_DATA_DIR = `${dir}/data/recipes`
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
    delete process.env.AI_EAT_DATA_DIR
  })

  it('clientIpOf：默认取 XFF 末段（Next 注入的真实对端）；TRUST_PROXY=true 取首段（代理链真实客户端）', () => {
    // 默认（直连部署）：Next App Router 不暴露 socket，只把真实对端 IP 注入 XFF。
    // 取**末段**——客户端自造的伪造值会被插在链首，末段是直连 Next 写入的真实地址。
    const withFwd = new Request('http://x', { headers: { 'x-forwarded-for': '192.168.1.5, 10.0.0.1' } })
    expect(clientIpOf(withFwd)).toBe('10.0.0.1')
    // 单值场景（正常直连）：直接就是真实 IP
    const single = new Request('http://x', { headers: { 'x-forwarded-for': '192.168.1.7' } })
    expect(clientIpOf(single)).toBe('192.168.1.7')
    // 反代部署：显式声明信任代理后取 XFF 首段（代理写入的真实客户端）
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

  it('审计条目带 user 字段；旧记录（无 user）照常可读且不补默认值', async () => {
    const admin = await enableMultiUser()
    // 一条新纪录（带 user）+ 一条旧格式（无 user）
    await appendAccessLog({ ip: '1.1.1.1', method: 'POST', path: '/api/recipes', status: 201, user: '爸爸' })
    const raw = JSON.stringify({ ip: '2.2.2.2', method: 'GET', path: '/api/old', status: 200, time: new Date().toISOString() })
    const { promises: fsp } = await import('node:fs')
    const logFile = path.join(dir, 'data', 'logs', 'access.jsonl')
    await fsp.appendFile(logFile, raw + '\n', 'utf8')

    const logs = await readAccessLogs()
    const withUser = logs.find(l => l.path === '/api/recipes')
    const legacy = logs.find(l => l.path === '/api/old')
    expect(withUser?.user).toBe('爸爸')
    // 旧记录没有该字段：不能凭空补一个值（页面据此显示「—」）
    expect(legacy?.user).toBeUndefined()

    // 接口层也要把 user 透出来
    const body = (await (await GET(new Request('http://x/api/access-logs', { headers: { cookie: admin.cookie } }))).json()) as {
      logs: { path: string; user?: string }[]
    }
    expect(body.logs.find(l => l.path === '/api/recipes')?.user).toBe('爸爸')
  })

  it('多用户模式下：无会话 → 401；member → 403；admin → 200', async () => {
    const admin = await enableMultiUser()
    const member = await makeSession('普通成员', 'member')

    // 无会话：401
    expect((await GET(new Request('http://x/api/access-logs'))).status).toBe(401)
    // 普通成员：403（访问记录是全局审计，仅管理员可见）
    expect(
      (await GET(new Request('http://x/api/access-logs', { headers: { cookie: member.cookie } }))).status,
    ).toBe(403)
    // 管理员：200
    expect(
      (await GET(new Request('http://x/api/access-logs', { headers: { cookie: admin.cookie } }))).status,
    ).toBe(200)
  })
})
