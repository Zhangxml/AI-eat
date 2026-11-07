// GET /api/config 单测：env 注入 + 快照恢复（node 环境，不启 HTTP 服务器）
// Task 16 起本接口受守卫保护：PASSWORD 已设时须带合法会话 Cookie 才能拿到配置（测试里用 issueToken 签发）
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GET } from './route'
import { issueToken } from '@/lib/auth'

// 构造带可选会话 Cookie 的 GET 请求（PASSWORD 未启用时守卫放行，不带 Cookie 亦可）
const getReq = (withSession: boolean) =>
  new Request('http://x/api/config', {
    headers: withSession ? { cookie: `ai-eat-session=${issueToken()}` } : {},
  })

// env 快照：测试内注入，afterEach 精确恢复，避免污染其他测试文件
let envSnapshot: NodeJS.ProcessEnv

describe('配置接口 /api/config', () => {
  beforeEach(() => {
    envSnapshot = { ...process.env }
  })

  afterEach(() => {
    process.env = envSnapshot
  })

  it('AI 三变量齐全 + PASSWORD 设置 → aiConfigured/authEnabled 均 true 且回显 model', async () => {
    process.env.AI_BASE_URL = 'https://api.deepseek.com'
    process.env.AI_API_KEY = 'sk-secret'
    process.env.AI_MODEL = 'deepseek-chat'
    process.env.PASSWORD = 'pw'
    const res = await GET(getReq(true))
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      aiConfigured: boolean
      baseUrl: string | null
      model: string | null
      authEnabled: boolean
    }
    expect(body).toEqual({
      aiConfigured: true,
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-chat',
      authEnabled: true,
    })
  })

  it('AI 未配置 → aiConfigured=false、baseUrl/model 均 null；PASSWORD 未设 → authEnabled=false', async () => {
    delete process.env.AI_BASE_URL
    delete process.env.AI_API_KEY
    delete process.env.AI_MODEL
    delete process.env.PASSWORD
    const body = await (await GET(getReq(false))).json()
    expect(body).toEqual({ aiConfigured: false, baseUrl: null, model: null, authEnabled: false })
  })

  it('AI 变量缺一即 aiConfigured=false（三变量全非空的合取语义）', async () => {
    process.env.AI_BASE_URL = 'https://api.deepseek.com'
    delete process.env.AI_API_KEY
    process.env.AI_MODEL = 'deepseek-chat'
    const body = await (await GET(getReq(false))).json()
    expect(body.aiConfigured).toBe(false)
    // baseUrl/model 回显与 aiConfigured 绑定：未配置整体为 null（避免半配置状态误导展示）
    expect(body.baseUrl).toBeNull()
    expect(body.model).toBeNull()
  })

  it('响应体绝不含 apiKey 字段（红线断言）', async () => {
    process.env.AI_BASE_URL = 'https://api.deepseek.com'
    process.env.AI_API_KEY = 'sk-secret-should-never-leak'
    process.env.AI_MODEL = 'deepseek-chat'
    process.env.PASSWORD = 'pw'
    const body = await (await GET(getReq(true))).json() as Record<string, unknown>
    expect(Object.keys(body)).not.toContain('apiKey')
    expect(JSON.stringify(body)).not.toContain('sk-secret-should-never-leak')
  })
})
