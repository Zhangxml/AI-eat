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

  it('启用鉴权后未带会话 → 401；带合法会话 → 200', async () => {
    process.env.PASSWORD = 'test-pw'
    try {
      expect((await GET(new Request('http://x/api/config'))).status).toBe(401)
      const token = issueToken()
      const ok = await GET(new Request('http://x/api/config', { headers: { cookie: `ai-eat-session=${token}` } }))
      expect(ok.status).toBe(200)
    } finally {
      delete process.env.PASSWORD
    }
  })
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
      // 删除保护未配置（env 未设）→ false；显式 true 配置见下方独立用例
      deleteEnabled: false,
    })
  })

  it('AI 未配置 → aiConfigured=false、baseUrl/model 均 null；PASSWORD 未设 → authEnabled=false', async () => {
    delete process.env.AI_BASE_URL
    delete process.env.AI_API_KEY
    delete process.env.AI_MODEL
    delete process.env.PASSWORD
    delete process.env.DELETE_ENABLED
    delete process.env.DELETE_PASSWORD
    const body = await (await GET(getReq(false))).json()
    expect(body).toEqual({ aiConfigured: false, baseUrl: null, model: null, authEnabled: false, deleteEnabled: false })
  })

  it('删除保护开关：DELETE_ENABLED=true 且密码非空 → deleteEnabled=true；半配/关闭 → false', async () => {
    // 完整配置 → true
    process.env.DELETE_ENABLED = 'true'
    process.env.DELETE_PASSWORD = 'del-pw'
    let body = await (await GET(getReq(false))).json() as { deleteEnabled: boolean }
    expect(body.deleteEnabled).toBe(true)
    // 半配：开关 true 但密码空 → false（防只配一半半失效）
    delete process.env.DELETE_PASSWORD
    body = await (await GET(getReq(false))).json() as { deleteEnabled: boolean }
    expect(body.deleteEnabled).toBe(false)
    // 开关 false 但密码非空 → false
    process.env.DELETE_ENABLED = 'false'
    process.env.DELETE_PASSWORD = 'del-pw'
    body = await (await GET(getReq(false))).json() as { deleteEnabled: boolean }
    expect(body.deleteEnabled).toBe(false)
    delete process.env.DELETE_ENABLED
    delete process.env.DELETE_PASSWORD
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
    // 删除保护密码同样是敏感值，一并断言不泄漏
    process.env.DELETE_PASSWORD = 'del-secret-should-never-leak'
    const body = await (await GET(getReq(true))).json() as Record<string, unknown>
    expect(Object.keys(body)).not.toContain('apiKey')
    expect(Object.keys(body)).not.toContain('deletePassword')
    expect(JSON.stringify(body)).not.toContain('sk-secret-should-never-leak')
    expect(JSON.stringify(body)).not.toContain('del-secret-should-never-leak')
    delete process.env.DELETE_ENABLED
    delete process.env.DELETE_PASSWORD
  })
})
