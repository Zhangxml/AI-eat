// GET /api/config 单测：env 注入 + 快照恢复（node 环境，不启 HTTP 服务器）
// 多用户改造后：鉴权开关看 data/users.json 是否存在（不再看 env.PASSWORD）。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { GET } from './route'
import { enableMultiUser, makeSession } from '@/lib/test-helpers'

// env 快照：测试内注入，afterEach 精确恢复，避免污染其他测试文件
let envSnapshot: NodeJS.ProcessEnv
let root: string

const getReq = (cookie?: string) =>
  new Request('http://x/api/config', { headers: cookie ? { cookie } : {} })

describe('配置接口 /api/config', () => {
  beforeEach(async () => {
    envSnapshot = { ...process.env }
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-eat-config-api-'))
    process.env.AI_EAT_DATA_DIR = path.join(root, 'recipes')
    delete process.env.SESSION_SECRET
  })

  afterEach(async () => {
    process.env = envSnapshot
    await fs.rm(root, { recursive: true, force: true })
  })

  it('启用多用户后未带会话 → 401；带合法会话 → 200', async () => {
    const admin = await enableMultiUser()
    expect((await GET(getReq())).status).toBe(401)
    expect((await GET(getReq(admin.cookie))).status).toBe(200)
  })

  it('AI 三变量齐全 + 已启用多用户 → aiConfigured/authEnabled 均 true 且回显 model', async () => {
    const admin = await enableMultiUser()
    process.env.AI_BASE_URL = 'https://api.deepseek.com'
    process.env.AI_API_KEY = 'sk-secret'
    process.env.AI_MODEL = 'deepseek-chat'
    const res = await GET(getReq(admin.cookie))
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
      deleteEnabled: false,
    })
  })

  it('AI 未配置 → aiConfigured=false、baseUrl/model 均 null；未启用多用户 → authEnabled=false', async () => {
    delete process.env.AI_BASE_URL
    delete process.env.AI_API_KEY
    delete process.env.AI_MODEL
    delete process.env.PASSWORD
    delete process.env.DELETE_ENABLED
    delete process.env.DELETE_PASSWORD
    // 无 users.json → 旧模式放行，且 authEnabled=false
    const body = await (await GET(getReq())).json()
    expect(body).toEqual({ aiConfigured: false, baseUrl: null, model: null, authEnabled: false, deleteEnabled: false })
  })

  it('删除保护开关：DELETE_ENABLED=true 且密码非空 → deleteEnabled=true；半配/关闭 → false', async () => {
    const admin = await enableMultiUser()
    process.env.DELETE_ENABLED = 'true'
    process.env.DELETE_PASSWORD = 'del-pw'
    let body = (await (await GET(getReq(admin.cookie))).json()) as { deleteEnabled: boolean }
    expect(body.deleteEnabled).toBe(true)
    delete process.env.DELETE_PASSWORD
    body = (await (await GET(getReq(admin.cookie))).json()) as { deleteEnabled: boolean }
    expect(body.deleteEnabled).toBe(false)
    process.env.DELETE_ENABLED = 'false'
    process.env.DELETE_PASSWORD = 'del-pw'
    body = (await (await GET(getReq(admin.cookie))).json()) as { deleteEnabled: boolean }
    expect(body.deleteEnabled).toBe(false)
    delete process.env.DELETE_ENABLED
    delete process.env.DELETE_PASSWORD
  })

  it('AI 变量缺一即 aiConfigured=false（三变量全非空的合取语义）', async () => {
    const admin = await enableMultiUser()
    process.env.AI_BASE_URL = 'https://api.deepseek.com'
    delete process.env.AI_API_KEY
    process.env.AI_MODEL = 'deepseek-chat'
    const body = await (await GET(getReq(admin.cookie))).json()
    expect(body.aiConfigured).toBe(false)
    expect(body.baseUrl).toBeNull()
    expect(body.model).toBeNull()
  })

  it('响应体绝不含 apiKey / deletePassword（红线断言）', async () => {
    const admin = await enableMultiUser()
    process.env.AI_BASE_URL = 'https://api.deepseek.com'
    process.env.AI_API_KEY = 'sk-secret-should-never-leak'
    process.env.AI_MODEL = 'deepseek-chat'
    process.env.DELETE_PASSWORD = 'del-secret-should-never-leak'
    const body = (await (await GET(getReq(admin.cookie))).json()) as Record<string, unknown>
    expect(Object.keys(body)).not.toContain('apiKey')
    expect(Object.keys(body)).not.toContain('deletePassword')
    expect(JSON.stringify(body)).not.toContain('sk-secret-should-never-leak')
    expect(JSON.stringify(body)).not.toContain('del-secret-should-never-leak')
    delete process.env.DELETE_ENABLED
    delete process.env.DELETE_PASSWORD
  })

  it('管理员会话才能读；member 会话也可以读（config 只读、非敏感）', async () => {
    await enableMultiUser()
    const member = await makeSession('普通成员', 'member')
    expect((await GET(getReq(member.cookie))).status).toBe(200)
  })
})
