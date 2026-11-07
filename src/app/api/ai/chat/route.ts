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
import { systemPromptWithLibrary, RECIPE_FORMAT_RULE, extractRecipeJson } from '@/lib/ai-prompts'
import { listRecipes } from '@/lib/recipe-store'
import { makeRecipeId, type Recipe } from '@/lib/recipe-types'
import { sseEvent, sseHeaders } from '@/lib/sse'
import { requireAuth } from '@/lib/auth'

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

// 计算字符串尾部最长多少字符是 tag 的真前缀（用于跨上游增量边界的不完整标签扣留，防止 "<rec" 被误发正文）
function partialTagLen(s: string, tag: string): number {
  const max = Math.min(s.length, tag.length - 1)
  for (let len = max; len > 0; len--) {
    if (s.endsWith(tag.slice(0, len))) return len
  }
  return 0
}

// <recipe> 标签两态状态机（text | recipe）：
// - text 态：增量即刻外发，但尾部可能是不完整 "<recipe>" 字面量的部分先扣留，等下个增量拼装后再判断
// - recipe 态：标签内内容全部缓冲不外发（同样扣留不完整 "</recipe>" 尾部），闭合回调一次性上交缓冲
// - 首个闭合后 recipeSeen=true：此后所有上游正文（含后续标签）一律丢弃，协议只发首个菜谱
class RecipeStreamSplitter {
  private inRecipe = false
  private recipeSeen = false
  private buf = ''
  private recipeBuf = ''
  // 流在 recipe 态中途结束时（flush 时）的残留缓冲快照，供 lastUnclosedRecipe 查询
  private unclosed: string | null = null

  constructor(private readonly onRecipeComplete: (content: string) => void) {}

  // 喂入一个上游增量；onText 在 text 态被逐段回调（仅 <recipe> 出现前的正文）
  feed(delta: string, onText: (chunk: string) => void): void {
    this.buf += delta
    while (true) {
      if (!this.inRecipe) {
        if (this.recipeSeen) {
          // 首个菜谱已闭合：标签后的多余正文不再有意义，全部丢弃
          this.buf = ''
          break
        }
        const i = this.buf.indexOf(OPEN_TAG)
        if (i === -1) {
          // 无完整开标签：扣留尾部半截标签字面量，其余外发
          const keep = partialTagLen(this.buf, OPEN_TAG)
          const out = this.buf.slice(0, this.buf.length - keep)
          if (out) onText(out)
          this.buf = this.buf.slice(this.buf.length - keep)
          break
        }
        if (i > 0) onText(this.buf.slice(0, i))
        this.buf = this.buf.slice(i + OPEN_TAG.length)
        this.inRecipe = true
      } else {
        const i = this.buf.indexOf(CLOSE_TAG)
        if (i === -1) {
          // 无完整闭标签：内容入缓冲，尾部半截闭标签扣留待下个增量
          const keep = partialTagLen(this.buf, CLOSE_TAG)
          this.recipeBuf += this.buf.slice(0, this.buf.length - keep)
          this.buf = this.buf.slice(this.buf.length - keep)
          break
        }
        // 闭合：缓冲整体上交（由调用方 extractRecipeJson 决定发 recipe 还是 error），回到 text 态
        this.recipeBuf += this.buf.slice(0, i)
        this.buf = this.buf.slice(i + CLOSE_TAG.length)
        this.inRecipe = false
        this.recipeSeen = true
        this.onRecipeComplete(this.recipeBuf)
        this.recipeBuf = ''
      }
    }
  }

  // flush 后查询：流在 recipe 态中途结束时是否有未闭合缓冲（需走提取路径）；正常闭合流返回 null
  lastUnclosedRecipe(): string | null {
    return this.unclosed
  }

  // 上游结束时调用：冲刷扣留的半截标签文本（此时不可能再拼成完整标签）；
  // 若流在 recipe 态中途结束（模型漏写 </recipe> 或上游截断），把残留缓冲当作闭合内容返回，
  // 交由调用方走同一条 extractRecipeJson → 重试 → recipe/error 路径（裸 JSON 平衡扫描可解出未闭合但完整的 JSON）
  flush(onText: (chunk: string) => void): string | null {
    let unclosed: string | null = null
    if (this.inRecipe) {
      this.recipeBuf += this.buf
      if (this.recipeBuf !== '') {
        unclosed = this.recipeBuf
        this.unclosed = this.recipeBuf
      }
    } else if (!this.recipeSeen && this.buf) {
      onText(this.buf)
    }
    this.buf = ''
    this.recipeBuf = ''
    return unclosed
  }
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
  const messages = await parseInput(req)
  if (!messages) {
    return Response.json({ error: '参数缺失或非法：messages 须为非空的消息数组' }, { status: 400 })
  }

  // AI 未配置：loadAiConfig throw 中文错误 → 503（env 真实路径，测试只 mock aiChatStream/aiComplete）
  let cfg
  try {
    cfg = loadAiConfig()
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : 'AI 配置缺失' }, { status: 503 })
  }

  // 系统消息 = 人设 + 库摘要 + <recipe> 格式规则（让模型知道结构化输出协议）；其后原样转发客户端 messages
  const { recipes } = await listRecipes()
  const sent: ChatMessage[] = [
    { role: 'system', content: [systemPromptWithLibrary(recipes), RECIPE_FORMAT_RULE].join('\n') },
    ...messages,
  ]

  let upstream: Response
  try {
    upstream = await aiChatStream(cfg, sent)
  } catch (e) {
    // 上游非 2xx（aiChatStream throw）：此时尚未发出任何 SSE 字节，可直接回 JSON 错误（与 Task 10 的 502 一致）
    return Response.json(
      { error: e instanceof Error ? e.message : 'AI 上游请求失败' },
      { status: 502 },
    )
  }
  if (!upstream.body) {
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

  let recipeContent: string | null = null // 首个 </recipe> 闭合时捕获的标签内内容
  const sm = new RecipeStreamSplitter(content => {
    if (recipeContent === null) recipeContent = content
  })

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
          // 上游结束：冲刷正文残余（半截标签字面量）；流中途断在 recipe 态时拿回未闭合缓冲，走同一条提取路径
          sm.flush(chunk => emit(sseEvent('message', { t: chunk })))
          const pending = recipeContent ?? sm.lastUnclosedRecipe()
          if (pending !== null) {
            // 标签闭合（或流截断残留）后提取菜谱；失败按 Task 10 模式重试一次，仍失败发 error（随后照常 done，不中断流）
            let recipe = extractRecipeJson(pending)
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
