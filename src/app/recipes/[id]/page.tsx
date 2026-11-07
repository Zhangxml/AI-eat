'use client'

// 菜谱详情页：查看 / 编辑 / 删除三态客户端页面
// 契约（Task 4，全部为裸形状，无 { recipe } 包裹）：
//   GET /api/recipes/:id    → 200 Recipe | 404 { error }
//   PUT /api/recipes/:id    → 200 Recipe | 400 { error } | 404 { error }
//   DELETE /api/recipes/:id → 204 无 body | 404 { error }
// Next 15 动态路由：params 为 Promise，客户端组件内 use(params) 取 id
import { use, useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import RecipeForm from '@/components/RecipeForm'
import { apiFetch } from '@/lib/api-fetch'
import type { DraftRecipe, Recipe } from '@/lib/recipe-types'

// 页面三种状态：loading 拉取中 / view 详情态 / edit 编辑态
type PageMode = 'loading' | 'view' | 'edit'

// 分类徽标配色：与 RecipeListItem 保持一致（含 dark: 变体）
const CATEGORY_STYLES: Record<NonNullable<Recipe['category']>, string> = {
  荤菜: 'bg-red-50 text-red-700 dark:bg-red-900/40 dark:text-red-300',
  素菜: 'bg-green-50 text-green-700 dark:bg-green-900/40 dark:text-green-300',
  汤: 'bg-amber-50 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  主食: 'bg-blue-50 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
  其他: 'bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300',
}

// 从服务端错误响应中提取中文 error；解析失败回退默认文案
async function extractError(res: Response, fallback: string): Promise<string> {
  try {
    const data = (await res.json()) as { error?: string }
    if (typeof data?.error === 'string' && data.error !== '') return data.error
  } catch {
    // 保留默认文案
  }
  return fallback
}

// 详情页默认组件：params 为 Promise（Next 15 签名），use 解包取 id
export default function RecipeDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const router = useRouter()

  const [mode, setMode] = useState<PageMode>('loading')
  const [recipe, setRecipe] = useState<Recipe | null>(null)
  const [notFound, setNotFound] = useState(false)
  const [errorText, setErrorText] = useState('')
  const [deleting, setDeleting] = useState(false)

  // 拉取详情：GET 200 裸 Recipe 进入详情态；404 进 404 态（提示并给回列表入口）
  const loadRecipe = useCallback(async () => {
    setMode('loading')
    setNotFound(false)
    setErrorText('')
    try {
      const res = await apiFetch(`/api/recipes/${encodeURIComponent(id)}`)
      if (res.status === 404) {
        setNotFound(true)
        return
      }
      if (!res.ok) {
        // 非 404 的失败（500 等）：透出服务端中文 error，读不到给通用文案
        setErrorText(await extractError(res, '加载失败，请稍后重试'))
        return
      }
      // 裸形状：直接就是 Recipe 本体
      setRecipe((await res.json()) as Recipe)
      setMode('view')
    } catch {
      // 网络异常等 fetch 抛错场景
      setErrorText('加载失败，网络异常，请稍后重试')
    }
  }, [id])

  useEffect(() => {
    void loadRecipe()
  }, [loadRecipe])

  // 删除：confirm 确认 → DELETE → 204 跳回列表；404 提示后同样回列表
  async function handleDelete() {
    if (!recipe || deleting) return
    if (!confirm(`确定删除「${recipe.name}」吗？删除后无法恢复。`)) return
    setDeleting(true)
    try {
      const res = await apiFetch(`/api/recipes/${encodeURIComponent(id)}`, { method: 'DELETE' })
      if (res.status === 204) {
        router.push('/recipes')
        return
      }
      if (res.status === 404) {
        // 已不存在：提示后回列表（列表显示的即是最新状态）
        alert('该菜谱已不存在，即将返回列表')
        router.push('/recipes')
        return
      }
      alert(await extractError(res, '删除失败，请稍后重试'))
    } catch {
      alert('删除失败，网络异常，请稍后重试')
    } finally {
      setDeleting(false)
    }
  }

  // 编辑提交：PUT 草稿，200 裸 Recipe 直接作为新本地 state 并切回详情态（不整页刷新）
  async function handleUpdate(draft: DraftRecipe): Promise<Response> {
    const res = await apiFetch(`/api/recipes/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(draft),
    })
    if (res.ok) {
      setRecipe((await res.json()) as Recipe)
      setMode('view')
    }
    // 失败时 Response 原样交还 RecipeForm 统一 alert 中文错误
    return res
  }

  // 404 态：提示并给返回列表入口（不自动跳转，避免打断用户）。
  // 守卫顺序说明：loadRecipe 的失败分支只置 notFound/errorText，mode 保持 'loading'，
  // 因此 404/错误两个终态守卫必须全部排在 loading 守卫之前，否则会被「加载中…」永久挡住
  if (notFound) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-4">
        <p className="py-10 text-center text-sm text-neutral-500 dark:text-neutral-400">菜谱不存在或已被删除</p>
        <div className="flex justify-center">
          <Link
            href="/recipes"
            className="flex min-h-[44px] items-center rounded-lg px-4 text-sm text-neutral-900 underline transition-colors active:bg-neutral-100 dark:text-neutral-100 dark:active:bg-neutral-800"
          >
            返回菜谱库
          </Link>
        </div>
      </main>
    )
  }

  // 错误态（非 404 失败）：提示 + 重试 + 返回列表。
  // 守卫顺序说明：loadRecipe 的失败分支只置 notFound/errorText，mode 保持 'loading'，
  // 因此 404/错误两个终态守卫必须全部排在 loading 守卫之前，否则会被「加载中…」永久挡住
  if (errorText !== '') {
    return (
      <main className="mx-auto max-w-3xl px-4 py-4">
        <p className="py-10 text-center text-sm text-neutral-500 dark:text-neutral-400">{errorText}</p>
        <div className="flex justify-center gap-3">
          <button
            type="button"
            onClick={() => void loadRecipe()}
            className="flex min-h-[44px] items-center rounded-lg border border-neutral-900 px-4 text-sm font-medium text-neutral-900 transition-colors active:bg-neutral-100 dark:border-neutral-100 dark:text-neutral-100 dark:active:bg-neutral-800"
          >
            重试
          </button>
          <Link
            href="/recipes"
            className="flex min-h-[44px] items-center rounded-lg border border-neutral-300 px-4 text-sm text-neutral-600 transition-colors active:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-400 dark:active:bg-neutral-800"
          >
            返回菜谱库
          </Link>
        </div>
      </main>
    )
  }

  // 加载态：排在 404/错误守卫之后（该两态命中时 mode 仍为 'loading'，靠前面守卫先返回）
  if (mode === 'loading') {
    return (
      <main className="mx-auto max-w-3xl px-4 py-4">
        <p className="py-10 text-center text-sm text-neutral-400 dark:text-neutral-500">加载中…</p>
      </main>
    )
  }

  // 编辑态：复用 RecipeForm（initial=recipe），PUT 成功已在上面切回详情态
  if (mode === 'edit' && recipe) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-4">
        <header className="mb-4 flex items-center justify-between gap-2">
          <h1 className="min-w-0 flex-1 truncate text-lg font-medium text-neutral-900 dark:text-neutral-100">
            编辑「{recipe.name}」
          </h1>
          <button
            type="button"
            onClick={() => setMode('view')}
            className="flex min-h-[44px] shrink-0 items-center text-sm text-neutral-500 transition-colors active:text-neutral-900 dark:text-neutral-400 dark:active:text-neutral-100"
          >
            取消
          </button>
        </header>
        <RecipeForm initial={recipe} onSubmit={handleUpdate} submitLabel="保存修改" />
      </main>
    )
  }

  // 详情态兜底：recipe 理论上必非空（三态互斥），仅为类型收窄
  if (!recipe) return null

  return (
    <main className="mx-auto max-w-3xl px-4 py-4">
      {/* 页头：菜名 + 分类徽标 + 操作按钮（编辑/删除），按钮触摸目标 ≥44px */}
      <header className="mb-4 flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <h1 className="min-w-0 truncate text-xl font-medium text-neutral-900 dark:text-neutral-100">{recipe.name}</h1>
          {recipe.category && (
            <span
              className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${CATEGORY_STYLES[recipe.category]}`}
            >
              {recipe.category}
            </span>
          )}
        </div>
        <div className="flex shrink-0 gap-2">
          <button
            type="button"
            onClick={() => setMode('edit')}
            className="flex min-h-[44px] items-center rounded-lg border border-neutral-900 px-3 text-sm font-medium text-neutral-900 transition-colors active:bg-neutral-100 dark:border-neutral-100 dark:text-neutral-100 dark:active:bg-neutral-800"
          >
            编辑
          </button>
          <button
            type="button"
            onClick={() => void handleDelete()}
            disabled={deleting}
            className="flex min-h-[44px] items-center rounded-lg border border-red-200 px-3 text-sm text-red-600 transition-colors active:bg-red-50 disabled:opacity-60 dark:border-red-900 dark:text-red-400 dark:active:bg-red-950"
          >
            {deleting ? '删除中…' : '删除'}
          </button>
        </div>
      </header>

      {/* 元信息：份量 / 难度 / 总时长 / 来源，小字一行 */}
      <p className="text-sm text-neutral-500 dark:text-neutral-400">
        {recipe.servings} 人份 · 难度 {recipe.difficulty} · 约 {recipe.totalTimeMin} 分钟 ·{' '}
        {recipe.source === 'ai' ? 'AI 生成' : '手动录入'}
      </p>

      {/* 标签：可选，空数组不渲染 */}
      {recipe.tags.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2">
          {recipe.tags.map((t) => (
            <span
              key={t}
              className="rounded-full border border-neutral-200 bg-white px-2 py-0.5 text-xs text-neutral-600 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300"
            >
              {t}
            </span>
          ))}
        </div>
      )}

      {/* 营养：缺失显示「未估算」；有值显示四项数值并标注 AI 估算值（estimated 恒 true，人工录入带营养同样标注） */}
      <section className="mt-4 rounded-xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
        {recipe.nutrition ? (
          <>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <div>
                <p className="text-xs text-neutral-500 dark:text-neutral-400">热量</p>
                <p className="text-base text-neutral-900 dark:text-neutral-100">{recipe.nutrition.caloriesKcal} 千卡</p>
              </div>
              <div>
                <p className="text-xs text-neutral-500 dark:text-neutral-400">蛋白质</p>
                <p className="text-base text-neutral-900 dark:text-neutral-100">{recipe.nutrition.proteinG} 克</p>
              </div>
              <div>
                <p className="text-xs text-neutral-500 dark:text-neutral-400">脂肪</p>
                <p className="text-base text-neutral-900 dark:text-neutral-100">{recipe.nutrition.fatG} 克</p>
              </div>
              <div>
                <p className="text-xs text-neutral-500 dark:text-neutral-400">碳水</p>
                <p className="text-base text-neutral-900 dark:text-neutral-100">{recipe.nutrition.carbG} 克</p>
              </div>
            </div>
            <p className="mt-2 text-xs text-neutral-400 dark:text-neutral-500">AI 估算值，仅供参考</p>
          </>
        ) : (
          <p className="text-sm text-neutral-400 dark:text-neutral-500">营养：未估算</p>
        )}
      </section>

      {/* 食材：分区标题 + 名称/用量列表 */}
      <section className="mt-4">
        <h2 className="mb-2 text-base font-medium text-neutral-900 dark:text-neutral-100">
          食材（{recipe.ingredients.length}）
        </h2>
        <ul className="rounded-xl border border-neutral-200 bg-white px-4 py-1 dark:border-neutral-800 dark:bg-neutral-900">
          {recipe.ingredients.map((ing, idx) => (
            <li
              key={`${ing.name}-${idx}`}
              className="flex items-baseline gap-2 border-b border-neutral-100 py-2.5 text-sm last:border-b-0 dark:border-neutral-800"
            >
              <span className="min-w-0 flex-1 text-neutral-900 dark:text-neutral-100">{ing.name}</span>
              <span className="shrink-0 text-neutral-500 dark:text-neutral-400">{ing.amount}</span>
            </li>
          ))}
        </ul>
      </section>

      {/* 步骤：有序列表（编号圆点即顺序），长文本自动换行不撑出横滚 */}
      <section className="mt-4">
        <h2 className="mb-2 text-base font-medium text-neutral-900 dark:text-neutral-100">
          步骤（{recipe.steps.length}）
        </h2>
        <ol className="flex flex-col gap-2">
          {recipe.steps.map((step, idx) => (
            <li
              key={idx}
              className="flex items-start gap-2 rounded-xl border border-neutral-200 bg-white p-3 dark:border-neutral-800 dark:bg-neutral-900"
            >
              <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-neutral-900 text-xs text-white dark:bg-neutral-100 dark:text-neutral-900">
                {idx + 1}
              </span>
              <p className="min-w-0 flex-1 whitespace-pre-wrap break-words text-sm leading-relaxed text-neutral-900 dark:text-neutral-100">
                {step}
              </p>
            </li>
          ))}
        </ol>
      </section>
    </main>
  )
}
