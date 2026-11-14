// POST /api/ai/menu 单测（Task 13）：
// - vi.mock 掉 @/lib/ai-client 的 aiComplete（loadAiConfig 保持真实实现，走 process.env 真实路径测 503）
// - vi.mock 掉 @/lib/recipe-store 的 listRecipes（菜单接口只读库做推荐，不写盘）
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import path from 'node:path'
import os from 'node:os'
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
import { enableMultiUser } from '@/lib/test-helpers'
import { MENU_FORMAT_RULE } from '@/lib/ai-prompts'
import { aiComplete } from '@/lib/ai-client'
import { listRecipes } from '@/lib/recipe-store'
import type { Recipe } from '@/lib/recipe-types'

const aiCompleteMock = vi.mocked(aiComplete)
const listRecipesMock = vi.mocked(listRecipes)

// 库中已有菜（验证系统提示词注入库摘要；不再有「优先推荐已有菜」要求）
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
    { name: '番茄蛋汤', category: '汤', reason: '酸甜开胃，清爽解腻' },
  ],
  shopping: ['排骨 x1斤', '西兰花 x1颗', '番茄 x2'],
}
const aiOk = `<menu>${JSON.stringify(aiMenu)}</menu>`

// 分组采购夹具（7 天场景）：模型按品类分组输出
const aiMenuGrouped = {
  dishes: [
    { name: '红烧排骨', category: '荤菜', reason: '经典硬菜，下饭' },
    { name: '蒜蓉西兰花', category: '素菜', reason: '解腻均衡' },
  ],
  shopping: [
    { group: '肉禽蛋', items: ['排骨 2kg（可冷冻）', '鸡蛋 20 个（冷藏 2~3 周）'] },
    { group: '蔬菜', items: ['西兰花 3 颗（建议 3 天内吃完）'] },
  ],
}
const aiOkGrouped = `<menu>${JSON.stringify(aiMenuGrouped)}</menu>`

