// POST /api/ai/chat：SSE 聊天接口（Task 11，设计 5.2）
// 契约：body { messages: ChatMessage[] }（非空数组）→ SSE 流（text/event-stream，协议见 src/lib/sse.ts）：
//   event: message  data:{"t":"<增量>"}     —— <recipe> 标签出现前的上游正文增量
//   event: recipe   data:<完整 Recipe>      —— </recipe> 闭合后 extractRecipeJson 成功（id/createdAt/updatedAt/source 无条件覆写）
//   event: error    data:{"error":"<中文>"}  —— 解析失败重试一次仍失败（随后照常 done 收尾，不中断流）
//   event: done     data:{}                 —— 上游结束后收尾
// 错误形态（均非 SSE）：400 { error }（body 无 messages / 空数组 / 消息项非法）
// | 503 { error }（AI 未配置，loadAiConfig throw）| 502 { error }（上游请求失败 aiChatStream throw）
// 实现说明：未用 TransformStream 而是手动泵上游 reader——闭合后的菜谱提取/重试（aiComplete）是异步工作，
// 在 pump 循环结束后统一处理，比 transform/flush 同步回调里排异步任务更可控，且便于接入 request.signal 取消
import { loadAiConfig, aiChatStream, aiComplete, type ChatMessage } from '@/lib/ai-client'
import { systemPromptWithLibrary, RECIPE_FORMAT_RULE, CHAT_MENU_FORMAT_RULE, extractRecipeJson, extractChatMenuJson } from '@/lib/ai-prompts'
import { listRecipes } from '@/lib/recipe-store'
import { makeRecipeId, type Recipe } from '@/lib/recipe-types'
import { sseEvent, sseHeaders } from '@/lib/sse'
import { requireAuth } from '@/lib/auth'
import { appendAccessLog, clientIpOf } from '@/lib/access-log'

// 重试提示（与 Task 10 同款提示词模式；测试断言依赖此文案）
const RETRY_HINT = '上次输出无法解析，请严格按格式重发'

const OPEN_TAG = '<recipe>'
const CLOSE_TAG = '</recipe>'

// 校验 body：messages 须为非空数组，每项为合法 ChatMessage（role 枚举 + 字符串 content）；非法返回 null（route 层转 400）
async function parseInput(req: Request): Promise<ChatMessage[] | null> {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return null
  }
  if (typeof body !== 'object' || body === null) return null
  const messages = (body as { messages?: unknown }).messages
  if (!Array.isArray(messages) || messages.length === 0) return null
  const out: ChatMessage[] = []
  for (const m of messages) {
    if (typeof m !== 'object' || m === null) return null
    const { role, content } = m as Record<string, unknown>
    if ((role !== 'system' && role !== 'user' && role !== 'assistant') || typeof content !== 'string') {
      return null
    }
    out.push({ role, content })
  }
  return out
}

const OPEN_RECIPE = '<recipe>'
const CLOSE_RECIPE = '</recipe>'
const OPEN_MENU = '<menu>'
const CLOSE_MENU = '</menu>'

// 计算字符串尾部最长多少字符是 tag 的真前缀（用于跨上游增量边界的不完整标签扣留，防止 "<rec" 被误发正文）
function partialTagLen(s: string, tag: string): number {
  const max = Math.min(s.length, tag.length - 1)
  for (let len = max; len > 0; len--) {
    if (s.endsWith(tag.slice(0, len))) return len
  }
  return 0
}

// 结构化标签流式状态机（text | recipe | menu）：
// - text 态：增量即刻外发，但尾部可能是不完整 "<recipe>"/"<menu>" 字面量的部分先扣留，等下个增量拼装后再判断
// - recipe/menu 态：标签内内容全部缓冲不外发（同样扣留不完整 "</recipe>"/"</menu>" 尾部），闭合回调一次性上交缓冲
// - 首个任一类标签闭合后 structSeen=true：此后所有上游正文（含后续标签）一律丢弃，协议只发首个结构化输出
//   （<recipe> → onRecipeComplete；<menu> → onMenuComplete，分别由调用方走各自解析/事件路径）
class RecipeStreamSplitter {
  private inTag: 'recipe' | 'menu' | null = null
  private structSeen = false
  private buf = ''
  private tagBuf = ''
  // 流在标签态中途结束时（flush 时）的残留缓冲快照，供 lastUnclosedRecipe 查询
  private unclosed: string | null = null

