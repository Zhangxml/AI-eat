'use client'

// RecipeForm：菜谱录入/编辑受控表单（Task 7 编辑页复用同一组件）
// props 契约（与简报一字不差）：{ initial?: Recipe; onSubmit: (draft: DraftRecipe) => Promise<Response>; submitLabel: string }
// 职责：受控收集字段 → 组装 DraftRecipe → 调 onSubmit；响应非 2xx 时 alert 中文错误
// 行内校验策略：顶层必填项走浏览器原生 required/number 校验；食材/步骤/营养等行级语义在本组件内校验并 alert
import { useLayoutEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { apiFetch } from '@/lib/api-fetch'
import type { DraftRecipe, Nutrition, Recipe } from '@/lib/recipe-types'

// 分类枚举与 recipe-types 保持一致；首项空串表示「不设置」
const CATEGORY_OPTIONS: NonNullable<Recipe['category']>[] = ['荤菜', '素菜', '汤', '主食', '其他']

// 食材行的受控状态结构
interface IngredientRow {
  name: string
  amount: string
}

// 步骤输入框：auto-grow 自适应高度——textarea 的 rows 属性只算显式换行，
// 不算自动折行，长文本（AI 生成的步骤普遍 2~4 个视觉行）会被裁剪出内部滚动条，
// 与页面外层滚动冲突。改为 ref 实测 scrollHeight 撑高：value 变化（手动输入/AI 回填）都重算。
function StepTextarea({ value, idx, onChange }: { value: string; idx: number; onChange: (v: string) => void }) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const resize = () => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }
  useLayoutEffect(resize, [value])
  return (
    <textarea
      ref={ref}
      rows={1}
      value={value}
      onChange={(e) => {
        onChange(e.target.value)
        resize()
      }}
      placeholder={`步骤 ${idx + 1}`}
      aria-label={`步骤 ${idx + 1}`}
      className="w-full min-w-0 flex-1 resize-none overflow-hidden rounded-lg border border-neutral-300 bg-transparent px-3 py-2 text-base leading-6 text-neutral-900 outline-none placeholder:text-neutral-400 focus:border-neutral-900 dark:border-neutral-700 dark:text-neutral-100 dark:focus:border-neutral-100"
    />
  )
}

// AI 估算接口契约（Task 10 提供）：POST /api/ai/recipes → 200 { recipe } | 503 { error }
interface AiEstimateResponse {
  recipe?: Recipe
}

