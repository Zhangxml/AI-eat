'use client'

// BottomNav：固定在底部的全局导航，覆盖首页 / 菜谱库 / 点菜 / 设置四个入口
import Link from 'next/link'
import { usePathname } from 'next/navigation'

// 导航项数据：顺序即展示顺序，href 需与 App Router 路由一一对应
export const NAV_ITEMS: { href: string; label: string }[] = [
  { href: '/', label: '首页' },
  { href: '/recipes', label: '菜谱库' },
  { href: '/dishes', label: '点菜' },
  { href: '/settings', label: '设置' },
]

// 底部导航默认组件：固定底部，单项触控高度不小于 44px，当前路由项高亮
export default function BottomNav() {
  const pathname = usePathname()

  return (
    <nav className="fixed inset-x-0 bottom-0 z-50 flex h-14 items-stretch border-t border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
      {NAV_ITEMS.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          className={`flex min-h-[44px] flex-1 items-center justify-center text-sm transition-colors ${
            pathname === item.href
              ? 'font-medium text-black dark:text-white'
              : 'text-neutral-500 hover:text-black dark:hover:text-white'
          }`}
        >
          {item.label}
        </Link>
      ))}
    </nav>
  )
}
