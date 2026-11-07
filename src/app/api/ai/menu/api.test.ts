// POST /api/ai/menu 单测（Task 13）：
// - vi.mock 掉 @/lib/ai-client 的 aiComplete（loadAiConfig 保持真实实现，走 process.env 真实路径测 503）
// - vi.mock 掉 @/lib/recipe-store 的 listRecipes（菜单接口只读库做推荐，不写盘）
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'

vi.mock('@/lib/ai-client', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/ai-client')>()
  return { ...actual, aiComplete: vi.fn() }
})
vi.mock('@/lib/recipe-store', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/recipe-store')>()
  return { ...actual, listRecipes: vi.fn() }
})

import { POST } from './route'
import { aiComplete } from '@/lib/ai-client'
import { listRecipes } from '@/lib/recipe-store'
import type { Recipe } from '@/lib/recipe-types'

const aiCompleteMock = vi.mocked(aiComplete)
const listRecipesMock = vi.mocked(listRecipes)

// 库中已有菜（验证系统提示词注入库摘要 + 用户消息强调「已有菜谱」优先）
const libRecipe: Recipe = {
  id: 'r-1730000000-ab12cd',
  name: '番茄炒蛋',
  category: '荤菜',
  servings: 2,
  difficulty: '简单',
  totalTimeMin: 20,
  tags: ['家常菜', '快手菜'],
  ingredients: [
    { name: '番茄', amount: '2个' },
    { name: '鸡蛋', amount: '3个' },
  ],
  steps: ['番茄切块', '热锅下油炒蛋', '下番茄翻炒调味'],
  nutrition: { caloriesKcal: 180, proteinG: 8, fatG: 10, carbG: 12, estimated: true },
  source: 'manual',
  createdAt: '2026-11-07T00:00:00.000Z',
  updatedAt: '2026-11-07T00:00:00.000Z',
}

// AI 输出夹具：<menu> 标签包裹的合法菜单 JSON（三道菜 + 采购清单）
const aiMenu = {
  dishes: [
    { name: '红烧排骨', category: '荤菜', reason: '经典硬菜，下饭' },
    { name: '蒜蓉西兰花', category: '素菜', reason: '解腻均衡' },
    { name: '番茄蛋汤', category: '汤', reason: '库中已有的菜优先考虑' },
  ],
  shopping: ['排骨 x1斤', '西兰花 x1颗', '番茄 x2'],
}
const aiOk = `<menu>${JSON.stringify(aiMenu)}</menu>`

// 构造带 JSON body 的 POST 请求（handler 只读 body）
const jsonReq = (body: unknown) =>
  new Request('http://x/api/ai/menu', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })

// 需要接管并在 afterEach 恢复的环境变量
const ENV_KEYS = ['AI_BASE_URL', 'AI_API_KEY', 'AI_MODEL', 'AI_EAT_DATA_DIR'] as const

// 响应形态（断言用局部类型，避免全文硬编码比较）
interface MenuResponse {
  dishes: { name: string; category: string; reason: string }[]
  shopping: string[]
}
interface ErrorResponse {
  error: string
}