  constructor(
    private readonly onRecipeComplete: (content: string) => void,
    private readonly onMenuComplete: (content: string) => void,
  ) {}

  // 喂入一个上游增量；onText 在 text 态被逐段回调（仅结构化标签出现前的正文）
  feed(delta: string, onText: (chunk: string) => void): void {
    this.buf += delta
    while (true) {
      if (this.inTag === null) {
        if (this.structSeen) {
          // 首个结构化输出已闭合：标签后的多余正文不再有意义，全部丢弃
          this.buf = ''
          break
        }
        // 在两种开标签中取最先出现者（可能出现位置决定进入哪个标签态）
        const ir = this.buf.indexOf(OPEN_RECIPE)
        const im = this.buf.indexOf(OPEN_MENU)
        const iOpen = ir === -1 ? im : im === -1 ? ir : Math.min(ir, im)
        if (iOpen === -1) {
          // 无完整开标签：扣留尾部最长半截标签字面量（两种开标签都可能构成），其余外发
          const keep = Math.max(partialTagLen(this.buf, OPEN_RECIPE), partialTagLen(this.buf, OPEN_MENU))
          const out = this.buf.slice(0, this.buf.length - keep)
          if (out) onText(out)
          this.buf = this.buf.slice(this.buf.length - keep)
          break
        }
        if (iOpen > 0) onText(this.buf.slice(0, iOpen))
        this.inTag = this.buf.startsWith(OPEN_RECIPE, iOpen) ? 'recipe' : 'menu'
        this.buf = this.buf.slice(iOpen + (this.inTag === 'recipe' ? OPEN_RECIPE.length : OPEN_MENU.length))
      } else {
        const closeTag = this.inTag === 'recipe' ? CLOSE_RECIPE : CLOSE_MENU
        const i = this.buf.indexOf(closeTag)
        if (i === -1) {
          // 无完整闭标签：内容入缓冲，尾部半截闭标签扣留待下个增量
          const keep = partialTagLen(this.buf, closeTag)
          this.tagBuf += this.buf.slice(0, this.buf.length - keep)
          this.buf = this.buf.slice(this.buf.length - keep)
          break
        }
        // 闭合：缓冲整体上交（由调用方决定解析与事件），回到 text 态并标记已见结构化输出
        this.tagBuf += this.buf.slice(0, i)
        this.buf = this.buf.slice(i + closeTag.length)
        this.inTag = null
        this.structSeen = true
        if (closeTag === CLOSE_RECIPE) this.onRecipeComplete(this.tagBuf)
        else this.onMenuComplete(this.tagBuf)
        this.tagBuf = ''
      }
    }
  }

  // flush 后查询：流在标签态中途结束时是否有未闭合缓冲（需走提取路径）；正常闭合流返回 null。
  // 附带闭合的标签类型，调用方据此选解析函数（<recipe> 未闭合走菜谱提取；<menu> 未闭合走清单提取）
  lastUnclosedTag(): { kind: 'recipe' | 'menu'; content: string } | null {
    if (this.unclosed === null) return null
    return { kind: this.unclosedKind, content: this.unclosed }
  }

  // 上游结束时调用：冲刷扣留的半截标签文本（此时不可能再拼成完整标签）；
  // 若流在标签态中途结束（模型漏写闭合标签或上游截断），把残留缓冲当作闭合内容返回快照，
  // 交由调用方走同一条「提取 → 重试 → 事件」路径（裸 JSON 平衡扫描可解出未闭合但完整的 JSON）
  flush(onText: (chunk: string) => void): { kind: 'recipe' | 'menu'; content: string } | null {
    let unclosed: { kind: 'recipe' | 'menu'; content: string } | null = null
    if (this.inTag !== null) {
      this.tagBuf += this.buf
      if (this.tagBuf !== '') {
        this.unclosed = this.tagBuf
        this.unclosedKind = this.inTag
        unclosed = { kind: this.inTag, content: this.tagBuf }
      }
    } else if (!this.structSeen && this.buf) {
      onText(this.buf)
    }
    this.buf = ''
    this.tagBuf = ''
    return unclosed
  }

  // 未闭合缓冲的类型快照（lastUnclosedTag 用）
  private unclosedKind: 'recipe' | 'menu' = 'recipe'
}

