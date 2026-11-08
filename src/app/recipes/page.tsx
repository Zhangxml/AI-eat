'use client'

// 菜谱库列表页：搜索（300ms 防抖）+ 标签 chips 过滤 + 列表渲染 + 空态 + 新增浮动按钮
import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import RecipeListItem from '@/components/RecipeListItem'
import { apiFetch } from '@/lib/api-fetch'
import type { Recipe } from '@/lib/recipe-types'

// 响应契约：GET /api/recipes?q=&tag= → 200 { recipes, invalidFiles }
interface ListResponse {
  recipes: Recipe[]
  invalidFiles: string[]
}

// 标签 chips 默认展示上限：标签来源（AI 生成/人工录入）不可控、数量可能无限多，
// 只默认展示使用频次最高的前 N 个，其余折叠进「更多」（选中态标签强制显示，见渲染处注释）
const TAG_CHIPS_LIMIT = 10

export default function RecipesPage() {
  // 搜索框受控值（立即回显）；q 为防抖后的实际请求参数
  const [inputValue, setInputValue] = useState('')
  const [q, setQ] = useState('')
  const [tag, setTag] = useState<string | null>(null)
  const [recipes, setRecipes] = useState<Recipe[]>([])
  const [invalidFiles, setInvalidFiles] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  // 网络异常错误文案（T5 遗留补齐）：非空时顶部红条展示
  const [loadError, setLoadError] = useState('')
  // 竞态防护：只接受最后一次请求的结果，防止乱序响应覆盖新结果
  const requestIdRef = useRef(0)

  // 标签 chips 数据：从当前返回的全量列表（无 tag 过滤时）聚合 tag 去重，并按使用频次降序——
  // 高频标签才是有筛选价值的，低频长尾折进「更多」
  const [allTags, setAllTags] = useState<string[]>([])
  // 「更多」展开状态：默认收起只显示前 TAG_CHIPS_LIMIT 个
  const [showAllTags, setShowAllTags] = useState(false)

  // 拉取菜谱列表：q/tag 变化都会触发
  const loadRecipes = useCallback(async (query: string, activeTag: string | null) => {
    const id = ++requestIdRef.current
    setLoading(true)
    setLoadError('')
    try {
      const params = new URLSearchParams()
      if (query.trim()) params.set('q', query.trim())
      if (activeTag) params.set('tag', activeTag)
      const res = await apiFetch(`/api/recipes?${params.toString()}`)
      // 非 2xx：顶部错误条展示 HTTP 码（审计修复 #11——此前静默 return，列表停在旧数据/空态无任何提示）
      if (!res.ok) {
        if (id === requestIdRef.current) setLoadError(`加载失败（HTTP ${res.status}），请稍后重试`)
        return
      }
      const data = (await res.json()) as ListResponse
      // 丢弃过期响应，只保留最后一次请求结果
      if (id !== requestIdRef.current) return
      setRecipes(data.recipes)
      setInvalidFiles(data.invalidFiles)
      // 仅在无标签过滤时聚合全量标签：统计每个 tag 的使用次数，按频次降序排列
      if (!activeTag) {
        const counts = new Map<string, number>()
        for (const r of data.recipes) {
          for (const t of r.tags) counts.set(t, (counts.get(t) ?? 0) + 1)
        }
        setAllTags([...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([t]) => t))
      }
    } catch {
      // 网络异常（T5 遗留补齐）：置顶部错误条文案；过期响应不覆盖新状态
      if (id === requestIdRef.current) setLoadError('加载失败，网络异常，请稍后重试')
    } finally {
      if (id === requestIdRef.current) setLoading(false)
    }
  }, [])

  // 搜索防抖：input 事件后 300ms 才把值提交给请求参数，期间再次输入则重置计时
  useEffect(() => {
    const timer = setTimeout(() => setQ(inputValue), 300)
    return () => clearTimeout(timer)
  }, [inputValue])

  // q 或 tag 变化时重新拉取
  useEffect(() => {
    void loadRecipes(q, tag)
  }, [q, tag, loadRecipes])

  const hasFilters = q.trim() !== '' || tag !== null

  return (
    <main className="mx-auto max-w-3xl px-4 py-4">
      {/* invalidFiles 非空时顶部黄条：提示 N 个文件格式异常并列出文件名 */}
      {invalidFiles.length > 0 && (
        <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300">
          {invalidFiles.length} 个文件格式异常：{invalidFiles.join('、')}
        </div>
      )}

      {/* 网络异常顶部红条（T5 遗留补齐）：重新发起请求时自动清除 */}
      {loadError !== '' && (
        <div role="alert" className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
          {loadError}
        </div>
      )}

      {/* 搜索框：与浮动按钮同行，输入框高度 ≥44px */}
      <div className="mb-3 flex gap-2">
        <input
          type="search"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          placeholder="搜索菜名或食材"
          aria-label="搜索菜名或食材"
          className="min-h-[44px] min-w-0 flex-1 rounded-lg border border-neutral-300 bg-white px-3 text-base text-neutral-900 outline-none placeholder:text-neutral-400 focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100 dark:focus:border-neutral-100"
        />
      </div>

      {/* 标签 chips：默认只显示使用频次最高的前 10 个（标签来自 AI/人工录入，数量不可控，
          全量铺开会把筛选区撑成无限长）；「更多」展开/收起全部。
          审计修复 #12：渲染列表 = 前 10 个 ∪（该标签被选中时强制并入）——选中态标签收起后仍显示，
          否则用户点中第 11 位之后的标签再收起，唯一可取消选中的入口会从界面上消失 */}
      {allTags.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-2">
          {((): string[] => {
            const shown = showAllTags ? allTags : allTags.slice(0, TAG_CHIPS_LIMIT)
            return tag !== null && !shown.includes(tag) ? [...shown, tag] : shown
          })().map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTag((prev) => (prev === t ? null : t))}
              className={`rounded-full border px-3 py-1 text-sm transition-colors ${
                tag === t
                  ? 'border-neutral-900 bg-neutral-900 text-white dark:border-neutral-100 dark:bg-neutral-100 dark:text-neutral-900'
                  : 'border-neutral-300 bg-white text-neutral-600 active:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300 dark:active:bg-neutral-800'
              }`}
            >
              {t}
            </button>
          ))}
          {allTags.length > TAG_CHIPS_LIMIT && (
            <button
              type="button"
              onClick={() => setShowAllTags((prev) => !prev)}
              aria-label={showAllTags ? '收起标签' : '展开全部标签'}
              className="rounded-full border border-dashed border-neutral-300 px-3 py-1 text-sm text-neutral-500 transition-colors active:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-400 dark:active:bg-neutral-800"
            >
              {showAllTags ? '收起' : `更多 (${allTags.length - TAG_CHIPS_LIMIT})`}
            </button>
          )}
        </div>
      )}

      {/* 列表主体：加载中 / 空态 / 列表三态 */}
      {loading ? (
        <p className="py-10 text-center text-sm text-neutral-400 dark:text-neutral-500">加载中…</p>
      ) : recipes.length === 0 ? (
        hasFilters ? (
          <p className="py-10 text-center text-sm text-neutral-400 dark:text-neutral-500">没有匹配的菜谱，换个关键词试试</p>
        ) : (
          <p className="py-10 text-center text-sm text-neutral-400 dark:text-neutral-500">还没有菜谱，去录入一道吧</p>
        )
      ) : (
        <ul className="flex flex-col gap-2">
          {recipes.map((recipe) => (
            <RecipeListItem key={recipe.id} recipe={recipe} />
          ))}
        </ul>
      )}

      {/* 右下角浮动 + 按钮：56px 触摸目标，链接到录入页；bottom-20 预留可避开底部导航安全区 */}
      <Link
        href="/recipes/new"
        aria-label="录入新菜谱"
        className="fixed bottom-20 right-4 z-40 flex h-14 w-14 items-center justify-center rounded-full bg-neutral-900 text-3xl leading-none text-white shadow-lg transition-colors active:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:active:bg-neutral-300"
      >
        +
      </Link>
    </main>
  )
}
