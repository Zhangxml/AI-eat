// POST /api/ai/nutrition 单测：独立营养估算，温度 0.5 + 严格 JSON + 重试一次
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import { promises as fs } from 'node:fs'

vi.mock('@/lib/ai-client', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/ai-client')>()
  return { ...actual, aiComplete: vi.fn() }
})

import { POST } from './route'
import { issueToken } from '@/lib/auth'
import { aiComplete } from '@/lib/ai-client'

const aiCompleteMock = vi.mocked(aiComplete)
const good = '<nutrition>{"caloriesKcal":180,"proteinG":8,"fatG":10,"carbG":12,"estimated":true}</nutrition>'
const jsonReq = (body: unknown) =>
  new Request('http://x/api/ai/nutrition', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })

const ENV_KEYS = ['AI_BASE_URL', 'AI_API_KEY', 'AI_MODEL', 'AI_EAT_DATA_DIR', 'AI_TEMP_NUTRITION'] as const

describe('POST /api/ai/nutrition', () => {

  it('启用鉴权后未带会话 → 401（守卫在 handler 首行，未触 AI 调用）', async () => {
    process.env.PASSWORD = 'test-pw'
    try {
      const denied = await POST(jsonReq({ recipe: { name: '番茄炒蛋', ingredients: [{ name: '番茄', amount: '2个' }], servings: 2 } }))
      expect(denied.status).toBe(401)
      // 带合法会话则放行（继续走到参数/AI 环节，不再被守卫拦）
      const token = issueToken()
      const req2 = new Request('http://x/api/ai/nutrition', {
        method: 'POST',
        body: JSON.stringify({}),
        headers: { 'content-type': 'application/json', cookie: `ai-eat-session=${token}` },
      })
      expect((await POST(req2)).status).not.toBe(401)
    } finally {
      delete process.env.PASSWORD
    }
  })
  let dir: string
  let savedEnv: Record<string, string | undefined>

  beforeEach(async () => {
    savedEnv = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]))
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-eat-nutrition-api-'))
    process.env.AI_EAT_DATA_DIR = `${dir}/recipes`
    process.env.AI_BASE_URL = 'https://api.example.com'
    process.env.AI_API_KEY = 'sk-test'
    process.env.AI_MODEL = 'test-model'
    delete process.env.AI_TEMP_NUTRITION
    aiCompleteMock.mockReset()
  })

  afterEach(async () => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('成功返回四项营养，调用温度固定 0.5', async () => {
    aiCompleteMock.mockResolvedValueOnce(good)
    const res = await POST(jsonReq({ dish: '番茄炒蛋', ingredients: ['番茄', '鸡蛋'] }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      nutrition: { caloriesKcal: 180, proteinG: 8, fatG: 10, carbG: 12, estimated: true },
    })
    const [system, user] = aiCompleteMock.mock.calls[0][1]
    expect(system.content).toContain('<nutrition>')
    expect(user.content).toContain('番茄炒蛋')
    expect(user.content).toContain('番茄')
    expect(aiCompleteMock.mock.calls[0][2]).toEqual({ temperature: 0.5 })
  })

  it('解析失败重试一次，第二次用户消息附重试提示且温度不变', async () => {
    aiCompleteMock.mockResolvedValueOnce('不是 JSON').mockResolvedValueOnce(good)
    const res = await POST(jsonReq({ ingredients: ['番茄', '鸡蛋'] }))
    expect(res.status).toBe(200)
    expect(aiCompleteMock).toHaveBeenCalledTimes(2)
    expect(aiCompleteMock.mock.calls[1][1][1].content).toContain('上次输出无法解析')
    expect(aiCompleteMock.mock.calls[0][2]).toEqual({ temperature: 0.5 })
    expect(aiCompleteMock.mock.calls[1][2]).toEqual({ temperature: 0.5 })
  })

  it('缺 dish 和 ingredients、非法数组元素、超上限 → 400，且不调上游', async () => {
    const cases: unknown[] = [
      {},
      { dish: '  ', ingredients: [] },
      { ingredients: ['番茄', 1] },
      { ingredients: Array.from({ length: 51 }, () => '番茄') },
    ]
    for (const body of cases) {
      const res = await POST(jsonReq(body))
      expect(res.status).toBe(400)
    }
    expect(aiCompleteMock).not.toHaveBeenCalled()
  })

  it('steps 超限的 400 文案要指名具体原因（不能误导成「dish 与 ingredients 缺失」）', async () => {
    const res = await POST(jsonReq({ dish: '番茄炒蛋', steps: Array.from({ length: 51 }, () => '步骤') }))
    expect(res.status).toBe(400)
    const msg = ((await res.json()) as { error: string }).error
    // dish 已提供，文案不得说「至少提供一个」
    expect(msg).not.toContain('至少提供一个')
    expect(msg).toMatch(/最多|上限|过长/)
  })

  it('AI 未配置 → 503；两次解析失败 → 502', async () => {
    delete process.env.AI_BASE_URL
    delete process.env.AI_API_KEY
    delete process.env.AI_MODEL
    expect((await POST(jsonReq({ dish: '番茄炒蛋' }))).status).toBe(503)

    process.env.AI_BASE_URL = 'https://api.example.com'
    process.env.AI_API_KEY = 'sk-test'
    process.env.AI_MODEL = 'test-model'
    aiCompleteMock.mockResolvedValue('坏输出')
    const res = await POST(jsonReq({ dish: '番茄炒蛋' }))
    expect(res.status).toBe(502)
    expect(((await res.json()) as { error: string }).error).toContain('营养数据')
  })

  it('AI 输出负营养值 → 视为解析失败重试，两次都负则 502（不回填负值）', async () => {
    const negative = '<nutrition>{"caloriesKcal":-10,"proteinG":8,"fatG":10,"carbG":12,"estimated":true}</nutrition>'
    aiCompleteMock.mockResolvedValue(negative)
    const res = await POST(jsonReq({ dish: '番茄炒蛋' }))
    expect(res.status).toBe(502)
    expect(aiCompleteMock).toHaveBeenCalledTimes(2)
    // 负值输出不应被当作成功返回
    expect(((await res.json()) as { error: string }).error).toContain('营养数据')
  })

  it('AI_TEMP_NUTRITION 覆盖默认温度，越界值 clamp', async () => {    process.env.AI_TEMP_NUTRITION = '1.5'
    aiCompleteMock.mockResolvedValueOnce(good)
    await POST(jsonReq({ dish: '番茄炒蛋' }))
    expect(aiCompleteMock.mock.calls[0][2]).toEqual({ temperature: 1 })
  })
})
