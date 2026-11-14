'use client'

// BottomNav：固定在底部的全局导航，覆盖首页 / 菜谱库 / 点菜 / 设置四个入口
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { isHiddenSettingsPage, isNavActive } from '@/lib/nav-active'

// 导航项数据：顺序即展示顺序，href 需与 App Router 路由一一对应
export const NAV_ITEMS: { href: string; label: string }[] = [
  { href: '/', label: '问问AI' },
  { href: '/dishes', label: '买什么' },
  { href: '/recipes', label: '菜谱库' },
  { href: '/settings', label: '设置' },
]

// 底部导航默认组件：固定底部，单项触控高度不小于 44px，当前路由项高亮
export default function BottomNav() {
  const pathname = usePathname()
  // 访问记录（/access-logs）是隐藏页，不属于四个 tab 任意一个：
  // - 它靠「设置」进入，所以把「设置」点亮，告诉用户自己在哪一层
  // - 从该页离开时必须用 replace：push 会把 /access-logs 写进历史栈，
  //   之后不知情的人按「后退」就能直接落到隐藏页，绕过连点手势（曾实测复现）
  // 判定逻辑抽在 src/lib/nav-active.ts（有单测）
  const onHiddenPage = isHiddenSettingsPage(pathname)
  const isActive = (href: string) => isNavActive(pathname, href)

  return (
    /* 外层固定底部、全宽背景与上边框（视觉上是一条通栏分隔线）。
       h-14 必须留在外层：放进内层后 border-t 的 1px 会落在高度之外，
       导航总高变 57px，与 layout 里 pb-14（56px）的预留对不上。
       内层用与页面内容相同的 mx-auto max-w-3xl 约束四等分槽位——
       否则桌面宽屏（如 1440px）会出现 768px 居中内容 + 1425px 通栏导航，
       四个 tab 被拉到每格 356px，与内容脱节。
       不加 px-4：max-w-3xl(768) 已大于手机视口，手机端渲染与改动前一致。 */
    <nav
      aria-label="底部导航"
      className="fixed inset-x-0 bottom-0 z-50 h-14 border-t border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900"
    >
      <div className="mx-auto flex h-full max-w-3xl items-stretch">
        {NAV_ITEMS.map((item) => {
          const active = isActive(item.href)
          return (
            <Link
              key={item.href}
              href={item.href}
              // 不做预取：next.config.ts 里 staleTimes 已设为 0（预取结果永不复用），
              // 预取只会白花请求。更重要的是避免「禁用前预取的页面」被画出来——
              // 见 docs/design/multi-user/README.md「页面守卫」。
              prefetch={false}
              // 从隐藏页离开用 replace：不把它留在历史栈里（否则后退可绕过手势直达）
              replace={onHiddenPage}
              // 隐藏页上「设置」只是所在层级、并非当前页：用 "true"（集合内的当前项）而非
              // "page"，否则读屏会播报「设置 当前页」而实际停在「访问记录」
              aria-current={active ? (onHiddenPage ? 'true' : 'page') : undefined}
              className={`flex min-h-[44px] flex-1 items-center justify-center text-sm transition-colors ${
                // 选中态：颜色加深 + 字重 500→600 双重强调（仅加粗不改变 flex-1 等分槽位，
                // 文字居中展开，不会造成导航项位移）
                active
                  ? 'font-semibold text-black dark:text-white'
                  : 'text-neutral-500 hover:text-black dark:hover:text-white'
              }`}
            >
              {item.label}
            </Link>
          )
        })}
      </div>
    </nav>
  )
}