describe('POST /api/ai/menu', () => {
  let dir: string
  let savedEnv: Record<string, string | undefined>

  beforeEach(async () => {
    savedEnv = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]))
    dir = await fs.mkdtemp('/tmp/opencode/ai-eat-menu-api-')
    process.env.AI_EAT_DATA_DIR = dir
    // AI 配置默认给全（真实 loadAiConfig 可通过）；503 用例里再清空
    process.env.AI_BASE_URL = 'https://api.example.com'
    process.env.AI_API_KEY = 'sk-test'
    process.env.AI_MODEL = 'test-model'
    aiCompleteMock.mockReset()
    listRecipesMock.mockReset().mockResolvedValue({ recipes: [{ ...libRecipe }], invalidFiles: [] })
  })

  afterEach(async () => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('返回 dishes 与 shopping 且经 schema 校验（轻量无步骤，库摘要与已有菜谱强调进提示词）', async () => {
    aiCompleteMock.mockResolvedValueOnce(aiOk)
    const res = await POST(jsonReq({ people: 3, preference: '清淡' }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as MenuResponse
    expect(body.dishes.length).toBeGreaterThanOrEqual(2)
    expect(Array.isArray(body.shopping)).toBe(true)
    // 轻量契约：每道菜只有 name/category/reason 三字段（无步骤类字段），category 限五枚举
    for (const d of body.dishes) {
      expect(Object.keys(d).sort()).toEqual(['category', 'name', 'reason'])
      expect(typeof d.name).toBe('string')
      expect(['荤菜', '素菜', '汤', '主食', '其他']).toContain(d.category)
      expect(typeof d.reason).toBe('string')
    }
    // 系统消息 = 人设 + 库摘要 + <menu> 格式规则
    const [sysMsg, userMsg] = aiCompleteMock.mock.calls[0][1]
    expect(sysMsg.role).toBe('system')
    expect(sysMsg.content).toContain('<menu>')
    expect(sysMsg.content).toContain('番茄炒蛋｜食材:番茄,鸡蛋')
    // 用户消息含人数 / 偏好 / 荤素搭配 / 已有菜谱优先强调
    expect(userMsg.role).toBe('user')
    expect(userMsg.content).toContain('3 人')
    expect(userMsg.content).toContain('清淡')
    expect(userMsg.content).toContain('荤素搭配')
    expect(userMsg.content).toContain('已有菜谱')
  })

  it('people=4 时用户消息附份量级提示（建议菜数不少于 4 道）', async () => {
    aiCompleteMock.mockResolvedValueOnce(aiOk)
    const res = await POST(jsonReq({ people: 4 }))
    expect(res.status).toBe(200)
    expect(aiCompleteMock.mock.calls[0][1][1].content).toContain('建议菜数不少于 4 道')
  })

  it('解析失败自动重试一次：第二次用户消息附「上次输出无法解析，请严格按格式重发」，aiComplete 恰 2 次', async () => {
    aiCompleteMock.mockResolvedValueOnce('这不是 JSON').mockResolvedValueOnce(aiOk)
    const res = await POST(jsonReq({ people: 2 }))
    expect(res.status).toBe(200)
    expect(((await res.json()) as MenuResponse).dishes.length).toBe(3)
    expect(aiCompleteMock).toHaveBeenCalledTimes(2)
    const firstMsgs = aiCompleteMock.mock.calls[0][1]
    const secondMsgs = aiCompleteMock.mock.calls[1][1]
    // 系统消息两次一致；第二次用户消息 = 原消息 + 重试提示
    expect(secondMsgs[0].content).toBe(firstMsgs[0].content)
    expect(secondMsgs[1].content).toContain('上次输出无法解析，请严格按格式重发')
    expect(firstMsgs[1].content).not.toContain('上次输出无法解析')
  })

  it('AI 输出 JSON 缺字段（zod 校验失败）同样触发重试', async () => {
    const missingReason = `<menu>${JSON.stringify({ dishes: [{ name: '红烧排骨', category: '荤菜' }], shopping: [] })}</menu>`
    aiCompleteMock.mockResolvedValueOnce(missingReason).mockResolvedValueOnce(aiOk)
    const res = await POST(jsonReq({ people: 2 }))
    expect(res.status).toBe(200)
    expect(aiCompleteMock).toHaveBeenCalledTimes(2)
  })

  it('两次失败返回 502（中文 error），aiComplete 恰 2 次', async () => {
    aiCompleteMock.mockResolvedValue('这不是 JSON')
    const res = await POST(jsonReq({ people: 2 }))
    expect(res.status).toBe(502)
    expect(((await res.json()) as ErrorResponse).error).toMatch(/两次均无法解析/)
    expect(aiCompleteMock).toHaveBeenCalledTimes(2)
  })

  it('上游异常两次也按 502 处理且带上游错误详情', async () => {
    aiCompleteMock.mockRejectedValue(new Error('AI 上游请求失败：HTTP 500'))
    const res = await POST(jsonReq({ people: 2 }))
    expect(res.status).toBe(502)
    const { error } = (await res.json()) as ErrorResponse
    expect(error).toMatch(/两次均无法解析/)
    expect(error).toContain('AI 上游请求失败：HTTP 500')
    expect(aiCompleteMock).toHaveBeenCalledTimes(2)
  })

  it('people 缺失/非法 → 400（中文 error），且不触发任何 AI 调用', async () => {
    const badBodies: unknown[] = [
      {}, // people 缺失
      { people: 0 }, // 小于 1
      { people: -2 }, // 负数
      { people: 2.5 }, // 非整数
      { people: '3' }, // 非数字
    ]
    for (const body of badBodies) {
      const res = await POST(jsonReq(body))
      expect(res.status, `body=${JSON.stringify(body)}`).toBe(400)
      expect(((await res.json()) as ErrorResponse).error).toMatch(/人数|参数/)
    }
    // 非 JSON body 同样 400
    const bad = await POST(
      new Request('http://x/api/ai/menu', {
        method: 'POST',
        body: 'not-json',
        headers: { 'content-type': 'application/json' },
      }),
    )
    expect(bad.status).toBe(400)
    expect(((await bad.json()) as ErrorResponse).error).toMatch(/人数|参数/)
    // 参数非法时不应触发任何 AI 调用
    expect(aiCompleteMock).not.toHaveBeenCalled()
  })

  it('preference 非字符串 → 400', async () => {
    const res = await POST(jsonReq({ people: 2, preference: 123 }))
    expect(res.status).toBe(400)
    expect(((await res.json()) as ErrorResponse).error).toMatch(/人数|参数/)
    expect(aiCompleteMock).not.toHaveBeenCalled()
  })

  it('AI 未配置 → 503 + 中文提示（loadAiConfig 走真实 env 路径）', async () => {
    delete process.env.AI_BASE_URL
    delete process.env.AI_API_KEY
    delete process.env.AI_MODEL
    const res = await POST(jsonReq({ people: 2 }))
    expect(res.status).toBe(503)
    expect(((await res.json()) as ErrorResponse).error).toMatch(/AI 配置缺失/)
    // 未配置时不应触发任何 AI 调用
    expect(aiCompleteMock).not.toHaveBeenCalled()
  })
})
