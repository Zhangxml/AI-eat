// POST /api/ai/recipes 单测（Task 10）：
// - vi.mock 掉 @/lib/ai-client 的 aiComplete（loadAiConfig 保持真实实现，走 process.env 真实路径测 503）
// - vi.mock 掉 @/lib/recipe-store 的 listRecipes / createRecipe（createRecipe 一旦被调即抛错，锁死「不写盘」）
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'

vi.mock('@/lib/ai-client', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/ai-client')>()
  return { ...actual, aiComplete: vi.fn() }
})
vi.mock('@/lib/recipe-store', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/recipe-store')>()
  return { ...actual, listRecipes: vi.fn(), createRecipe: vi.fn() }
})

import { POST } from './route'
import { aiComplete } from '@/lib/ai-client'
import { listRecipes, createRecipe } from '@/lib/recipe-store'
import { RECIPE_FORMAT_RULE } from '@/lib/ai-prompts'
import type { Recipe } from '@/lib/recipe-types'

const aiCompleteMock = vi.mocked(aiComplete)
const listRecipesMock = vi.mocked(listRecipes)
const createRecipeMock = vi.mocked(createRecipe)

// AI 输出夹具：完整合法菜谱，但 id 照抄提示词示例（r-1730000000-ab12cd，可过 strict schema）、
// 时间戳给 2020 年旧值——用于锁定「解析成功后必须无条件覆写 id/createdAt/updatedAt」的硬条件
const aiRecipe: Recipe = {
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
  source: 'ai',
  createdAt: '2020-01-01T00:00:00.000Z',
  updatedAt: '2020-01-01T00:00:00.000Z',
}
// <recipe> 标签包裹的合法输出（extractRecipeJson 三形态之一）
const aiOk = `<recipe>${JSON.stringify(aiRecipe)}</recipe>`

// 构造带 JSON body 的 POST 请求（handler 只读 body）
const jsonReq = (body: unknown) =>
  new Request('http://x/api/ai/recipes', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })

// 需要接管并在 afterEach 恢复的环境变量
const ENV_KEYS = [
  'AI_BASE_URL',
  'AI_API_KEY',
  'AI_MODEL',
  'AI_EAT_DATA_DIR',
  'AI_TEMP_CHAT',
  'AI_TEMP_MENU',
  'AI_TEMP_RECIPE',
  'AI_TEMP_NUTRITION',
] as const

// 成功响应形态（断言用局部类型，避免全文硬编码比较）
interface AiRecipeResponse {
  recipe: { id: string; name: string; source: string; createdAt: string; updatedAt: string }
}
interface ErrorResponse {
  error: string
}