export default function RecipeForm({
  initial,
  onSubmit,
  submitLabel,
}: {
  initial?: Recipe
  onSubmit: (draft: DraftRecipe) => Promise<Response>
  submitLabel: string
}) {
  // 顶层标量字段：数字类以字符串承载，提交时再解析校验
  const [name, setName] = useState(initial?.name ?? '')
  const [category, setCategory] = useState<Recipe['category']>(initial?.category)
  const [servings, setServings] = useState(initial ? String(initial.servings) : '1')
  const [difficulty, setDifficulty] = useState(initial?.difficulty ?? '')
  const [totalTimeMin, setTotalTimeMin] = useState(initial ? String(initial.totalTimeMin) : '')
  // 标签：受控为一段逗号分隔文本，提交时拆分；回显用中文逗号连接
  const [tagsText, setTagsText] = useState(initial ? initial.tags.join('，') : '')

  // 行编辑：食材/步骤均为数组 state，增删改即整行替换
  const [ingredients, setIngredients] = useState<IngredientRow[]>(
    initial?.ingredients ?? [{ name: '', amount: '' }],
  )
  const [steps, setSteps] = useState<string[]>(initial?.steps ?? [''])

  // 营养四项（选填）：字符串承载，整体填写/整体置空（见 buildDraft）
  const [caloriesText, setCaloriesText] = useState(initial ? String(initial.nutrition?.caloriesKcal ?? '') : '')
  const [proteinText, setProteinText] = useState(initial ? String(initial.nutrition?.proteinG ?? '') : '')
  const [fatText, setFatText] = useState(initial ? String(initial.nutrition?.fatG ?? '') : '')
  const [carbText, setCarbText] = useState(initial ? String(initial.nutrition?.carbG ?? '') : '')

  const [submitting, setSubmitting] = useState(false)
  const [estimating, setEstimating] = useState(false)
  // AI 整份生成（按名称）：生成中禁用相关按钮；完成后回填全部字段，由用户核对后手动保存
  const [generating, setGenerating] = useState(false)

  // 食材名非空集合：AI 按钮可用性判断与请求体共用
  const ingredientNames = ingredients.map((r) => r.name.trim()).filter((n) => n !== '')
  // AI 按钮禁用条件（裁定 3）：名称与食材（至少一行食材名非空）任一不满足，或请求进行中
  const aiDisabled = submitting || estimating || name.trim() === '' || ingredientNames.length === 0

  // 组装 DraftRecipe；行级/数字级校验失败时 alert 具体原因并返回 null（顶层必填项由原生校验先拦截）
  function buildDraft(): DraftRecipe | null {
    const trimName = name.trim()
    const trimDifficulty = difficulty.trim()
    if (trimName === '') {
      alert('请填写菜谱名称')
      return null
    }
    if (trimDifficulty === '') {
      alert('请填写难度')
      return null
    }
    const servingsNum = Number(servings)
    if (!Number.isInteger(servingsNum) || servingsNum < 1) {
      alert('份量需为不小于 1 的整数')
      return null
    }
    const totalMinNum = Number(totalTimeMin)
    if (!Number.isInteger(totalMinNum) || totalMinNum < 1) {
      alert('总时长需为不小于 1 的整数（分钟）')
      return null
    }

    // 食材行：整行空白视为误触新增，直接丢弃；半填行（只有名称或只有用量）视为未完成，拦截提交
    const cleanedIngredients = ingredients
      .map((r) => ({ name: r.name.trim(), amount: r.amount.trim() }))
      .filter((r) => r.name !== '' || r.amount !== '')
    if (cleanedIngredients.length === 0) {
      alert('请至少填写一行食材（名称与用量）')
      return null
    }
    if (cleanedIngredients.some((r) => r.name === '' || r.amount === '')) {
      alert('每行食材都需同时填写名称与用量')
      return null
    }

    const cleanedSteps = steps.map((s) => s.trim()).filter((s) => s !== '')
    if (cleanedSteps.length === 0) {
      alert('请至少填写一个步骤')
      return null
    }

    const tags = tagsText
      .split(/[,，]/)
      .map((t) => t.trim())
      .filter((t) => t !== '')

    // 营养整体语义（裁定 2）：四项全空 → 置 undefined；任一填写 → 视为整体填写，四项都必须是 ≥0 的数值
    const nutritionTexts = [caloriesText, proteinText, fatText, carbText].map((v) => v.trim())
    let nutrition: Nutrition | undefined
    if (nutritionTexts.some((v) => v !== '')) {
      const nums = nutritionTexts.map((v) => (v === '' ? NaN : Number(v)))
      if (nums.some((n) => !Number.isFinite(n) || n < 0)) {
        alert('营养四项需填写完整，且均为不小于 0 的数值')
        return null
      }
      // estimated 恒为 true（AI 估算口径，非实测），类型层面即字面量 true
      nutrition = {
        caloriesKcal: nums[0],
        proteinG: nums[1],
        fatG: nums[2],
        carbG: nums[3],
        estimated: true,
      }
    }

    const draft: DraftRecipe = {
      name: trimName,
      servings: servingsNum,
      difficulty: trimDifficulty,
      totalTimeMin: totalMinNum,
      tags,
      ingredients: cleanedIngredients,
      steps: cleanedSteps,
      // 编辑场景沿用原 source；新录入手动场景为 'manual'
      source: initial?.source ?? 'manual',
    }
    if (category) draft.category = category
    if (nutrition) draft.nutrition = nutrition
    return draft
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (submitting) return
    const draft = buildDraft()
    if (!draft) return
    setSubmitting(true)
    try {
      const res = await onSubmit(draft)
      if (!res.ok) {
        // 契约：400 { error: 中文 }；优先展示服务端错误文案，解析失败回退通用文案
        let msg = '保存失败，请稍后重试'
        try {
          const data = (await res.json()) as { error?: string }
          if (typeof data?.error === 'string' && data.error !== '') msg = data.error
        } catch {
          // 保留默认文案
        }
        alert(msg)
      }
      // 成功时的跳转由 page 的 onSubmit 内完成（router.push 详情页），表单不感知路由
    } catch {
      alert('保存失败，网络异常，请稍后重试')
    } finally {
      setSubmitting(false)
    }
  }

  // AI 估算营养（裁定 3）：调 POST /api/ai/recipes，取 recipe.nutrition 回填四项
  async function handleEstimate() {
    if (aiDisabled) return    setEstimating(true)
    try {
      const res = await apiFetch('/api/ai/recipes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dish: name.trim(), ingredients: ingredientNames }),
      })
      if (res.status === 503) {
        // 契约：503 = AI 未配置，文案单独区分
        alert('AI 未配置，无法估算营养')
        return
      }
      if (!res.ok) {
        // 其他失败（400/500 等）：优先透出服务端中文 error
        let msg = '营养估算失败，请稍后重试'
        try {
          const data = (await res.json()) as { error?: string }
          if (typeof data?.error === 'string' && data.error !== '') msg = data.error
        } catch {
          // 保留默认文案
        }
        alert(msg)
        return
      }
      const data = (await res.json()) as AiEstimateResponse
      const n = data.recipe?.nutrition
      if (!n) {
        alert('AI 未返回营养数据')
        return
      }
      setCaloriesText(String(n.caloriesKcal))
      setProteinText(String(n.proteinG))
      setFatText(String(n.fatG))
      setCarbText(String(n.carbG))
    } catch {
      // 网络异常等 fetch 抛错场景
      alert('营养估算失败，请稍后重试')
    } finally {
      setEstimating(false)
    }
  }

  // AI 整份生成（按名称）：调 POST /api/ai/recipes { dish: 名称 }，成功后把整份菜谱回填表单各字段。
  // 只回填不保存：source 保持 'manual'（用户核对修改后手动保存，保存动作仍走表单提交），
  // 营养/分类由 AI 结果带入但用户可随意改；名称为唯一必要输入。
  async function handleGenerate() {
    const trimName = name.trim()
    if (trimName === '' || generating || submitting || estimating) return
    setGenerating(true)
    try {
      const res = await apiFetch('/api/ai/recipes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dish: trimName }),
      })
      if (res.status === 503) {
        alert('AI 未配置，无法生成菜谱')
        return
      }
      if (!res.ok) {
        // 400/502 等：优先透出服务端中文 error（502 文案自带解析失败详情）
        let msg = 'AI 生成失败，请稍后重试'
        try {
          const data = (await res.json()) as { error?: string }
          if (typeof data?.error === 'string' && data.error !== '') msg = data.error
        } catch {
          // 保留默认文案
        }
        alert(msg)
        return
      }
      const data = (await res.json()) as AiEstimateResponse
      const r = data.recipe
      if (!r) {
        alert('AI 未返回菜谱数据')
        return
      }
      // 整份回填（不含 id/时间戳/source——那是服务端入库语义，与本表单无关）：
      // 标签用中文逗号连接以匹配 tagsText 的回显格式；营养四项转字符串回填
      setName(r.name)
      setCategory(r.category)
      setServings(String(r.servings))
      setDifficulty(r.difficulty)
      setTotalTimeMin(String(r.totalTimeMin))
      setTagsText(r.tags.join('，'))
      setIngredients(
        r.ingredients.length > 0
          ? r.ingredients.map((i) => ({ name: i.name, amount: i.amount }))
          : [{ name: '', amount: '' }],
      )
      setSteps(r.steps.length > 0 ? [...r.steps] : [''])
      if (r.nutrition) {
        setCaloriesText(String(r.nutrition.caloriesKcal))
        setProteinText(String(r.nutrition.proteinG))
        setFatText(String(r.nutrition.fatG))
        setCarbText(String(r.nutrition.carbG))
      } else {
        setCaloriesText('')
        setProteinText('')
        setFatText('')
        setCarbText('')
      }
      // 回填后置顶提示核对：不自动保存（需求明确要求用户核对后手动保存）
      alert('已按名称生成菜谱并填入各字段，请核对修改后再保存')
    } catch {
      alert('AI 生成失败，网络异常，请稍后重试')
    } finally {
      setGenerating(false)
    }
  }

  // 行操作：新增即在尾部补一空白行；删除即按索引过滤（食材至少保留一行）
  function addIngredient() {
    setIngredients((prev) => [...prev, { name: '', amount: '' }])
  }
  function removeIngredient(idx: number) {
    setIngredients((prev) => (prev.length <= 1 ? prev : prev.filter((_, i) => i !== idx)))
  }
  function updateIngredient(idx: number, patch: Partial<IngredientRow>) {
    setIngredients((prev) => prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)))
  }
  function addStep() {
    setSteps((prev) => [...prev, ''])
  }
  function removeStep(idx: number) {
    setSteps((prev) => prev.filter((_, i) => i !== idx))
  }
  function updateStep(idx: number, value: string) {
    setSteps((prev) => prev.map((s, i) => (i === idx ? value : s)))
  }

  // 移动端三约束：所有输入 text-base（16px，防 iOS 聚焦缩放）；触摸目标 min-h-[44px]；
  // 弹性行一律 min-w-0 + truncate/收缩，保证无横向滚动；
  // 暗色适配：边框/文字/焦点色均带 dark: 变体，跟随系统深色模式
  const inputClass =
    'min-h-[44px] w-full min-w-0 rounded-lg border border-neutral-300 bg-transparent px-3 text-base text-neutral-900 outline-none placeholder:text-neutral-400 focus:border-neutral-900 dark:border-neutral-700 dark:text-neutral-100 dark:focus:border-neutral-100'

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-5">
      {/* 基本信息：名称 + AI 生成整份菜谱（只填名称即可用；生成后仅回填表单，不自动保存） */}
      <section>
        <div className="mb-1 flex items-center justify-between gap-2">
          <span className="block text-sm text-neutral-600 dark:text-neutral-400">
            名称 <span className="text-red-500 dark:text-red-400">*</span>
          </span>
          <button
            type="button"
            onClick={handleGenerate}
            disabled={generating || submitting || estimating || name.trim() === ''}
            aria-label="AI 生成菜谱"
            className="shrink-0 rounded-lg border border-neutral-900 px-3 py-1.5 text-sm font-medium text-neutral-900 transition-colors active:bg-neutral-100 disabled:border-neutral-300 disabled:text-neutral-400 dark:border-neutral-100 dark:text-neutral-100 dark:active:bg-neutral-800 dark:disabled:border-neutral-700 dark:disabled:text-neutral-500"
          >
            {generating ? '生成中…' : 'AI 生成'}
          </button>
        </div>
        <input
          type="text"
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="例如：番茄炒蛋（或填名称后点「AI 生成」）"
          aria-label="菜谱名称"
          className={inputClass}
        />
      </section>

      <div className="grid grid-cols-2 gap-2">
        <label className="block">
          <span className="mb-1 block text-sm text-neutral-600 dark:text-neutral-400">分类（可选）</span>
          <select
            value={category ?? ''}
            onChange={(e) => setCategory(e.target.value as Recipe['category'])}
            aria-label="分类"
            className={inputClass}
          >
            <option value="">不设置</option>
            {CATEGORY_OPTIONS.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-sm text-neutral-600 dark:text-neutral-400">
            份量 <span className="text-red-500 dark:text-red-400">*</span>
          </span>
          <input
            type="number"
            required
            min={1}
            step={1}
            inputMode="numeric"
            value={servings}
            onChange={(e) => setServings(e.target.value)}
            aria-label="份量"
            className={inputClass}
          />
        </label>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <label className="block">
          <span className="mb-1 block text-sm text-neutral-600 dark:text-neutral-400">
            难度 <span className="text-red-500 dark:text-red-400">*</span>
          </span>
          <input
            type="text"
            required
            value={difficulty}
            onChange={(e) => setDifficulty(e.target.value)}
            placeholder="例如：简单"
            aria-label="难度"
            className={inputClass}
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-sm text-neutral-600 dark:text-neutral-400">
            总时长（分钟）<span className="text-red-500 dark:text-red-400">*</span>
          </span>
          <input
            type="number"
            required
            min={1}
            step={1}
            inputMode="numeric"
            value={totalTimeMin}
            onChange={(e) => setTotalTimeMin(e.target.value)}
            aria-label="总时长（分钟）"
            className={inputClass}
          />
        </label>
      </div>

      <label className="block">
        <span className="mb-1 block text-sm text-neutral-600 dark:text-neutral-400">标签（逗号分隔）</span>
        <input
          type="text"
          value={tagsText}
          onChange={(e) => setTagsText(e.target.value)}
          placeholder="例如：家常菜，快手"
          aria-label="标签"
          className={inputClass}
        />
      </label>

      {/* 食材行：名称 + 用量，可增删行 */}
      <section>
        <span className="mb-1 block text-sm text-neutral-600 dark:text-neutral-400">
          食材 <span className="text-red-500 dark:text-red-400">*</span>
        </span>
        <div className="flex flex-col gap-2">
          {ingredients.map((row, idx) => (
            <div key={idx} className="flex items-center gap-2">
              <input
                type="text"
                value={row.name}
                onChange={(e) => updateIngredient(idx, { name: e.target.value })}
                placeholder={`食材 ${idx + 1} 名称`}
                aria-label={`食材 ${idx + 1} 名称`}
                className={`${inputClass} flex-[2]`}
              />
              <input
                type="text"
                value={row.amount}
                onChange={(e) => updateIngredient(idx, { amount: e.target.value })}
                placeholder="用量"
                aria-label={`食材 ${idx + 1} 用量`}
                className={`${inputClass} flex-1`}
              />
              <button
                type="button"
                onClick={() => removeIngredient(idx)}
                disabled={ingredients.length <= 1}
                aria-label={`删除食材 ${idx + 1}`}
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-neutral-300 text-lg text-neutral-500 transition-colors active:bg-neutral-100 disabled:opacity-40 dark:border-neutral-700 dark:text-neutral-400 dark:active:bg-neutral-800"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
        <button
          type="button"
          onClick={addIngredient}
          className="mt-2 min-h-[44px] w-full rounded-lg border border-dashed border-neutral-300 text-sm text-neutral-600 transition-colors active:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-400 dark:active:bg-neutral-800"
        >
          ＋ 添加食材
        </button>
      </section>

      {/* 步骤行：可增删行 */}
      <section>
        <span className="mb-1 block text-sm text-neutral-600 dark:text-neutral-400">
          步骤 <span className="text-red-500 dark:text-red-400">*</span>
        </span>
        <div className="flex flex-col gap-2">
          {steps.map((step, idx) => (
            <div key={idx} className="flex items-stretch gap-2">
              <StepTextarea
                value={step}
                idx={idx}
                onChange={(v) => updateStep(idx, v)}
              />
              <button
                type="button"
                onClick={() => removeStep(idx)}
                aria-label={`删除步骤 ${idx + 1}`}
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-neutral-300 text-lg text-neutral-500 transition-colors active:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-400 dark:active:bg-neutral-800"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
        <button
          type="button"
          onClick={addStep}
          className="mt-2 min-h-[44px] w-full rounded-lg border border-dashed border-neutral-300 text-sm text-neutral-600 transition-colors active:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-400 dark:active:bg-neutral-800"
        >
          ＋ 添加步骤
        </button>
      </section>

      {/* 营养四项（选填）：整体填写/整体置空；AI 估算按钮按名称+食材可用性启用 */}
      <section>
        <div className="mb-1 flex items-center justify-between gap-2">
          <span className="text-sm text-neutral-600 dark:text-neutral-400">营养（选填，AI 估算口径）</span>
          <button
            type="button"
            onClick={handleEstimate}
            disabled={aiDisabled}
            aria-label="AI 估算营养"
            className="min-h-[44px] shrink-0 rounded-lg border border-neutral-900 px-3 text-sm font-medium text-neutral-900 transition-colors active:bg-neutral-100 disabled:border-neutral-300 disabled:text-neutral-400 dark:border-neutral-100 dark:text-neutral-100 dark:active:bg-neutral-800 dark:disabled:border-neutral-700 dark:disabled:text-neutral-500"
          >
            {estimating ? '估算中…' : 'AI 估算营养'}
          </button>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className="mb-1 block text-sm text-neutral-600 dark:text-neutral-400">热量（千卡）</span>
            <input
              type="number"
              min={0}
              step="any"
              inputMode="decimal"
              value={caloriesText}
              onChange={(e) => setCaloriesText(e.target.value)}
              aria-label="热量（千卡）"
              className={inputClass}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm text-neutral-600 dark:text-neutral-400">蛋白质（克）</span>
            <input
              type="number"
              min={0}
              step="any"
              inputMode="decimal"
              value={proteinText}
              onChange={(e) => setProteinText(e.target.value)}
              aria-label="蛋白质（克）"
              className={inputClass}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm text-neutral-600 dark:text-neutral-400">脂肪（克）</span>
            <input
              type="number"
              min={0}
              step="any"
              inputMode="decimal"
              value={fatText}
              onChange={(e) => setFatText(e.target.value)}
              aria-label="脂肪（克）"
              className={inputClass}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm text-neutral-600 dark:text-neutral-400">碳水（克）</span>
            <input
              type="number"
              min={0}
              step="any"
              inputMode="decimal"
              value={carbText}
              onChange={(e) => setCarbText(e.target.value)}
              aria-label="碳水（克）"
              className={inputClass}
            />
          </label>
        </div>
      </section>

      {/* 提交：全宽大按钮，触摸目标远超 44px */}
      <button
        type="submit"
        disabled={submitting}
        className="min-h-[44px] w-full rounded-lg bg-neutral-900 py-3 text-base font-medium text-white transition-colors active:bg-neutral-700 disabled:opacity-60 dark:bg-neutral-100 dark:text-neutral-900 dark:active:bg-neutral-300"
      >
        {submitting ? '保存中…' : submitLabel}
      </button>
    </form>
  )
}
