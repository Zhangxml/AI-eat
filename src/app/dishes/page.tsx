'use client'

// 点菜页（Task 14，设计 5.4.1 两段式）
// 第一段：人数（≥1 整数）+ 口味偏好（选填）→ POST /api/ai/menu → 菜卡列表（菜名/分类徽标/推荐理由）+ 采购建议区块
// 第二段：每张菜卡独立「生成菜谱」→ POST /api/ai/recipes { dish: 菜名, servings: people }
//         注意：该接口 200 为 { recipe } 包裹形状，与 /api/recipes 入库接口返回的裸 Recipe 不同，须取 data.recipe
//         → 200 后该菜卡下方展开 RecipeCard（含入库按钮）
// 各按钮加载态互不阻塞：per-dish 状态 Record<dishName, DishState>，一道菜生成中不影响其他菜
// 入库照搬 ChatView 模式：toDraft 剥离 id/createdAt/updatedAt、保 source='ai'，POST /api/recipes；
// savedNames+savingNames 以 dishName 为键防抖（同名菜共用一份状态 → 天然满足同名菜防重复生成/防重复入库）
// 错误处理：menu 失败 → 页面顶部错误条中文展示（502 文案自带服务端解析详情）；
//           单菜生成失败 → 该菜卡内局部红字并回退 idle 允许重试，不阻塞其他菜
import { useState } from 'react'
import { apiFetch } from '@/lib/api-fetch'
import RecipeCard from '@/components/RecipeCard'
import type { Recipe } from '@/lib/recipe-types'

// Task 13 契约：POST /api/ai/menu → 200 { dishes, shopping }（category 限五枚举，name/reason 必填）
interface MenuDish {
  name: string
  category: '荤菜' | '素菜' | '汤' | '主食' | '其他'
  reason: string
}

// 菜单整体：附带生成菜单时使用的人数，第二段 servings 取它（避免用户事后改输入框导致份数错位）
interface MenuData {
  people: number
  dishes: MenuDish[]
  shopping: string[]
}

// 单菜两段式状态机：idle 未生成 / generating 生成中 / ready 已生成（recipe 就绪）；error 为该卡局部错误
interface DishState {
  phase: 'idle' | 'generating' | 'ready'
  recipe?: Recipe
  error?: string
}

// 入库请求体：DraftRecipe 形状（无 id/时间戳）——与 ChatView.toDraft 完全同款：
// destructure 剥离 id/createdAt/updatedAt 三字段（服务端 DraftRecipe schema .strict()，多一个字段即 400），
// source 原样保留 'ai'；category/nutrition 可选字段仅在有值时携带
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

