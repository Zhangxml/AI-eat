'use client'

// 单行横滑筛选条（菜谱库的「分类」「标签」两行共用）。
// 结构：[标题(固定)] [全部][chip][chip]… →（右侧渐隐提示还有内容）
// 设计约束与理由：
// - 标题 shrink-0：横滑时标题不动，否则滑两下就不知道自己在看分类还是标签
// - 第一项固定是「全部」，对应 value === null（该维度不筛选）
// - 单选：点任一项只保留一个高亮；点已选中项无反应（取消请点「全部」，避免误触清掉筛选）
// - 隐藏滚动条：手机端否则会多一条横向灰杠（区别于页面级「无横滚」约定，这是容器内滚动）
// - overscroll-behavior-x: contain：滑到头不带动整页横滑
// - 右侧渐隐遮罩：提示右边还有内容可滑
// - 选中项自动滚入视野：刷新后选中的冷门标签可能在某些位置，看不到就等于不知道选了什么
// - chip 规格 32px 高 + rounded-md：低于项目 44px 主规格，筛选 chips 属轻量档；
//   36px + rounded-full 实测显得又高又圆，与行标题的紧凑感不协调（用户反馈后调整）
// - 桌面不提供左右箭头（按需确认过）：桌面可用 Shift+滚轮 或触控板横滑
import { useCallback, useEffect, useRef, useState } from 'react'

interface FilterRowProps {
  /** 行标题，如「分类」「标签」 */
  label: string
  /** 可选项（不含「全部」，组件内部补） */
  options: readonly string[]
  /** 当前选中值；null = 全部 */
  value: string | null
  /** 选择回调；选「全部」时传 null */
  onChange: (next: string | null) => void
  /** 无障碍分组名，如「按分类筛选」 */
  ariaLabel: string
}

