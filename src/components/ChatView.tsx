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
import { readSse } from '@/lib/sse-client'
import { buildHistory } from '@/lib/chat-history'
import RecipeCard from '@/components/RecipeCard'
import type { Recipe } from '@/lib/recipe-types'

// 消息条目：文本气泡；recipe 对象不进 history（历史只含 user/assistant 文本）
interface ChatItem {
  role: 'user' | 'assistant'
  text: string
  recipe?: Recipe // assistant 消息可附挂一张菜谱卡片（气泡+卡片一体渲染）
  error?: string // 生成失败时 assistant 气泡内的红字提示
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
  // 自动滚底：气泡区 ref，增量/卡片/错误到达时滚动到底
  const scrollRef = useRef<HTMLDivElement>(null)

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

  // 发送：把完整对话历史（user/assistant 文本，不含 recipe 对象）作为 messages 交给后端
  async function handleSend() {
    const text = input.trim()
    if (text === '' || pending) return
    setInput('')
    setPending(true)
    // 追加用户消息 + 空 assistant 占位（流式增量拼进它）
    const history = buildHistory(items, text)
    setItems((prev) => [...prev, { role: 'user', text }, { role: 'assistant', text: '' }])
    // 当前 assistant 占位在数组中的下标（闭包内恒定，直接用索引更新）
    const idx = items.length + 1

    const patch = (fn: (it: ChatItem) => ChatItem) =>
      setItems((prev) => prev.map((it, i) => (i === idx ? fn(it) : it)))

    try {
      const res = await apiFetch('/api/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: history }),
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
      await readSse(res, (event, data) => {
        if (event === 'message') {
          // 增量：拼当前 assistant 气泡（data: { t: string }）
          const t = (data as { t?: unknown }).t
          if (typeof t === 'string') patch((it) => ({ ...it, text: it.text + t }))
        } else if (event === 'recipe') {
          // 完整菜谱：挂到当前 assistant 消息下方（服务端已覆写 id/时间戳/source，原样使用不改对象）
          patch((it) => ({ ...it, recipe: data as Recipe }))
        } else if (event === 'error') {
          // 错误：红字显示在 assistant 气泡内（随后照常 done 收尾）
          const err = (data as { error?: unknown }).error
          if (typeof err === 'string') patch((it) => ({ ...it, error: err }))
        }
        // done：无需处理，finally 解锁输入
      })
    } catch {
      // fetch 本身抛错（网络断开等）
      patch((it) => ({ ...it, error: '网络异常，请稍后重试' }))
    } finally {
      setPending(false)
    }
  }

  // 移动端三约束：输入框 text-base（16px）+ min-h-[44px]；弹性行 min-w-0 防横滚
  const inputClass =
    'min-h-[44px] w-full min-w-0 rounded-lg border border-neutral-300 px-3 text-base outline-none focus:border-neutral-900'

  return (
    <div className="flex h-[calc(100dvh-3.5rem)] flex-col">
      {/* 气泡滚动区：flex-1 + overflow-y-auto；dvh 贴合移动端软键盘弹出后的可视高度 */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4">
        {items.length === 0 ? (
          // 空态：保留「AI 菜谱助手」定位提示
          <div className="flex h-full flex-col items-center justify-center text-center">
            <h1 className="text-2xl font-bold tracking-tight text-neutral-900">AI-eat</h1>
            <p className="mt-3 text-base text-neutral-600">你的 AI 菜谱助手</p>
            <p className="mt-2 text-sm leading-6 text-neutral-500">
              说说冰箱里有什么，让 AI 推荐今天吃什么；
              <br />
              生成的菜谱可一键存入菜谱库。
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
                        ? 'bg-neutral-900 text-white'
                        : 'bg-neutral-100 text-neutral-900'
                    }`}
                  >
                    <p className="whitespace-pre-wrap break-words">{it.text}</p>
                    {/* 错误红字显示在 assistant 气泡内 */}
                    {it.error && <p className="mt-1 text-sm text-red-500">{it.error}</p>}
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
              </div>
            ))}
            {/* 生成中：占位指示，增强流式等待体验 */}
            {pending && (
              <div className="text-sm text-neutral-400" aria-live="polite">
                AI 正在思考…
              </div>
            )}
          </div>
        )}
      </div>

      {/* 底部输入区：贴底固定在滚动区下方；软键盘弹出时 dvh 容器压缩、气泡区滚动、输入框保持可见 */}
      <div className="border-t border-neutral-200 bg-white px-3 py-2">
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
          <button
            type="button"
            onClick={() => void handleSend()}
            disabled={pending || input.trim() === ''}
            aria-label="发送"
            className="min-h-[44px] shrink-0 rounded-lg bg-neutral-900 px-4 text-base font-medium text-white transition-colors active:bg-neutral-700 disabled:bg-neutral-300 disabled:text-neutral-500"
          >
            发送
          </button>
        </div>
      </div>
    </div>
  )
}
