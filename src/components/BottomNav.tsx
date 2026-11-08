'use client'

// BottomNav：固定在底部的全局导航，覆盖首页 / 菜谱库 / 点菜 / 设置四个入口
import Link from 'next/link'
import { usePathname } from 'next/navigation'

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
  // 审计 #22：子路径也点亮所属 tab（/recipes/[id] → 菜谱库）；'/' 特殊——只精确匹配置信，
  // 否则全站路径都以 '/' 开头会导致四个 tab 全亮
  const isActive = (href: string) =>
    href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`)

  return (
    <nav className="fixed inset-x-0 bottom-0 z-50 flex h-14 items-stretch border-t border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
      {NAV_ITEMS.map((item) => {
        const active = isActive(item.href)
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
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
    </nav>
  )
}
