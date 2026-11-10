'use client'

// ChatView：AI 聊天界面（Task 12，设计 5.2）
// 数据流：发送 → apiFetch POST /api/ai/chat（body { messages: 完整对话历史 }）→ readSse 流式消费
// SSE 协议（Task 11）：message 增量拼当前 assistant 气泡 | recipe 挂卡片 | error 红字 | done 解锁
// 入库：POST /api/recipes，body 为 recipe 剥离 id/createdAt/updatedAt（服务端校验 DraftRecipe
// schema 且 .strict()，多一个字段即 400）；source 保留 'ai'；成功 201 置 saved（按钮禁用即防抖）
// 聊天记录不持久化：仅存内存 state，刷新即丢（规格 5.2 已确认）；不写 localStorage
import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { apiFetch } from '@/lib/api-fetch'
import { dishKey } from '@/lib/dish-key'
import { DishAborts } from '@/lib/dishes-regen'
import { readSse } from '@/lib/sse-client'
import { buildHistory } from '@/lib/chat-history'
import RecipeCard from '@/components/RecipeCard'
import type { ChatMenu } from '@/lib/ai-prompts'
import type { Recipe } from '@/lib/recipe-types'

// 消息条目：文本气泡；recipe 对象不进 history（历史只含 user/assistant 文本）
interface ChatItem {
  role: 'user' | 'assistant'
  text: string
  recipe?: Recipe // assistant 消息可附挂一张菜谱卡片（气泡+卡片一体渲染）
  menu?: ChatMenu // assistant 消息可附挂食材推荐清单（用户确认后逐菜生成完整菜谱）
  error?: string // 生成失败时 assistant 气泡内的红字提示
}

// 推荐清单中某道菜的逐菜状态：无记录=未生成；generating=生成中；ready=已生成（挂卡片）；
// 失败/异常后回 idle（携带 error 红字），按钮恢复可点允许重试（审计修复 #3）
interface MenuDishState {
  phase: 'idle' | 'generating' | 'ready'
  recipe?: Recipe
  error?: string
}

// 入库请求体：DraftRecipe 形状（无 id/时间戳），destructure 剥离三字段，source 原样保留
function toDraft(recipe: Recipe) {
  const { name, category, servings, difficulty, totalTimeMin, tags, ingredients, steps, nutrition, source } =
    recipe
  const draft: {
    name: string
    category?: Recipe['category']
    servings: number
    difficulty: string
    totalTimeMin: number
    tags: string[]
    ingredients: Recipe['ingredients']
    steps: string[]
    nutrition?: Recipe['nutrition']
    source: Recipe['source']
  } = {
    name,
    servings,
    difficulty,
    totalTimeMin,
    tags,
    ingredients,
    steps,
    source, // 保留 'ai'
  }
  if (category !== undefined) draft.category = category
  if (nutrition !== undefined) draft.nutrition = nutrition
  return draft
}

// SSE 空闲超时：连续这么久收不到任何字节就中止。
// 依据：服务端 `/api/ai/chat` 每 10 秒发一帧 `: ping` 心跳（src/lib/sse-heartbeat.ts），
// 覆盖「首 token 等待（上游 120s）」与「解析失败后非流式重试（再 120s）」两段零帧窗口。
// 因此 60 秒阈值远大于心跳间隔、又远小于最坏等待，既能及时发现真断网，也不会误杀合法重试。
const SSE_IDLE_TIMEOUT_MS = 60_000

// 整请求硬超时：兜住「连响应头都拿不到」的情况——此时 readSse 还没被调用，
// 上面的空闲超时管不到（fetch 一直 pending → pending 永不复位）。
// 取 300 秒 = 流式首轮最多 120s + 解析失败重试最多 120s（最坏 240s）+ 余量。
// 用户随时可点「停止」立即中断，这里只是「人走开了」时的最后一道保险。
const CHAT_HARD_TIMEOUT_MS = 300_000

