'use client'

// RecipeCard：菜谱展示卡片（Task 12），聊天页与点菜页（T14）共用
// props 契约（与简报一字不差）：{ recipe: Recipe; onSave?: () => void; saved?: boolean }
// 审查修复新增可选扩展 prop：saving?: boolean（入库请求 in-flight 时禁用按钮，防止 201 往返期间双击双入库；
// 缺省 false，T14 复用时可不传，原有三 props 语义不变）
// - 名称、分类徽标（可选，无分类不渲染）、时长、份数、食材表（名称+用量）、步骤有序列表、营养
// - 营养：有值显示数值并标注「估算值」，缺失显示「未估算」
// - onSave 存在时渲染「存入菜谱库」按钮；saved 为 true 时按钮变「已入库」且禁用（防重复点击）
// 纯展示组件：不发请求、不持路由，入库动作由宿主（ChatView/T14）通过 onSave 提供
import type { Recipe } from '@/lib/recipe-types'

export default function RecipeCard({
  recipe,
  onSave,
  saved,
  saving,
}: {
  recipe: Recipe
  onSave?: () => void
  saved?: boolean
  saving?: boolean
}) {
  return (
    <section
      aria-label={`菜谱：${recipe.name}`}
      className="flex flex-col gap-3 rounded-xl border border-neutral-200 bg-white p-4"
    >
      {/* 头部：名称 + 分类徽标（category 可选）；弹性行 min-w-0 防溢出（无横滚约束） */}
      <header className="flex min-w-0 flex-wrap items-center gap-2">
        <h3 className="min-w-0 text-base font-semibold text-neutral-900">{recipe.name}</h3>
        {recipe.category && (
          <span className="shrink-0 rounded-full bg-neutral-900 px-2 py-0.5 text-xs text-white">
            {recipe.category}
          </span>
        )}
      </header>

      {/* 元信息：时长 / 份数 / 难度 / 标签，紧凑单行，可换行不横滚 */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-neutral-600">
        <span>⏱ {recipe.totalTimeMin} 分钟</span>
        <span>👥 {recipe.servings} 人份</span>
        <span>难度：{recipe.difficulty}</span>
        {recipe.tags.length > 0 && <span className="min-w-0">标签：{recipe.tags.join('、')}</span>}
      </div>

      {/* 食材表：名称 + 用量 */}
      <div>
        <h4 className="mb-1 text-sm font-medium text-neutral-700">食材</h4>
        <ul className="flex flex-col gap-1 text-sm text-neutral-800">
          {recipe.ingredients.map((ing, i) => (
            <li key={i} className="flex min-w-0 items-baseline gap-2">
              <span className="shrink-0 text-neutral-500">·</span>
              <span className="min-w-0 break-words">{ing.name}</span>
              <span className="min-w-0 break-words text-neutral-500">{ing.amount}</span>
            </li>
          ))}
        </ul>
      </div>

      {/* 步骤有序列表 */}
      <div>
        <h4 className="mb-1 text-sm font-medium text-neutral-700">步骤</h4>
        <ol className="flex list-decimal flex-col gap-1 pl-5 text-sm leading-6 text-neutral-800">
          {recipe.steps.map((step, i) => (
            <li key={i} className="min-w-0 break-words">
              {step}
            </li>
          ))}
        </ol>
      </div>

      {/* 营养：estimated 恒为 true（AI 估算口径）→ 有值必须带「估算值」标注；缺失显示「未估算」 */}
      <div className="text-sm text-neutral-600">
        {recipe.nutrition ? (
          <>
            营养（估算值）：{recipe.nutrition.caloriesKcal} 千卡 · 蛋白质{' '}
            {recipe.nutrition.proteinG} 克 · 脂肪 {recipe.nutrition.fatG} 克 · 碳水{' '}
            {recipe.nutrition.carbG} 克
          </>
        ) : (
          <>营养：未估算</>
        )}
      </div>

      {/* 入库按钮：仅宿主提供 onSave 时渲染；saved（已入库）或 saving（请求 in-flight）均禁用（防重复/防双击） */}
      {onSave && (
        <button
          type="button"
          onClick={onSave}
          disabled={saved || saving}
          aria-label={saved ? '已入库' : '存入菜谱库'}
          className="min-h-[44px] w-full rounded-lg bg-neutral-900 text-base font-medium text-white transition-colors active:bg-neutral-700 disabled:bg-neutral-300 disabled:text-neutral-500"
        >
          {saved ? '已入库' : saving ? '入库中…' : '存入菜谱库'}
        </button>
      )}
    </section>
  )
}
