// 菜谱库列表行组件：名称 + 分类徽标 + 时长/难度 + 食材摘要，整行可点击跳详情页
import Link from 'next/link'
import type { Recipe } from '@/lib/recipe-types'

// 分类徽标配色（Tailwind 默认色板软色背景 + 深色文字）；category 可选，未设置时不渲染徽标
// dark: 变体统一换为深底浅字（dark-50 → 900/800），保持明暗两种模式下的对比度
const CATEGORY_STYLES: Record<NonNullable<Recipe['category']>, string> = {
  荤菜: 'bg-red-50 text-red-700 dark:bg-red-900/40 dark:text-red-300',
  素菜: 'bg-green-50 text-green-700 dark:bg-green-900/40 dark:text-green-300',
  汤: 'bg-amber-50 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  主食: 'bg-blue-50 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
  其他: 'bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300',
}

// 列表行默认组件：整行为 Link 触摸目标（内边距 + 内容远超 44px）
export default function RecipeListItem({ recipe }: { recipe: Recipe }) {
  // 食材摘要：仅取食材名以顿号拼接；配合 truncate 单行截断，长食材名不会撑出横向滚动
  const ingredientSummary = recipe.ingredients.map((i) => i.name).join('、')

  return (
    <li>
      <Link
        href={`/recipes/${recipe.id}`}
        className="block rounded-xl border border-neutral-200 bg-white p-4 transition-colors active:bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-900 dark:active:bg-neutral-800"
      >
        {/* 行首：名称（可截断）+ 分类徽标（不收缩） */}
        <div className="flex items-center gap-2">
          <h2 className="min-w-0 flex-1 truncate text-base font-medium text-neutral-900 dark:text-neutral-100">
            {recipe.name}
          </h2>
          {recipe.category && (
            <span
              className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${CATEGORY_STYLES[recipe.category]}`}
            >
              {recipe.category}
            </span>
          )}
        </div>
        {/* 行中：总时长与难度 */}
        <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
          约 {recipe.totalTimeMin} 分钟 · {recipe.difficulty}
        </p>
        {/* 行尾：食材摘要，单行截断 */}
        <p className="mt-1 truncate text-sm text-neutral-600 dark:text-neutral-400">食材：{ingredientSummary}</p>
      </Link>
    </li>
  )
}