// 硬条件（同 Task 10）：AI 可能照抄提示词示例的 id/时间戳（r-1730000000-ab12cd 能过 strict schema 校验），
// 解析成功后必须无条件覆写 id/createdAt/updatedAt + 强制 source='ai'，AI 提供的这三字段只当格式合规信号
function finalizeRecipe(recipe: Recipe): Recipe {
  recipe.id = makeRecipeId()
  const now = new Date().toISOString()
  recipe.createdAt = now
  recipe.updatedAt = now
  recipe.source = 'ai'
  return recipe
}

// 重试提示词模式同 Task 10：取发给上游的原消息数组，最后一条消息内容追加重试提示（系统消息保持一致）
function buildRetryMessages(messages: ChatMessage[]): ChatMessage[] {
  const retry = [...messages]
  const last = retry[retry.length - 1]
  retry[retry.length - 1] = { ...last, content: `${last.content}${RETRY_HINT}` }
  return retry
}

// 上游 OpenAI SSE 帧解析：逐行取 "data: " 行，JSON.parse 后拼接 choices[0].delta.content；
// data: [DONE] 为上游结束标记（done 事件由收尾逻辑统一发）；单帧坏 JSON 容错跳过不炸整条流
function processUpstreamChunk(
  value: Uint8Array,
  dec: TextDecoder,
  lineBuf: { s: string },
  sm: RecipeStreamSplitter,
  emit: (frame: string) => void,
): void {
  lineBuf.s += dec.decode(value, { stream: true })
  const lines = lineBuf.s.split('\n')
  lineBuf.s = lines.pop() ?? '' // 半行留待下个 chunk 拼装
  for (const raw of lines) {
    const line = raw.trimEnd() // 兼容 CRLF 上游
    if (line === '' || !line.startsWith('data:')) continue
    const payload = line.slice(5).trim()
    if (payload === '[DONE]') continue
    let json: unknown
    try {
      json = JSON.parse(payload)
    } catch {
      continue
    }
    const delta = (json as { choices?: Array<{ delta?: { content?: string } }> })
      .choices?.[0]?.delta?.content
    if (typeof delta === 'string' && delta.length > 0) {
      sm.feed(delta, chunk => emit(sseEvent('message', { t: chunk })))
    }
  }
}

