// AI 客户端单测：用 vi.stubGlobal('fetch', vi.fn()) 模拟上游（node 环境，无真实网络调用）
import { afterEach, describe, expect, it, vi } from 'vitest'
import { aiChatStream, aiComplete, loadAiConfig, type AiConfig } from './ai-client'

// 测试用配置（不发起真实请求，值仅用于断言 URL 与请求头）
const cfg: AiConfig = { baseUrl: 'https://api.deepseek.com', apiKey: 'sk-test', model: 'deepseek-chat' }

// 构造上游 200 响应形态（aiComplete 只调用 res.json()）
const okResponse = (body: unknown) => ({ ok: true, status: 200, json: async () => body })

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('AI 客户端', () => {
  it('loadAiConfig 缺变量抛中文错误', () => {
    // Next 的 global.d.ts 把 ProcessEnv.NODE_ENV 声明为必填，测试局部 env 只注入 AI_* 变量，
    // 直转 as NodeJS.ProcessEnv 因重叠不足被 TS 拒绝，须经 unknown 中转（测试语义不变）
    const empty = {} as unknown as NodeJS.ProcessEnv
    expect(() => loadAiConfig(empty)).toThrow(/AI 配置缺失/)
    // 缺其中一个也抛
    expect(() =>
      loadAiConfig({ AI_BASE_URL: 'https://x', AI_API_KEY: 'k' } as unknown as NodeJS.ProcessEnv),
    ).toThrow(/AI 配置缺失：请设置 AI_BASE_URL \/ AI_API_KEY \/ AI_MODEL/)
  })

  it('loadAiConfig 三变量齐全时返回配置', () => {
    expect(
      loadAiConfig({
        AI_BASE_URL: 'https://x/',
        AI_API_KEY: 'k',
        AI_MODEL: 'm',
      } as unknown as NodeJS.ProcessEnv),
    ).toEqual({ baseUrl: 'https://x/', apiKey: 'k', model: 'm' })
  })

  it('aiComplete 取 content', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(okResponse({ choices: [{ message: { content: '菜谱正文' } }] })),
    )
    expect(await aiComplete(cfg, [{ role: 'user', content: 'hi' }])).toBe('菜谱正文')
  })

  it('aiComplete 请求 URL / 请求头 / 请求体（stream:false）正确', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(okResponse({ choices: [{ message: { content: 'x' } }] }))
    vi.stubGlobal('fetch', fetchMock)
    await aiComplete(cfg, [{ role: 'user', content: 'hi' }])
    // URL：POST {baseUrl}/chat/completions
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.deepseek.com/chat/completions')
    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect(init.method).toBe('POST')
    // 请求头：仅 Authorization(Bearer) + Content-Type，不透传其他敏感头
    expect(init.headers).toEqual({
      Authorization: 'Bearer sk-test',
      'Content-Type': 'application/json',
    })
    // 请求体（字符串断言后再解析）
    expect(init.body).toContain('"stream":false')
    expect(JSON.parse(init.body as string)).toEqual({
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    })
  })

  it('上游非 200 抛错且带状态码', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }))
    await expect(aiComplete(cfg, [{ role: 'user', content: 'hi' }])).rejects.toThrow(/500/)
    await expect(aiChatStream(cfg, [{ role: 'user', content: 'hi' }])).rejects.toThrow(/500/)
  })

  it('aiChatStream 请求体 stream:true 且返回原始上游 Response', async () => {
    const raw = { ok: true, status: 200 } as unknown as Response
    const fetchMock = vi.fn().mockResolvedValue(raw)
    vi.stubGlobal('fetch', fetchMock)
    const res = await aiChatStream(cfg, [{ role: 'user', content: 'hi' }])
    // 返回原始上游 Response，本模块不做 SSE 解析
    expect(res).toBe(raw)
    // 断言 mock fetch 收到的 body 字符串含 '"stream":true'
    expect((fetchMock.mock.calls[0][1] as RequestInit).body).toContain('"stream":true')
  })

  it('baseUrl 末尾斜杠归一化：带斜杠与不带斜杠拼出同一端点', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(okResponse({ choices: [{ message: { content: 'x' } }] }))
    vi.stubGlobal('fetch', fetchMock)
    await aiComplete({ ...cfg, baseUrl: 'https://api.deepseek.com/' }, [])
    await aiComplete({ ...cfg, baseUrl: 'https://api.deepseek.com' }, [])
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.deepseek.com/chat/completions')
    expect(fetchMock.mock.calls[1][0]).toBe('https://api.deepseek.com/chat/completions')
  })
})
