'use client'

// 菜谱库列表页：搜索（300ms 防抖）+ 分类/标签两行横滑筛选 + 列表渲染 + 空态 + 新增浮动按钮
// 筛选语义：分类与标签各为单选维度，值为 null 表示「全部」；与搜索词三者取交集。
// 标签行随分类收敛（facets 由后端算），避免点出必然为空的组合（真实数据里 69% 的分类×标签组合为空）。
import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import Link from 'next/link'
import RecipeListItem from '@/components/RecipeListItem'
import FilterRow from '@/components/FilterRow'
import { apiFetch } from '@/lib/api-fetch'
import { describeFilters, initialDimensions, reduceDimensions } from '@/lib/recipe-filter-state'
import type { Recipe } from '@/lib/recipe-types'

// 响应契约：GET /api/recipes?q=&category=&tag= → 200 { recipes, invalidFiles, facets }
interface ListResponse {
  recipes: Recipe[]
  invalidFiles: string[]
  // facets：分类行全量（实际存在的）、标签行随 category 收敛
  facets: { categories: string[]; tags: string[] }
}

export default function RecipesPage() {
  // 搜索框受控值（立即回显）；q 为防抖后的实际请求参数
  const [inputValue, setInputValue] = useState('')
  const [q, setQ] = useState('')
  // 筛选状态（分类 + 标签两个维度，null = 「全部」）交给纯 reducer：
  // 「切分类不动标签」这条不变量由 reduceDimensions 保证并有单测锁定，
  // 避免以前那种「点分类的『全部』顺手把标签清了」的跨行耦合回归。
  const [dims, dispatchDims] = useReducer(reduceDimensions, initialDimensions)
  const { category, tag } = dims
  const [recipes, setRecipes] = useState<Recipe[]>([])
  const [invalidFiles, setInvalidFiles] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  // 网络异常错误文案（T5 遗留补齐）：非空时顶部红条展示
  const [loadError, setLoadError] = useState('')
  // 竞态防护：只接受最后一次请求的结果，防止乱序响应覆盖新结果
  const requestIdRef = useRef(0)

  // 筛选面板数据（由后端 facets 提供）：分类行全量、标签行随分类收敛
  const [facets, setFacets] = useState<{ categories: string[]; tags: string[] }>({
    categories: [],
    tags: [],
  })

  // 拉取菜谱列表：q/tag 变化都会触发
  const loadRecipes = useCallback(async (
    query: string,
    activeCategory: string | null,
    activeTag: string | null,
  ) => {
    const id = ++requestIdRef.current
    setLoading(true)
    setLoadError('')
    try {
      const params = new URLSearchParams()
      if (query.trim()) params.set('q', query.trim())
      if (activeCategory) params.set('category', activeCategory)
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
      // facets 直接来自后端（一次请求算好，chips 不会因并发改库与实际数据错位）
      if (data.facets) setFacets(data.facets)
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

  // q / category / tag 任一变化时重新拉取
  useEffect(() => {
    void loadRecipes(q, category, tag)
  }, [q, category, tag, loadRecipes])

  // 切换分类：若当前标签不在新分类的 facets 里（例如选了「清淡」再切到「荤菜」），
  // 自动回退「全部」，避免「标签看不见但仍在过滤」的幽灵状态
  // 切分类只改分类（不变量由 reduceDimensions 保证）；新分类下旧标签若失效，
  // 由 facets 校正 effect 负责回退，此处不做预判。
  const handleCategoryChange = useCallback((next: string | null) => {
    dispatchDims({ type: 'setCategory', value: next })
  }, [])

  // 响应回来后再校正一次标签有效性（依赖 facets，避免猜错）
  useEffect(() => {
    dispatchDims({ type: 'syncFacetTags', facetTags: facets.tags })
  }, [facets.tags])

  const activeFilters = describeFilters({ q, category, tag })
  const hasFilters = activeFilters.length > 0
  const clearFilters = () => {
    setInputValue('')
    setQ('')
    dispatchDims({ type: 'clear' })
  }

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

      {/* 筛选区：分类 / 标签各一行、单行横滑；均以「全部」为首项且默认选中。
          标签行的 options 来自 facets.tags——已随分类收敛，故不会点出必然为空的组合。
          没有对应数据时不渲染该行（空库时两行都消失）：只有「全部」一个选项的筛选没有意义。 */}
      {/* 不用 !loading 包住：筛选/搜索的 refetch 期间 loading=true 会让两行筛选消失再出现（整块跳动）。
          facets 初始为空，所以首次加载不会渲染；刷新时保留上一份 facets，布局稳定。 */}
      {(facets.categories.length > 0 || facets.tags.length > 0) && (
        <div className="mb-3 flex flex-col gap-2">
          {facets.categories.length > 0 && (
            <FilterRow
              label="分类"
              ariaLabel="按分类筛选"
              options={facets.categories}
              value={category}
              onChange={handleCategoryChange}
            />
          )}
          {facets.tags.length > 0 && (
            <FilterRow
              label="标签"
              ariaLabel="按标签筛选"
              options={facets.tags}
              value={tag}
              onChange={(next) => dispatchDims({ type: 'setTag', value: next })}
            />
          )}
        </div>
      )}

      {/* 列表主体：加载中 / 空态 / 列表三态 */}
      {loading ? (
        <p className="py-10 text-center text-sm text-neutral-400 dark:text-neutral-500">加载中…</p>
      ) : recipes.length === 0 ? (
        hasFilters ? (
          // 明确说明是哪个（些）条件导致空结果，并提供一键清除——
          // 组合筛选下只说「没有匹配」会让用户不知道是搜索词还是筛选的问题
          <div className="py-10 text-center">
            <p className="text-sm text-neutral-400 dark:text-neutral-500">
              {/* 单条件时说「同时满足」很别扭；只有多条件才用「同时」 */}
              没有{activeFilters.length > 1 ? '同时' : ''}满足{activeFilters.join(' + ')}的菜谱
            </p>
            <button
              type="button"
              onClick={clearFilters}
              className="mt-3 inline-flex min-h-[36px] items-center rounded-md border border-neutral-300 px-4 text-sm text-neutral-600 transition-[background-color,border-color,color] active:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:active:bg-neutral-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-900 dark:focus-visible:outline-neutral-100"
            >
              清除筛选
            </button>
          </div>
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