// POST handler：参数校验 → 400；AI 配置 → 503；上游请求失败 → 502；正常 → SSE 流
export async function POST(req: Request): Promise<Response> {
  const denied = requireAuth(req)
  if (denied) return denied
  const ip = clientIpOf(req)
  const messages = await parseInput(req)
  if (!messages) {
    await appendAccessLog({ ip, method: 'POST', path: '/api/ai/chat', status: 400 })
    return Response.json({ error: '参数缺失或非法：messages 须为非空的消息数组' }, { status: 400 })
  }

  // AI 未配置：loadAiConfig throw 中文错误 → 503（env 真实路径，测试只 mock aiChatStream/aiComplete）
  let cfg
  try {
    cfg = loadAiConfig()
  } catch (e) {
    await appendAccessLog({ ip, method: 'POST', path: '/api/ai/chat', status: 503 })
    return Response.json({ error: e instanceof Error ? e.message : 'AI 配置缺失' }, { status: 503 })
  }

  // 系统消息 = 人设 + 库摘要 + 输出规则（<recipe> 菜谱格式 + <menu> 食材推荐清单格式，两态并存）；
  // 其后原样转发客户端 messages
  const { recipes } = await listRecipes()
  const sent: ChatMessage[] = [
    {
      role: 'system',
      content: [systemPromptWithLibrary(recipes), RECIPE_FORMAT_RULE, CHAT_MENU_FORMAT_RULE].join('\n'),
    },
    ...messages,
  ]

  let upstream: Response
  try {
    upstream = await aiChatStream(cfg, sent)
  } catch (e) {
    // 上游非 2xx（aiChatStream throw）：此时尚未发出任何 SSE 字节，可直接回 JSON 错误（与 Task 10 的 502 一致）
    await appendAccessLog({ ip, method: 'POST', path: '/api/ai/chat', status: 502 })
    return Response.json(
      { error: e instanceof Error ? e.message : 'AI 上游请求失败' },
      { status: 502 },
    )
  }
  if (!upstream.body) {
    await appendAccessLog({ ip, method: 'POST', path: '/api/ai/chat', status: 502 })
    return Response.json({ error: 'AI 上游请求失败：响应无内容' }, { status: 502 })
  }

  // 手动泵上游 → 下游 SSE；任一端断开都取消上游 reader，不留悬挂连接
  const reader = upstream.body.getReader()
  let clientGone = false
  const handleAbort = () => {
    clientGone = true
    void reader.cancel().catch(() => {})
  }
  if (req.signal.aborted) handleAbort()
  else req.signal.addEventListener('abort', handleAbort)

  // 首个结构化标签闭合时捕获的内容与类型（recipe=完整菜谱 JSON / menu=推荐清单 JSON）
  let closedContent: string | null = null
  let closedKind: 'recipe' | 'menu' = 'recipe'
  const sm = new RecipeStreamSplitter(
    content => {
      if (closedContent === null) {
        closedContent = content
        closedKind = 'recipe'
      }
    },
    content => {
      if (closedContent === null) {
        closedContent = content
        closedKind = 'menu'
      }
    },
  )

  const out = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enc = new TextEncoder()
      const dec = new TextDecoder()
      const lineBuf = { s: '' }
      // 安全外发：客户端断开后不再 enqueue（对已取消流 enqueue 会抛错）
      const emit = (frame: string) => {
        if (clientGone) return
        try {
          controller.enqueue(enc.encode(frame))
        } catch {
          clientGone = true
        }
      }
      try {
        while (!clientGone) {
          const { done, value } = await reader.read()
          if (done) break
          if (value) processUpstreamChunk(value, dec, lineBuf, sm, emit)
        }
        if (!clientGone) {
          // 上游结束：冲刷正文残余（半截标签字面量）；流中途断在标签态时拿回未闭合缓冲与类型，走同一条提取路径
          const flushUnclosed = sm.flush(chunk => emit(sseEvent('message', { t: chunk })))
          const pending = closedContent
            ? { kind: closedKind, content: closedContent }
            : flushUnclosed
          if (pending !== null) {
            // 标签闭合（或流截断残留）后按类型提取；失败按公共模式重试一次，仍失败发 error（随后照常 done，不中断流）
            if (pending.kind === 'menu') {
              // <menu>：食材推荐清单（新协议）——解析失败重试一次（重试消息与首轮一致）
              let menu = extractChatMenuJson(pending.content)
              if (!menu) {
                try {
                  menu = extractChatMenuJson(await aiComplete(cfg, buildRetryMessages(sent)))
                } catch {
                  menu = null
                }
              }
              if (menu) {
                emit(sseEvent('menu', menu))
              } else {
                emit(sseEvent('error', { error: 'AI 输出两次均无法解析为合法推荐清单' }))
              }
              // 访问日志（方案 A）：清单生成 200 / 解析失败 502
              await appendAccessLog({ ip, method: 'POST', path: '/api/ai/chat', status: menu ? 200 : 502 })
            } else {
              // <recipe>：完整菜谱（原有路径）
              let recipe = extractRecipeJson(pending.content)
              if (!recipe) {
                try {
                  recipe = extractRecipeJson(await aiComplete(cfg, buildRetryMessages(sent)))
                } catch {
                  recipe = null
                }
              }
              if (recipe) {
                emit(sseEvent('recipe', finalizeRecipe(recipe)))
              } else {
                emit(sseEvent('error', { error: 'AI 输出两次均无法解析为合法菜谱' }))
              }
              // 访问日志：菜谱生成 200 / 解析失败 502
              await appendAccessLog({ ip, method: 'POST', path: '/api/ai/chat', status: recipe ? 200 : 502 })
            }
          } else {
            // 纯对话（无结构化输出）：正常回答完成
            await appendAccessLog({ ip, method: 'POST', path: '/api/ai/chat', status: 200 })
          }
          emit(sseEvent('done', {}))
        }
        controller.close()
      } catch (e) {
        // 上游中途读失败：流已开始无法改状态码，补 error + done 保证前端总能收到终止帧
        if (!clientGone) {
          emit(
            sseEvent('error', {
              error: `AI 上游连接中断：${e instanceof Error ? e.message : String(e)}`,
            }),
          )
          emit(sseEvent('done', {}))
        }
        try {
          controller.close()
        } catch {
          // 已关闭/已取消则忽略
        }
      }
    },
    cancel() {
      // 客户端主动断开响应流：取消上游 reader
      clientGone = true
      void reader.cancel().catch(() => {})
    },
  })

  return new Response(out, { headers: sseHeaders() })
}
