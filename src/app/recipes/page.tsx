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

  // 标签 chips 数据：从当前返回的全量列表（无 tag 过滤时）聚合 tag 去重
  const [allTags, setAllTags] = useState<string[]>([])

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
      if (!res.ok) return
      const data = (await res.json()) as ListResponse
      // 丢弃过期响应，只保留最后一次请求结果
      if (id !== requestIdRef.current) return
      setRecipes(data.recipes)
      setInvalidFiles(data.invalidFiles)
      // 仅在无标签过滤时聚合全量标签，作为 chips 数据源
      if (!activeTag) {
        setAllTags([...new Set(data.recipes.flatMap((r) => r.tags))])
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

      {/* 标签 chips：来自当前库内全部标签；再次点击取消选中 */}
      {allTags.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-2">
          {allTags.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTag((prev) => (prev === t ? null : t))}
              className={`min-h-[44px] rounded-full border px-3 text-sm transition-colors ${
                tag === t
                  ? 'border-neutral-900 bg-neutral-900 text-white dark:border-neutral-100 dark:bg-neutral-100 dark:text-neutral-900'
                  : 'border-neutral-300 bg-white text-neutral-600 active:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300 dark:active:bg-neutral-800'
              }`}
            >
              {t}
            </button>
          ))}
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