export default function DishesPage() {
  // 第一段表单：人数（受控字符串，提交时校验 ≥1 整数）与口味偏好（选填）
  const [peopleInput, setPeopleInput] = useState('')
  const [preference, setPreference] = useState('')
  // 人数非法时的行内提示（不发请求）
  const [formError, setFormError] = useState('')
  // 第一段加载态与页面顶部错误条文案
  const [menuLoading, setMenuLoading] = useState(false)
  const [menuError, setMenuError] = useState('')
  // 当前菜单（含生成时人数）；重新点菜整体覆盖并重置全部 per-dish 状态
  const [menu, setMenu] = useState<MenuData | null>(null)
  // per-dish 状态：以菜名为键（同名菜共用一份生成状态 → 天然防同名菜重复调用）
  const [dishStates, setDishStates] = useState<Record<string, DishState>>({})
  // 入库防抖（照搬 ChatView 的 savedIds/savingIds，键改为 dishName）：
  // savedNames 已入库（按钮变「已入库」并禁用）；savingNames 请求往返期间禁用（防 201 前双击双入库）
  const [savedNames, setSavedNames] = useState<Record<string, boolean>>({})
  const [savingNames, setSavingNames] = useState<Record<string, boolean>>({})

  // 第一段：开始点菜 → POST /api/ai/menu（契约 Task 13：200 { dishes, shopping } | 400/502/503 { error: 中文 }）
  async function handleMenu() {
    if (menuLoading) return
    const people = Number(peopleInput)
    // 人数前置校验：非整数/小于 1 直接行内报错，不发请求（与服务端 400 口径一致）
    if (!Number.isInteger(people) || people < 1) {
      setFormError('人数须为不小于 1 的整数')
      return
    }
    setFormError('')
    setMenuError('')
    setMenuLoading(true)
    try {
      // preference 选填：trim 后为空则不携带该字段（与服务端「空串视为未提供」口径一致）
      const pref = preference.trim()
      const res = await apiFetch('/api/ai/menu', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(pref === '' ? { people } : { people, preference: pref }),
      })
      if (!res.ok) {
        // 400/502/503 均为 { error: 中文 }；502 文案自带首轮解析详情，整条透出到顶部错误条
        let msg = `请求失败（HTTP ${res.status}）`
        try {
          const data = (await res.json()) as { error?: string }
          if (typeof data?.error === 'string' && data.error !== '') msg = data.error
        } catch {
          // 保留默认文案
        }
        setMenuError(msg)
        return
      }
      const data = (await res.json()) as { dishes: MenuDish[]; shopping: string[] }
      // 新菜单覆盖旧菜单，并重置全部 per-dish 状态（人数/偏好变了，旧菜卡的生成与入库状态不再适用）
      setMenu({ people, dishes: data.dishes, shopping: data.shopping })
      setDishStates({})
      setSavedNames({})
      setSavingNames({})
    } catch {
      setMenuError('网络异常，请稍后重试')
    } finally {
      setMenuLoading(false)
    }
  }

  // 第二段：单菜生成完整菜谱（per-dish 独立请求与状态，互不阻塞）
  async function handleGenerate(name: string) {
    if (!menu) return
    const st = dishStates[name]
    // 幂等兜底：该菜已在生成中或已就绪直接返回（按钮禁用为主，此判断防极端连点/同名菜重复调用）
    if (st && (st.phase === 'generating' || st.phase === 'ready')) return
    setDishStates((prev) => ({ ...prev, [name]: { phase: 'generating' } }))
    try {
      const res = await apiFetch('/api/ai/recipes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dish: name, servings: menu.people }),
      })
      if (res.ok) {
        // 注意：/api/ai/recipes 200 为 { recipe } 包裹形状（与 /api/recipes 入库接口的裸 Recipe 不同）
        const data = (await res.json()) as { recipe: Recipe }
        setDishStates((prev) => ({ ...prev, [name]: { phase: 'ready', recipe: data.recipe } }))
        return
      }
      // 失败：仅该菜卡内局部红字（优先透出服务端中文 error），phase 回 idle 允许重试，不影响其他菜
      let msg = `生成失败（HTTP ${res.status}）`
      try {
        const data = (await res.json()) as { error?: string }
        if (typeof data?.error === 'string' && data.error !== '') msg = data.error
      } catch {
        // 保留默认文案
      }
      setDishStates((prev) => ({ ...prev, [name]: { phase: 'idle', error: msg } }))
    } catch {
      setDishStates((prev) => ({ ...prev, [name]: { phase: 'idle', error: '网络异常，请稍后重试' } }))
    }
  }

  // 入库：POST /api/recipes（契约 Task 4：201 裸 Recipe | 400 { error: 中文 }），逻辑与 ChatView.saveRecipe 同款
  async function saveRecipe(name: string, recipe: Recipe) {
    // 防抖兜底：已入库或请求进行中直接返回（按钮禁用为主，此判断防极端连点）
    if (savedNames[name] || savingNames[name]) return
    setSavingNames((prev) => ({ ...prev, [name]: true }))
    try {
      const res = await apiFetch('/api/recipes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(toDraft(recipe)),
      })
      if (res.status === 201) {
        setSavedNames((prev) => ({ ...prev, [name]: true }))
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
      // 请求结束（无论成败）必移出 in-flight 集合；成功后由 savedNames 接管禁用
      setSavingNames((prev) => {
        const next = { ...prev }
        delete next[name]
        return next
      })
    }
  }

  // 移动端三约束：输入框 text-base（16px）+ min-h-[44px]；表单弹性行 min-w-0 防横滚
  const inputClass =
    'min-h-[44px] w-full min-w-0 rounded-lg border border-neutral-300 px-3 text-base outline-none focus:border-neutral-900'

  return (
    <main className="mx-auto max-w-3xl px-4 py-4">
      <h1 className="mb-3 text-lg font-medium text-neutral-900">点菜</h1>

      {/* menu 请求失败的页面顶部错误条（400/502/503；502 文案含服务端解析详情） */}
      {menuError !== '' && (
        <div role="alert" className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">
          {menuError}
        </div>
      )}

      {/* 第一段表单：人数 + 口味偏好（选填）+ 开始点菜 */}
      <section
        aria-label="点菜条件"
        className="mb-4 flex flex-col gap-2 rounded-xl border border-neutral-200 bg-white p-4"
      >
        <label htmlFor="people" className="text-sm text-neutral-600">
          用餐人数
        </label>
        <input
          id="people"
          type="number"
          inputMode="numeric"
          min={1}
          step={1}
          value={peopleInput}
          onChange={(e) => setPeopleInput(e.target.value)}
          placeholder="例如：4"
          aria-label="用餐人数"
          className={inputClass}
        />
        <label htmlFor="preference" className="text-sm text-neutral-600">
          口味偏好（选填）
        </label>
        <input
          id="preference"
          type="text"
          value={preference}
          onChange={(e) => setPreference(e.target.value)}
          placeholder="例如：清淡、少辣、孩子吃"
          aria-label="口味偏好（选填）"
          className={inputClass}
        />
        {/* 人数非法行内提示 */}
        {formError !== '' && <p className="text-sm text-red-500">{formError}</p>}
        <button
          type="button"
          onClick={() => void handleMenu()}
          disabled={menuLoading}
          aria-label="开始点菜"
          className="min-h-[44px] w-full rounded-lg bg-neutral-900 text-base font-medium text-white transition-colors active:bg-neutral-700 disabled:bg-neutral-300 disabled:text-neutral-500"
        >
          {menuLoading ? '点菜中…' : '开始点菜'}
        </button>
      </section>

      {/* 首次进入空态 */}
      {!menu && !menuLoading && (
        <p className="py-10 text-center text-sm text-neutral-400">
          输入人数，让 AI 搭一桌菜；看中哪道再单独生成完整菜谱
        </p>
      )}

      {/* 等待菜单：占位指示 */}
      {menuLoading && (
        <p className="py-10 text-center text-sm text-neutral-400" aria-live="polite">
          AI 正在搭配菜单…
        </p>
      )}

      {menu && (
        <>
          {/* 推荐菜单：菜卡列表（菜名 + 分类徽标 + 推荐理由 + 生成菜谱按钮） */}
          <h2 className="mb-2 text-base font-medium text-neutral-900">
            推荐菜单（{menu.dishes.length} 道）
          </h2>
          <ul className="mb-4 flex flex-col gap-3">
            {menu.dishes.map((d, i) => {
              // 该菜当前两段式状态（无记录视为 idle）；同名菜天然共用同一份状态
              const st: DishState = dishStates[d.name] ?? { phase: 'idle' }
              return (
                <li
                  key={`${d.name}-${i}`}
                  aria-label={`推荐菜：${d.name}`}
                  className="flex flex-col gap-3 rounded-xl border border-neutral-200 bg-white p-4"
                >
                  {/* 头部：菜名 + 分类徽标；弹性行 min-w-0 防溢出（无横滚约束） */}
                  <header className="flex min-w-0 flex-wrap items-center gap-2">
                    <h3 className="min-w-0 text-base font-semibold text-neutral-900">{d.name}</h3>
                    <span className="shrink-0 rounded-full bg-neutral-900 px-2 py-0.5 text-xs text-white">
                      {d.category}
                    </span>
                  </header>
                  {/* 推荐理由：break-words 防长文本撑破（无横滚） */}
                  <p className="min-w-0 break-words text-sm leading-6 text-neutral-600">{d.reason}</p>
                  {/* 该菜生成失败的局部红字：仅本卡展示，不阻塞其他菜 */}
                  {st.error && <p className="text-sm text-red-500">{st.error}</p>}
                  {/* 生成菜谱按钮：generating/ready 均禁用（同名菜防重复触发） */}
                  <button
                    type="button"
                    onClick={() => void handleGenerate(d.name)}
                    disabled={st.phase === 'generating' || st.phase === 'ready'}
                    aria-label={`生成菜谱：${d.name}`}
                    className="min-h-[44px] w-full rounded-lg border border-neutral-300 bg-white text-base font-medium text-neutral-900 transition-colors active:bg-neutral-100 disabled:border-neutral-200 disabled:bg-neutral-100 disabled:text-neutral-400"
                  >
                    {st.phase === 'generating' ? '生成中…' : st.phase === 'ready' ? '已生成' : '生成菜谱'}
                  </button>
                  {/* 第二段：就绪后卡下方展开完整菜谱卡片（含入库按钮，入库防抖以菜名为键） */}
                  {st.phase === 'ready' && st.recipe && (
                    <RecipeCard
                      recipe={st.recipe}
                      onSave={() => void saveRecipe(d.name, st.recipe!)}
                      saved={savedNames[d.name] ?? false}
                      saving={savingNames[d.name] ?? false}
                    />
                  )}
                </li>
              )
            })}
          </ul>

          {/* 采购建议清单区块：合并去重后的采购清单 */}
          <section aria-label="采购建议" className="rounded-xl border border-neutral-200 bg-white p-4">
            <h2 className="mb-2 text-base font-medium text-neutral-900">采购建议</h2>
            {menu.shopping.length > 0 ? (
              <ul className="flex list-disc flex-col gap-1 pl-5 text-sm leading-6 text-neutral-800">
                {menu.shopping.map((item, i) => (
                  <li key={i} className="min-w-0 break-words">
                    {item}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-neutral-400">暂无采购建议</p>
            )}
          </section>
        </>
      )}
    </main>
  )
}