// 构造带 JSON body 的 POST 请求（handler 只读 body）
const jsonReq = (body: unknown) =>
  new Request('http://x/api/ai/menu', {
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

// 响应形态（断言用局部类型，避免全文硬编码比较）
interface MenuResponse {
  dishes: { name: string; category: string; reason: string }[]
  shopping: { group: string; items: string[] }[]
}
interface ErrorResponse {
  error: string
}

describe('POST /api/ai/menu', () => {

  it('启用鉴权后未带会话 → 401（守卫在 handler 首行，未触 AI 调用）', async () => {
    process.env.PASSWORD = 'test-password-default' // 切回密码模式
    const admin = await enableMultiUser()
    {
      const denied = await POST(jsonReq({ people: 2 }))
      expect(denied.status).toBe(401)
      // 带合法会话则放行（继续走到参数/AI 环节，不再被守卫拦）
      const req2 = new Request('http://x/api/ai/menu', {
        method: 'POST',
        body: JSON.stringify({}),
        headers: { 'content-type': 'application/json', cookie: admin.cookie },
      })
      expect((await POST(req2)).status).not.toBe(401)
    }
  })
  let dir: string
  let savedEnv: Record<string, string | undefined>

  beforeEach(async () => {
    // 本文件大多数用例不带 Cookie 直调 handler，默认走免密单用户模式；
    // 401 用例自己切回密码模式（见下一个 it）
    delete process.env.PASSWORD
    savedEnv = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]))
    // 隔离本地 .env 的温度覆盖，保证断言的是代码默认值
    delete process.env.AI_TEMP_CHAT
    delete process.env.AI_TEMP_MENU
    delete process.env.AI_TEMP_RECIPE
    delete process.env.AI_TEMP_NUTRITION
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-eat-menu-api-'))
    process.env.AI_EAT_DATA_DIR = `${dir}/recipes` // 指向子目录：日志落到独立的 ${dir}/logs，避免污染共享日志目录
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

  it('返回 dishes 与 shopping 且经 schema 校验（轻量无步骤，库摘要仅供参考、菜单强调创意）', async () => {
    aiCompleteMock.mockResolvedValueOnce(aiOk)
    const res = await POST(jsonReq({ people: 3, preference: '清淡' }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as MenuResponse
    expect(body.dishes.length).toBeGreaterThanOrEqual(2)
    // 采购清单为分组结构：每组 group 非空、items 为字符串数组
    expect(body.shopping.length).toBeGreaterThan(0)
    for (const g of body.shopping) {
      expect(typeof g.group).toBe('string')
      expect(g.group.length).toBeGreaterThan(0)
      expect(Array.isArray(g.items)).toBe(true)
    }
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
    // 用户消息含人数 / 偏好 / 荤素搭配 / 档位约束（默认 home：湖北家常优先，不注入反大路菜黑名单）
    // + 每次随机灵感方向；不再要求优先已有菜
    expect(userMsg.role).toBe('user')
    expect(userMsg.content).toContain('3 人')
    expect(userMsg.content).toContain('清淡')
    expect(userMsg.content).toContain('荤素搭配')
    expect(userMsg.content).toContain('湖北家常菜')
    expect(userMsg.content).toContain('本次灵感方向')
    expect(userMsg.content).not.toContain('已有菜谱')
    expect(userMsg.content).not.toContain('优先考虑')
    // 温度分层：买什么菜单固定 0.8（环境变量未覆盖）
    expect(aiCompleteMock.mock.calls[0][2]).toEqual({ temperature: 0.8 })
  })

  it('全局设置为 creative 时用户消息注入反大路菜约束（替换家常档位句）', async () => {
    // 档位来自服务端全局设置文件（data/settings.json），不再由请求 body 传入
    await fs.writeFile(`${dir}/settings.json`, JSON.stringify({ version: 1, style: 'creative' }), 'utf8')
    aiCompleteMock.mockResolvedValueOnce(aiOk)
    const res = await POST(jsonReq({ people: 3 }))
    expect(res.status).toBe(200)
    const userMsg = aiCompleteMock.mock.calls[0][1][1]
    expect(userMsg.content).toContain('避免番茄炒蛋')
    // creative 档不再说「湖北家常菜为主」
    expect(userMsg.content).not.toContain('湖北家常菜为主')
  })

  it('格式规则内嵌示例可被本接口解析（示例与 schema 一致，防「模型照抄坏示例」）', async () => {
    // 与 ai-prompts 的「番茄炒蛋示例可被提取且通过校验」同款约束：
    // 把系统提示词原文当作模型输出喂回来，必须能解析成功——否则模型照抄示例会导致每次调用都 502
    aiCompleteMock.mockResolvedValueOnce(MENU_FORMAT_RULE)
    const res = await POST(jsonReq({ people: 2 }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as MenuResponse
    expect(body.dishes.map(d => d.name)).toEqual(['番茄炒蛋', '清炒油麦菜'])
    expect(body.shopping).toEqual([
      { group: '蔬菜', items: ['番茄 x2', '油麦菜 x1把'] },
      { group: '肉禽蛋', items: ['鸡蛋 x3'] },
    ])
  })

  it('days=1（缺省）保持原有文案：不出现天数与采购基准，行为零变化', async () => {
    aiCompleteMock.mockResolvedValueOnce(aiOk)
    const res = await POST(jsonReq({ people: 3 }))
    expect(res.status).toBe(200)
    const userMsg = aiCompleteMock.mock.calls[0][1][1]
    expect(userMsg.content).not.toContain('要买')
    expect(userMsg.content).not.toContain('按 3 人 1 天')
    expect(userMsg.content).not.toContain('采购总量')
  })

  it('days=7 时用户消息含天数、菜数与采购总量基准', async () => {
    aiCompleteMock.mockResolvedValueOnce(aiOkGrouped)
    const res = await POST(jsonReq({ people: 3, days: 7 }))
    expect(res.status).toBe(200)
    const userMsg = aiCompleteMock.mock.calls[0][1][1]
    expect(userMsg.content).toContain('7 天')
    // 菜数指引 = min(days*3, 21)
    expect(userMsg.content).toContain('21 道')
    // 采购按 N 人 D 天估算，并给出人均日消耗基准
    expect(userMsg.content).toContain('按 3 人 7 天')
    expect(userMsg.content).toContain('肉类')
    // 不按天排
    expect(userMsg.content).not.toContain('第 1 天')
  })

  it('days=3 时菜数指引为 9 道', async () => {
    aiCompleteMock.mockResolvedValueOnce(aiOkGrouped)
    await POST(jsonReq({ people: 2, days: 3 }))
    expect(aiCompleteMock.mock.calls[0][1][1].content).toContain('9 道')
  })

  it('days 超出 1~7 / 非整数 / 非数字 → 400 且不触发 AI 调用', async () => {
    for (const days of [0, 8, 100, 2.5, '7', null, true]) {
      const res = await POST(jsonReq({ people: 2, days }))
      expect(res.status, `days=${JSON.stringify(days)}`).toBe(400)
      expect(((await res.json()) as ErrorResponse).error).toContain('days')
    }
    expect(aiCompleteMock).not.toHaveBeenCalled()
  })

  it('分组采购清单原样返回（group + items 结构）', async () => {
    aiCompleteMock.mockResolvedValueOnce(aiOkGrouped)
    const res = await POST(jsonReq({ people: 3, days: 7 }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as MenuResponse
    expect(body.shopping).toEqual(aiMenuGrouped.shopping)
  })

  it('菜单/分组含多余字段时不整份作废，剥离未知键后正常返回（不浪费一次上游调用）', async () => {
    // 模型偶尔会自作主张加字段（tips/note/purchased 等）。strict 会让整份 7 天菜单作废并重试，
    // 代价是 35 秒 + 3.5k tokens；这里只要求「认得的值保留、多余键剥离」。
    const noisy = {
      tips: '买菜小贴士：周末人多，提前买肉',
      dishes: [
        { name: '番茄炒蛋', category: '荤菜', reason: '家常', difficulty: '简单' },
        { name: '蒜蓉油麦菜', category: '素菜', reason: '清爽', servings: 3 },
      ],
      shopping: [
        { group: '蔬菜', items: ['番茄 x2', '油麦菜 x1把'], note: '选叶子挺的' },
        { group: '肉禽蛋', items: ['鸡蛋 x3'], budget: 20 },
      ],
    }
    aiCompleteMock.mockResolvedValueOnce(`<menu>${JSON.stringify(noisy)}</menu>`)
    const res = await POST(jsonReq({ people: 2, days: 7 }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as MenuResponse
    expect(body.dishes.map(d => d.name)).toEqual(['番茄炒蛋', '蒜蓉油麦菜'])
    expect(body.shopping).toEqual([
      { group: '蔬菜', items: ['番茄 x2', '油麦菜 x1把'] },
      { group: '肉禽蛋', items: ['鸡蛋 x3'] },
    ])
    // 多余键必须被剥离，而不是原样透传给前端（避免把模型噪声带进 UI 契约）
    expect(Object.keys(body).sort()).toEqual(['dishes', 'shopping'])
    for (const d of body.dishes) expect(Object.keys(d).sort()).toEqual(['category', 'name', 'reason'])
    for (const g of body.shopping) expect(Object.keys(g).sort()).toEqual(['group', 'items'])
    // 未触发重试：多余字段是「可容忍的噪声」，不该花第二次 AI 调用
    expect(aiCompleteMock).toHaveBeenCalledTimes(1)
  })

  it('结构/类型错误一律作废并重试（宽松仅针对多余键，不放过脏结构）', async () => {
    // 逐个验证：这些都不该被「去掉 strict」放过
    const broken: unknown[] = [
      { dishes: [], shopping: [] },                                   // 空菜单
      { dishes: [{ name: '番茄炒蛋', category: '甜点', reason: 'x' }], shopping: [] }, // 非法 category
      { dishes: [{ name: 1, category: '荤菜', reason: 'x' }], shopping: [] },          // name 非字符串
      { dishes: ['x'], shopping: [] },                                 // 元素不是对象
      { dishes: [{ name: '番茄炒蛋', category: '荤菜', reason: 'x' }] },               // 缺 shopping
      { dishes: [{ name: '番茄炒蛋', category: '荤菜', reason: 'x' }], shopping: [{ group: '', items: ['x'] }] }, // 空 group
      { dishes: [{ name: '番茄炒蛋', category: '荤菜', reason: 'x' }], shopping: [{ group: '蔬菜', items: [1] }] }, // items 非字符串
    ]
    for (const bad of broken) {
      aiCompleteMock.mockReset()
      aiCompleteMock.mockResolvedValueOnce(`<menu>${JSON.stringify(bad)}</menu>`) // 首次失败
      aiCompleteMock.mockResolvedValueOnce(aiOkGrouped)                            // 重试成功
      const res = await POST(jsonReq({ people: 2 }))
      const label = JSON.stringify(bad)
      expect(aiCompleteMock.mock.calls.length, label).toBe(2)
      expect(res.status, label).toBe(200)
    }
  })

  it('纯空白 reason 被接受（既有行为：min(1) 不 trim）——锁定现状，改动须是有意为之', async () => {
    // 这不是本次宽松化带来的：去 strict 之前 min(1) 同样不 trim。
    // 记录在此，避免将来有人误以为「去掉 strict 导致脏数据入结构」。
    const blankReason = {
      dishes: [{ name: '番茄炒蛋', category: '荤菜', reason: '   ' }],
      shopping: [],
    }
    aiCompleteMock.mockResolvedValueOnce(`<menu>${JSON.stringify(blankReason)}</menu>`)
    const res = await POST(jsonReq({ people: 2 }))
    expect(res.status).toBe(200)
    expect(aiCompleteMock).toHaveBeenCalledTimes(1)
  })

  it('菜品缺必填字段时仍然整份作废（宽松只针对多余键，不放过结构错误）', async () => {
    const broken = {
      dishes: [{ name: '番茄炒蛋', category: '荤菜' }], // 缺 reason
      shopping: [{ group: '蔬菜', items: ['番茄 x2'] }],
    }
    aiCompleteMock.mockResolvedValueOnce(`<menu>${JSON.stringify(broken)}</menu>`) // 首次失败
    aiCompleteMock.mockResolvedValueOnce(aiOkGrouped) // 重试成功
    const res = await POST(jsonReq({ people: 2 }))
    expect(res.status).toBe(200)
    expect(aiCompleteMock).toHaveBeenCalledTimes(2)
  })

  it('同名分组自动合并（避免前端重复 key 与同一品类分散多处）', async () => {
    const dup = {
      dishes: [{ name: '番茄炒蛋', category: '荤菜', reason: '家常' }],
      shopping: [
        { group: '蔬菜', items: ['番茄 x2'] },
        { group: '肉禽蛋', items: ['鸡蛋 x3'] },
        { group: '蔬菜', items: ['青菜 x1把'] },
      ],
    }
    aiCompleteMock.mockResolvedValueOnce(`<menu>${JSON.stringify(dup)}</menu>`)
    const res = await POST(jsonReq({ people: 2, days: 2 }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as MenuResponse
    // 保留首次出现的顺序，同名分组合并 items
    expect(body.shopping).toEqual([
      { group: '蔬菜', items: ['番茄 x2', '青菜 x1把'] },
      { group: '肉禽蛋', items: ['鸡蛋 x3'] },
    ])
  })

  it('模型退回旧的扁平字符串数组时自动归一化为单组，不触发重试', async () => {
    aiCompleteMock.mockResolvedValueOnce(aiOk) // 夹具 shopping 为 string[]
    const res = await POST(jsonReq({ people: 3, days: 7 }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as MenuResponse
    expect(body.shopping).toHaveLength(1)
    expect(body.shopping[0].items).toEqual(aiMenu.shopping)
    // 容错归一化而非解析失败：只调用一次
    expect(aiCompleteMock).toHaveBeenCalledTimes(1)
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
      { people: 51 }, // 超过人数上限（审查修复：防 people=1e9 生成超长提示词/巨额 token）
      { people: 2, preference: '清'.repeat(501) }, // preference 超 500 字符
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
