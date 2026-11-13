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
// - chip 高度 36px：低于项目 44px 主规格，但筛选 chips 属轻量档；再高会挤压列表可视区
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

  useEffect(() => {
    // 只滚横滑容器本身，不用 scrollIntoView——后者在元素位于视口外时会把整个页面纵向滚过去
    const el = scrollRef.current
    const chip = activeRef.current
    if (!el || !chip) return
    const elRect = el.getBoundingClientRect()
    const chipRect = chip.getBoundingClientRect()
    // 已完整可见则不动，避免每次点选都把容器来回滚
    if (chipRect.left >= elRect.left && chipRect.right <= elRect.right) return
    const delta =
      (chipRect.left + chipRect.width / 2) - (elRect.left + elRect.width / 2)
    el.scrollTo({ left: el.scrollLeft + delta })
    syncFade()
  }, [value, options, syncFade])

  const chipClass = (active: boolean) =>
    `shrink-0 whitespace-nowrap rounded-full border px-3 text-sm transition-colors ${
      active
        ? 'border-neutral-900 bg-neutral-900 text-white dark:border-neutral-100 dark:bg-neutral-100 dark:text-neutral-900'
        : 'border-neutral-300 bg-white text-neutral-600 active:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300 dark:active:bg-neutral-800'
    }`

  // 高度 36px 用 min-h + inline-flex 居中（不用 py-1，避免不同字体行高导致高度漂移）
  const CHIP_BASE = 'inline-flex min-h-[36px] items-center'

  return (
    <div className="flex items-center gap-2" role="group" aria-label={ariaLabel}>
      <span className="shrink-0 text-sm text-neutral-500 dark:text-neutral-400">{label}</span>
      {/* 横滑容器：右侧用 mask 做渐隐（比叠一层渐变块更简单，且深色模式自动跟随） */}
      <div
        ref={scrollRef}
        onScroll={syncFade}
        className="flex min-w-0 flex-1 gap-2 overflow-x-auto overscroll-x-contain pb-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
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