export default function FilterRow({ label, options, value, onChange, ariaLabel }: FilterRowProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  // 选中项变化后确保它可见（含「全部」）
  const activeRef = useRef<HTMLButtonElement>(null)
  // 右侧渐隐只在「确实还有内容可滑」时显示：否则分类行本来就装得下，
  // 却会把最后一个 chip（如「主食」）切掉一角，看起来像没显示全
  const [fadeRight, setFadeRight] = useState(false)

  const syncFade = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const canScroll = el.scrollWidth > el.clientWidth + 1
    const atEnd = el.scrollLeft + el.clientWidth >= el.scrollWidth - 1
    setFadeRight(canScroll && !atEnd)
  }, [])

  // 选项变化（切分类后标签行内容变）/ 容器尺寸变化时重新判断
  useEffect(() => {
    syncFade()
    const el = scrollRef.current
    if (!el) return
    const ro = new ResizeObserver(syncFade)
    ro.observe(el)
    return () => ro.disconnect()
  }, [options, syncFade])

  // 把某个 chip 滚进视野：只滚横滑容器本身，不用 scrollIntoView——
  // 后者在元素位于视口外时会把整个页面纵向滚过去
  const ensureVisible = useCallback((chip: HTMLElement | null) => {
    const el = scrollRef.current
    if (!el || !chip) return
    const elRect = el.getBoundingClientRect()
    const chipRect = chip.getBoundingClientRect()
    // 已完整可见则不动，避免每次点选/聚焦都把容器来回滚
    if (chipRect.left >= elRect.left && chipRect.right <= elRect.right) return
    const delta = (chipRect.left + chipRect.width / 2) - (elRect.left + elRect.width / 2)
    el.scrollTo({ left: el.scrollLeft + delta })
    syncFade()
  }, [syncFade])

  // 选中项变化时滚入视野
  useEffect(() => {
    ensureVisible(activeRef.current)
  }, [value, options, ensureVisible])

  // chips 规格：32px 高 + rounded-md（原 36px + rounded-full 显得又高又圆，与行标题的紧凑感不协调）
  // 焦点环必须显式声明：UA 默认 outline 取 currentColor 且贴内边缘，选中态文字与底色互为反色，
  // 环会被「同色吃掉」（实测对比度仅 1.06:1，等于看不见）。
  // px-3 而非 px-2.5：390px 下分类行内容 288px 仍 < 容器 307px（能一行装下 5 个），
  // 退 19px 换取更宽的命中区，更接近触摸友好。
  // 过渡属性显式列出、不用 `transition-colors`：后者包含 outline-color，
  // 会让焦点环从 currentColor（选中态=白/黑反色）渐变到目标色，聚焦瞬间"看不见环"。
  const chipClass = (active: boolean) =>
    `shrink-0 whitespace-nowrap rounded-md border px-3 text-sm ` +
    `transition-[background-color,border-color,color] ` +
    `focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-900 ` +
    `dark:focus-visible:outline-neutral-100 ${
      active
        ? 'border-neutral-900 bg-neutral-900 text-white dark:border-neutral-100 dark:bg-neutral-100 dark:text-neutral-900'
        : 'border-neutral-300 bg-white text-neutral-600 active:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300 dark:active:bg-neutral-800'
    }`

  // 高度用 min-h + inline-flex 居中（不用 py-1，避免不同字体行高导致高度漂移）
  const CHIP_BASE = 'inline-flex min-h-[32px] items-center'

  return (
    <div className="flex items-center gap-2" role="group" aria-label={ariaLabel}>
      {/* 行标题：加粗 + 深色，作为「这是哪一维度」的视觉锚点（此前是浅灰常规字重，容易和 chips 混在一起） */}
      <span className="shrink-0 text-sm font-semibold text-neutral-900 dark:text-neutral-100">
        {label}
      </span>
      {/* 横滑容器：右侧用 mask 做渐隐（比叠一层渐变块更简单，且深色模式自动跟随） */}
      <div
        ref={scrollRef}
        onScroll={syncFade}
        // p-1 -m-1：焦点环需要 chip 外侧 4px（offset 2 + 宽 2）空间，而 overflow-x-auto 会把
        // overflow-y 也算成 auto，导致上下（以及首项的左侧）环被裁掉。加 4px 内边距留出空间，
        // 再用等量负外边距抵消，视觉位置与行高不变。
        className="flex min-w-0 flex-1 gap-2 overflow-x-auto overscroll-x-contain p-1 -m-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        style={
          fadeRight
            ? {
                maskImage: 'linear-gradient(to right, black calc(100% - 24px), transparent)',
                WebkitMaskImage: 'linear-gradient(to right, black calc(100% - 24px), transparent)',
              }
            : undefined
        }
      >
        <button
          type="button"
          ref={value === null ? activeRef : undefined}
          // 点已选中项无反应（与下方选项 chip 一致）：分类已是「全部」时，再点它不应惊动任何东西——
          // 尤其不能连带清掉另一维度（标签）已选的筛选
          onClick={() => {
            if (value !== null) onChange(null)
          }}
          // Tab 聚焦也要滚入视野：落在渐隐区的 chip 焦点环会被 mask 削掉一半
          onFocus={(e) => ensureVisible(e.currentTarget)}
          aria-pressed={value === null}
          className={`${CHIP_BASE} ${chipClass(value === null)}`}
        >
          全部
        </button>
        {options.map((opt) => {
          const active = value === opt
          return (
            <button
              key={opt}
              type="button"
              ref={active ? activeRef : undefined}
              // 点已选中项无反应（单选语义）：取消筛选请点「全部」
              onClick={() => {
                if (!active) onChange(opt)
              }}
              onFocus={(e) => ensureVisible(e.currentTarget)}
              aria-pressed={active}
              className={`${CHIP_BASE} ${chipClass(active)}`}
            >
              {opt}
            </button>
          )
        })}
      </div>
    </div>
  )
}