describe('POST /api/ai/recipes', () => {
  let dir: string
  let savedEnv: Record<string, string | undefined>

  beforeEach(async () => {
    savedEnv = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]))
    // 隔离本地 .env 的温度覆盖，保证断言的是代码默认值
    delete process.env.AI_TEMP_CHAT
    delete process.env.AI_TEMP_MENU
    delete process.env.AI_TEMP_RECIPE
    delete process.env.AI_TEMP_NUTRITION
    dir = await fs.mkdtemp('/tmp/opencode/ai-eat-ai-api-')
    process.env.AI_EAT_DATA_DIR = dir
    // AI 配置默认给全（真实 loadAiConfig 可通过）；503 用例里再清空
    process.env.AI_BASE_URL = 'https://api.example.com'
    process.env.AI_API_KEY = 'sk-test'
    process.env.AI_MODEL = 'test-model'
    aiCompleteMock.mockReset()
    // createRecipe 一旦被调即抛错：接口若误写盘，测试会以该错误响亮失败
    createRecipeMock.mockReset().mockRejectedValue(new Error('测试失败：接口不应写盘'))
    listRecipesMock.mockReset().mockResolvedValue({ recipes: [], invalidFiles: [] })
  })

  afterEach(async () => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('按食材生成并解析成功：source=ai，id/时间戳被无条件覆写（AI 照抄示例 id 也被替换）', async () => {
    listRecipesMock.mockResolvedValue({ recipes: [{ ...aiRecipe }], invalidFiles: [] })
    aiCompleteMock.mockResolvedValueOnce(aiOk)
    const res = await POST(jsonReq({ ingredients: ['番茄', '鸡蛋'], servings: 2 }))
    expect(res.status).toBe(200)
    const { recipe } = (await res.json()) as AiRecipeResponse
    expect(recipe.source).toBe('ai')
    expect(recipe.name).toBe('番茄炒蛋')
    // 硬条件：AI 照抄示例 id / 旧时间戳必须被无条件替换
    expect(recipe.id).not.toBe('r-1730000000-ab12cd')
    expect(recipe.id).toMatch(/^r-\d+-[0-9a-f]{6}$/)
    expect(recipe.createdAt).not.toBe('2020-01-01T00:00:00.000Z')
    expect(recipe.createdAt).toBe(recipe.updatedAt)
    expect(Number.isNaN(Date.parse(recipe.createdAt))).toBe(false)
    // 不写盘：目录仍为空
    expect(createRecipeMock).not.toHaveBeenCalled()
    expect(await fs.readdir(dir)).toEqual([])
    // 系统消息 = 人设（含库摘要）+ 格式规则；用户消息含食材与份数
    const [sysMsg, userMsg] = aiCompleteMock.mock.calls[0][1]
    expect(sysMsg.role).toBe('system')
    expect(sysMsg.content).toContain(RECIPE_FORMAT_RULE)
    expect(sysMsg.content).toContain('番茄炒蛋｜食材:番茄,鸡蛋')
    expect(userMsg.role).toBe('user')
    expect(userMsg.content).toContain('番茄')
    expect(userMsg.content).toContain('鸡蛋')
    expect(userMsg.content).toContain('2 人份')
    // 食材模式注入本次灵感（缓解固定搭配）；完整菜谱温度固定 0.7
    expect(userMsg.content).toContain('本次灵感方向')
    expect(aiCompleteMock.mock.calls[0][2]).toEqual({ temperature: 0.7 })
  })

  it('解析失败自动重试一次：第二次用户消息附「上次输出无法解析，请严格按格式重发」', async () => {
    aiCompleteMock.mockResolvedValueOnce('这不是 JSON').mockResolvedValueOnce(aiOk)
    const res = await POST(jsonReq({ ingredients: ['番茄', '鸡蛋'] }))
    expect(res.status).toBe(200)
    expect(((await res.json()) as AiRecipeResponse).recipe.name).toBe('番茄炒蛋')
    expect(aiCompleteMock).toHaveBeenCalledTimes(2)
    const firstMsgs = aiCompleteMock.mock.calls[0][1]
    const secondMsgs = aiCompleteMock.mock.calls[1][1]
    // 系统消息两次一致；第二次用户消息 = 原消息 + 重试提示
    expect(secondMsgs[0].content).toBe(firstMsgs[0].content)
    expect(secondMsgs[1].content).toContain('番茄')
    expect(secondMsgs[1].content).toContain('上次输出无法解析，请严格按格式重发')
    expect(firstMsgs[1].content).not.toContain('上次输出无法解析')
  })

  it('两次失败返回 502 且不写盘', async () => {
    aiCompleteMock.mockResolvedValue('这不是 JSON')
    const res = await POST(jsonReq({ ingredients: ['番茄', '鸡蛋'] }))
    expect(res.status).toBe(502)
    expect(((await res.json()) as ErrorResponse).error).toMatch(/两次均无法解析/)
    expect(aiCompleteMock).toHaveBeenCalledTimes(2)
    expect(createRecipeMock).not.toHaveBeenCalled()
    expect(await fs.readdir(dir)).toEqual([])
  })

  it('上游异常两次也按 502 处理且带上游错误详情', async () => {
    aiCompleteMock.mockRejectedValue(new Error('AI 上游请求失败：HTTP 500'))
    const res = await POST(jsonReq({ dish: '鱼香肉丝' }))
    expect(res.status).toBe(502)
    const { error } = (await res.json()) as ErrorResponse
    expect(error).toMatch(/两次均无法解析/)
    expect(error).toContain('AI 上游请求失败：HTTP 500')
    expect(aiCompleteMock).toHaveBeenCalledTimes(2)
    expect(createRecipeMock).not.toHaveBeenCalled()
  })

  it('按菜名生成时不注入灵感种子，避免把明确菜名带偏', async () => {
    aiCompleteMock.mockResolvedValueOnce(aiOk)
    const res = await POST(jsonReq({ dish: '红烧鱼' }))
    expect(res.status).toBe(200)
    const userMsg = aiCompleteMock.mock.calls[0][1][1]
    expect(userMsg.content).toContain('红烧鱼')
    expect(userMsg.content).not.toContain('本次灵感方向')
    expect(aiCompleteMock.mock.calls[0][2]).toEqual({ temperature: 0.7 })
  })

  it('ingredients 与 dish 均缺省 → 400（含类型非法与非 JSON body）', async () => {
    const badBodies: unknown[] = [
      {},
      { ingredients: [], dish: '  ' },
      { ingredients: ['  '], dish: '' },
      { ingredients: '番茄' }, // 非数组
      { dish: 123 }, // 非字符串
      { ingredients: ['番茄'], servings: 0 }, // servings 非正整数
    ]
    for (const body of badBodies) {
      const res = await POST(jsonReq(body))
      expect(res.status, `body=${JSON.stringify(body)}`).toBe(400)
      expect(((await res.json()) as ErrorResponse).error).toMatch(/食材|菜名|参数/)
    }
    // 非 JSON body 同样 400
    const bad = await POST(
      new Request('http://x/api/ai/recipes', {
        method: 'POST',
        body: 'not-json',
        headers: { 'content-type': 'application/json' },
      }),
    )
    expect(bad.status).toBe(400)
    expect(((await bad.json()) as ErrorResponse).error).toMatch(/食材|菜名|参数/)
    // 参数非法时不应触发任何 AI 调用
    expect(aiCompleteMock).not.toHaveBeenCalled()
  })

  it('按菜名生成成功：dish 与 servings 透传用户消息', async () => {
    aiCompleteMock.mockResolvedValueOnce(aiOk)
    const res = await POST(jsonReq({ dish: '鱼香肉丝', servings: 3 }))
    expect(res.status).toBe(200)
    expect(((await res.json()) as AiRecipeResponse).recipe.source).toBe('ai')
    const userMsg = aiCompleteMock.mock.calls[0][1][1]
    expect(userMsg.content).toContain('鱼香肉丝')
    expect(userMsg.content).toContain('3 人份')
    expect(userMsg.content).not.toContain('现有食材')
  })

  it('AI 未配置 → 503 + 中文提示（loadAiConfig 走真实 env 路径）', async () => {
    delete process.env.AI_BASE_URL
    delete process.env.AI_API_KEY
    delete process.env.AI_MODEL
    const res = await POST(jsonReq({ ingredients: ['番茄'] }))
    expect(res.status).toBe(503)
    expect(((await res.json()) as ErrorResponse).error).toMatch(/AI 配置缺失/)
    // 未配置时不应触发任何 AI 调用
    expect(aiCompleteMock).not.toHaveBeenCalled()
  })
})