export default function ChatView() {
  // 完整聊天记录（内存态，不持久化）
  const [items, setItems] = useState<ChatItem[]>([])
  // 输入框内容与生成中标志：生成中禁输入框与发送按钮
  const [input, setInput] = useState('')
  const [pending, setPending] = useState(false)
  // 每条 assistant 消息的入库状态：以 recipe.id 记录，saved 后按钮禁用防重复点击
  const [savedIds, setSavedIds] = useState<Record<string, boolean>>({})
  // 入库请求进行中的 id 集合：请求往返期间与 saved 一样禁用按钮（201 响应前双击不再二次发请求）
  const [savingIds, setSavingIds] = useState<Record<string, boolean>>({})
  // 推荐清单逐菜状态：以「消息下标:菜名」为键（跨清单同名菜互不干扰），确认后逐菜生成完整菜谱
  const [dishStates, setDishStates] = useState<Record<string, MenuDishState>>({})
  // 自动滚底：气泡区 ref，增量/卡片/错误到达时滚动到底
  const scrollRef = useRef<HTMLDivElement>(null)
  // 请求取消：拆成两个槽——原先单槽 abortRef 会被后发起的请求覆盖，
  // 导致「流式生成中点生成菜谱 → 槽位被换掉 → 切页只 abort 了后者」，
  // SSE 那条继续跑完（继续烧 token）且卸载后 patch() 仍 setState（点菜页已有同款修复）。
  // - chatAbortRef：流式聊天（同一时刻最多一条）
  // - dishAbortsRef：逐菜生成（按 dishKey 登记，可与聊天并行、可全部取消）
  const chatAbortRef = useRef<AbortController | null>(null)
  const dishAbortsRef = useRef(new DishAborts())
  useEffect(() => {
    const dishAborts = dishAbortsRef.current
    return () => {
      chatAbortRef.current?.abort()
      dishAborts.abortAll()
    }
  }, [])

  // 自动滚底：items 变化（含流式增量）后滚到最底，解决软键盘遮挡下最新内容可见性
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [items])

  // 入库：POST /api/recipes（契约 Task 4：201 裸 Recipe | 400 { error: 中文 }）
  async function saveRecipe(recipe: Recipe) {
    // 防抖兜底：已入库或请求进行中直接返回（按钮禁用为主，此判断防极端连点）
    if (savedIds[recipe.id] || savingIds[recipe.id]) return
    setSavingIds((prev) => ({ ...prev, [recipe.id]: true }))
    try {
      const res = await apiFetch('/api/recipes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(toDraft(recipe)),
      })
      if (res.status === 201) {
        setSavedIds((prev) => ({ ...prev, [recipe.id]: true }))
        return
      }
      // 失败：优先透出服务端中文 error
      let msg = '存入菜谱库失败，请稍后重试'
      try {
        const data = (await res.json()) as { error?: string }
        if (typeof data?.error === 'string' && data.error !== '') msg = data.error
      } catch {
        // 保留默认文案
      }
      alert(msg)
    } catch {
      alert('存入菜谱库失败，网络异常，请稍后重试')
    } finally {
      // 请求结束（无论成败）必移出 in-flight 集合；成功后由 savedIds 接管禁用
      setSavingIds((prev) => {
        const next = { ...prev }
        delete next[recipe.id]
        return next
      })
    }
  }

  // 推荐清单逐菜生成：确认某道菜后调 /api/ai/recipes 生成完整菜谱（per-dish 独立状态互不阻塞）
  async function generateDish(msgIdx: number, dishName: string) {
    const key = dishKey(msgIdx, dishName)
    const st = dishStates[key]
    // 守卫只拦「生成中」与「已就绪有菜谱」（防重复触发）；idle 或 ready-but-error（失败态）允许再次点击重试
    if (st && (st.phase === 'generating' || (st.phase === 'ready' && st.recipe))) return
    setDishStates((prev) => ({ ...prev, [key]: { phase: 'generating' } }))
    // 控制器建在 try 外：catch 需要读 signal 区分「主动中止」与「网络异常」
    const controller = new AbortController()
    // 按 dishKey 登记：可与流式聊天并行、可被卸载统一取消（不再和聊天抢同一个槽）
    dishAbortsRef.current.set(key, controller)
    try {
      const res = await apiFetch('/api/ai/recipes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dish: dishName }),
        signal: controller.signal,
      })
      // 主动中止（卸载/停止）：结果作废，不再 setState
      if (controller.signal.aborted) return
      if (res.ok) {
        // /api/ai/recipes 200 为 { recipe } 包裹形状（与 /api/recipes 入库接口的裸 Recipe 不同）
        const data = (await res.json()) as { recipe: Recipe }
        setDishStates((prev) => ({ ...prev, [key]: { phase: 'ready', recipe: data.recipe } }))
        return
      }
      let msg = `生成失败（HTTP ${res.status}）`
      try {
        const data = (await res.json()) as { error?: string }
        if (typeof data?.error === 'string' && data.error !== '') msg = data.error
      } catch {
        // 保留默认文案
      }
      // 失败回 idle（而非停在 generating）：按钮恢复可点，允许用户直接重试
      setDishStates((prev) => ({ ...prev, [key]: { phase: 'idle', error: msg } }))
    } catch {
      // 网络异常同样回 idle 允许重试；卸载触发的 abort 不再 setState
      if (controller.signal.aborted) return
      setDishStates((prev) => ({ ...prev, [key]: { phase: 'idle', error: '网络异常，请稍后重试' } }))
    } finally {
      // 结束（含中止）必注销登记，避免注册表无限增长；带实例校验防误删同名新请求
      dishAbortsRef.current.delete(key, controller)
    }
  }

  // 发送：把完整对话历史（user/assistant 文本，不含 recipe 对象）作为 messages 交给后端
  async function handleSend() {
    const text = input.trim()
    if (text === '' || pending) return
    setInput('')
    setPending(true)
    // 追加用户消息 + 空 assistant 占位（流式增量拼进它）
    // 历史里带上每轮的菜名摘要（menu 清单 / 单菜谱），让模型在「继续」时知道自己推荐过什么
    const history = buildHistory(
      items.map((it) => ({
        role: it.role,
        text: it.text,
        menuDishNames: it.menu?.dishes.map((d) => d.name),
        recipeName: it.recipe?.name,
      })),
      text,
    )
    setItems((prev) => [...prev, { role: 'user', text }, { role: 'assistant', text: '' }])
    // 当前 assistant 占位在数组中的下标（闭包内恒定，直接用索引更新）
    const idx = items.length + 1

    const patch = (fn: (it: ChatItem) => ChatItem) =>
      setItems((prev) => prev.map((it, i) => (i === idx ? fn(it) : it)))

    // 控制器建在 try 外：catch 需要读 signal 判断是「用户停止/卸载」还是真网络异常
    const controller = new AbortController()
    chatAbortRef.current = controller
    // 硬超时：到点主动 abort，并用 timedOut 标记与「用户点停止」区分（后者应静默）
    let timedOut = false
    const hardTimer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, CHAT_HARD_TIMEOUT_MS)
    try {
      // 推荐风格由服务端全局设置决定（设置页可改），前端不传参
      const res = await apiFetch('/api/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: history }),
        signal: controller.signal,
      })
      if (!res.ok) {
        // 非 SSE 错误形态（400/502/503 等 { error: 中文 }）：直接读 JSON 显示在气泡内
        let msg = `请求失败（HTTP ${res.status}）`
        try {
          const data = (await res.json()) as { error?: string }
          if (typeof data?.error === 'string' && data.error !== '') msg = data.error
        } catch {
          // 保留默认文案
        }
        patch((it) => ({ ...it, error: msg }))
        return
      }
      // 空闲超时：网络切换/上游挂起时 reader.read() 既不 resolve 也不 reject，
      // 否则 pending 永不复位、输入区永久禁用（唯一出路是刷新，聊天记录全丢）
      await readSse(res, (event, data) => {
        if (event === 'message') {
          // 增量：拼当前 assistant 气泡（data: { t: string }）
          const t = (data as { t?: unknown }).t
          if (typeof t === 'string') patch((it) => ({ ...it, text: it.text + t }))
        } else if (event === 'recipe') {
          // 完整菜谱：挂到当前 assistant 消息下方（服务端已覆写 id/时间戳/source，原样使用不改对象）
          patch((it) => ({ ...it, recipe: data as Recipe }))
        } else if (event === 'menu') {
          // 食材推荐清单：挂到当前 assistant 消息下方（用户确认后逐菜生成完整菜谱）
          patch((it) => ({ ...it, menu: data as ChatMenu }))
        } else if (event === 'error') {
          // 错误：红字显示在 assistant 气泡内（随后照常 done 收尾）
          const err = (data as { error?: unknown }).error
          if (typeof err === 'string') patch((it) => ({ ...it, error: err }))
        }
        // done：无需处理，finally 解锁输入
      }, { idleTimeoutMs: SSE_IDLE_TIMEOUT_MS })
    } catch {
      // 三种来源要区分开：
      // - 用户点「停止」/组件卸载：主动 abort 且非超时 → 静默（用户已知情）
      // - 硬超时：同样 aborted，但要让用户知道为什么停了
      // - 空闲超时（readSse 抛出）/网络断开：未 abort → 统一文案
      if (controller.signal.aborted && !timedOut) return
      patch((it) => ({ ...it, error: timedOut ? '请求超时，请重试' : '网络异常，请稍后重试' }))
    } finally {
      clearTimeout(hardTimer)
      setPending(false)
    }
  }

  // 移动端三约束：输入框 text-base（16px）+ min-h-[44px]；弹性行 min-w-0 防横滚；
  // 暗色适配：边框/文字/焦点色均带 dark: 变体，跟随系统深色模式
  const inputClass =
    'min-h-[44px] w-full min-w-0 rounded-lg border border-neutral-300 bg-transparent px-3 text-base text-neutral-900 outline-none placeholder:text-neutral-400 focus:border-neutral-900 dark:border-neutral-700 dark:text-neutral-100 dark:focus:border-neutral-100'

  return (
    <div className="flex h-[calc(100dvh-3.5rem)] flex-col">
      {/* 气泡滚动区：flex-1 + overflow-y-auto；dvh 贴合移动端软键盘弹出后的可视高度 */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4">
        {items.length === 0 ? (
          // 空态：保留「AI 菜谱助手」定位提示
          <div className="flex h-full flex-col items-center justify-center text-center">
            <h1 className="text-2xl font-bold tracking-tight text-neutral-900 dark:text-neutral-100">AI-eat</h1>
            <p className="mt-3 text-base text-neutral-600 dark:text-neutral-400">你的 AI 菜谱助手</p>
            <p className="mt-2 text-sm leading-6 text-neutral-500 dark:text-neutral-400">
              说说冰箱里有什么，AI 会按现有食材搭配出合适的菜；
              <br />
              点某道菜的「生成菜谱」得到完整做法并存入菜谱库。没有食材？去「买什么」按人数配一桌菜。
            </p>
          </div>
        ) : (
          <div className="mx-auto flex max-w-3xl flex-col gap-3">
            {items.map((it, i) => (
              <div key={i} className="flex flex-col gap-2">
                {/* 气泡：user 右侧深色，assistant 左侧浅色；min-w-0 + break-words 防长文本撑破（无横滚） */}
                <div className={`flex ${it.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div
                    className={`max-w-[85%] min-w-0 rounded-2xl px-3 py-2 text-base leading-6 ${
                      it.role === 'user'
                        ? 'bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900'
                        : 'bg-neutral-100 text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100'
                    }`}
                  >
                    <p className="whitespace-pre-wrap break-words">{it.text}</p>
                    {/* 错误红字显示在 assistant 气泡内 */}
                    {it.error && <p className="mt-1 text-sm text-red-500 dark:text-red-400">{it.error}</p>}
                  </div>
                </div>
                {/* recipe 事件：卡片挂当前 assistant 气泡下方（气泡+卡片一体渲染） */}
                {it.recipe && (
                  <RecipeCard
                    recipe={it.recipe}
                    onSave={() => void saveRecipe(it.recipe!)}
                    saved={savedIds[it.recipe.id] ?? false}
                    saving={savingIds[it.recipe.id] ?? false}
                  />
                )}
                {/* menu 事件：食材推荐清单——每菜一行（主料+理由，理由中说明用到了哪些食材），确认后逐菜生成完整菜谱 */}
                {it.menu && (
                  <section
                    aria-label="食材推荐清单"
                    className="flex flex-col gap-2 rounded-xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900"
                  >
                    <h3 className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
                      推荐清单（{it.menu.dishes.length} 道），想做哪道点「生成菜谱」
                    </h3>
                    <ul className="flex flex-col gap-3">
                      {it.menu.dishes.map((d) => {
                        const key = dishKey(i, d.name)
                        const st = dishStates[key]
                        return (
                          <li
                            key={key}
                            aria-label={`推荐菜：${d.name}`}
                            className="flex flex-col gap-2 rounded-lg border border-neutral-200 p-3 dark:border-neutral-800"
                          >
                            <div className="flex min-w-0 flex-wrap items-center gap-2">
                              <span className="min-w-0 break-words text-sm font-medium text-neutral-900 dark:text-neutral-100">
                                {d.name}
                              </span>
                              <span className="shrink-0 rounded-full bg-neutral-200 px-2 py-0.5 text-xs text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
                                主料：{d.ingredient}
                              </span>
                            </div>
                            <p className="min-w-0 break-words text-sm leading-6 text-neutral-600 dark:text-neutral-400">
                              {d.reason}
                            </p>
                            {/* 逐菜失败局部红字，不阻塞其他菜 */}
                            {st?.error && <p className="text-sm text-red-500 dark:text-red-400">{st.error}</p>}
                            {st?.phase === 'ready' && st.recipe ? (
                              <RecipeCard
                                recipe={st.recipe}
                                onSave={() => void saveRecipe(st.recipe!)}
                                saved={savedIds[st.recipe.id] ?? false}
                                saving={savingIds[st.recipe.id] ?? false}
                              />
                            ) : (
                              <button
                                type="button"
                                onClick={() => void generateDish(i, d.name)}
                                disabled={st?.phase === 'generating'}
                                aria-label={`生成菜谱：${d.name}`}
                                className="min-h-[44px] w-full rounded-lg border border-neutral-300 bg-white text-sm font-medium text-neutral-900 transition-colors active:bg-neutral-100 disabled:border-neutral-200 disabled:bg-neutral-100 disabled:text-neutral-400 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100 dark:active:bg-neutral-800 dark:disabled:border-neutral-800 dark:disabled:bg-neutral-800 dark:disabled:text-neutral-500"
                              >
                                {st?.phase === 'generating' ? '生成中…' : '生成菜谱'}
                              </button>
                            )}
                          </li>
                        )
                      })}
                    </ul>
                  </section>
                )}
              </div>
            ))}
            {/* 生成中：占位指示，增强流式等待体验 */}
            {pending && (
              <div className="text-sm text-neutral-400 dark:text-neutral-500" aria-live="polite">
                AI 正在思考…
              </div>
            )}
          </div>
        )}
      </div>

      {/* 底部输入区：贴底固定在滚动区下方；软键盘弹出时 dvh 容器压缩、气泡区滚动、输入框保持可见 */}
      <div className="border-t border-neutral-200 bg-white px-3 py-2 dark:border-neutral-800 dark:bg-neutral-900">
        <div className="mx-auto flex max-w-3xl items-end gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e: KeyboardEvent<HTMLTextAreaElement>) => {
              // Enter 发送（IME 组合中不触发），Shift+Enter 换行
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                void handleSend()
              }
            }}
            rows={1}
            placeholder={pending ? 'AI 回复中…' : '例如：冰箱有番茄和鸡蛋，做个菜'}
            aria-label="聊天输入框"
            disabled={pending}
            className={`${inputClass} max-h-40 resize-none py-2`}
          />
          {/* 回复中把「发送」换成「停止」：此前只能等（空闲超时前无出路），
              现在可主动中断——点停止即 abort 当前 SSE，finally 复位输入区，已收到的内容保留 */}
          {pending ? (
            <button
              type="button"
              onClick={() => chatAbortRef.current?.abort()}
              aria-label="停止生成"
              className="min-h-[44px] shrink-0 rounded-lg border border-neutral-300 px-4 text-base font-medium text-neutral-900 transition-colors active:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-100 dark:active:bg-neutral-800"
            >
              停止
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void handleSend()}
              disabled={input.trim() === ''}
              aria-label="发送"
              className="min-h-[44px] shrink-0 rounded-lg bg-neutral-900 px-4 text-base font-medium text-white transition-colors active:bg-neutral-700 disabled:bg-neutral-300 disabled:text-neutral-500 dark:bg-neutral-100 dark:text-neutral-900 dark:active:bg-neutral-300 dark:disabled:bg-neutral-700 dark:disabled:text-neutral-400"
            >
              发送
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
