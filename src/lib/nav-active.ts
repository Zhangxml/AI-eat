// 底部导航的高亮判定（纯函数，便于单测）。
// 规则与理由：
// - 普通路由精确匹配 + 子路径前缀匹配（/recipes/[id] 应点亮「菜谱库」）
// - 前缀匹配用 `startsWith(href + '/')` 而**不是** `startsWith(href)`：
//   后者会让 '/recipes-archive' 误点亮「菜谱库」。也正是这个带斜杠的写法，
//   让 href='/' 时变成 startsWith('//')，天然不会让四个 tab 全亮
//   （'/' 那个显式三元是额外防御，行为上与省略它一致——无测试可区分，保留只是让意图明确）
// - 隐藏页 /access-logs 归属「设置」层级：它靠设置页的手势进入，
//   且该页不属于四个 tab 任意一个，若不指定就会四个全灭，用户会疑惑「我在哪」
//   耦合说明：这里硬编码 '/settings'；若将来把 /access-logs 加进 NAV_ITEMS，需同步改这里
export const HIDDEN_SETTINGS_PAGES = ['/access-logs'] as const

export function isNavActive(pathname: string, href: string): boolean {
  if ((HIDDEN_SETTINGS_PAGES as readonly string[]).includes(pathname)) {
    return href === '/settings'
  }
  return href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`)
}

/** 当前是否处于「借道设置」的隐藏页（决定 tab 链接是否用 replace 离开、aria-current 是否降级为 true） */
export function isHiddenSettingsPage(pathname: string): boolean {
  return (HIDDEN_SETTINGS_PAGES as readonly string[]).includes(pathname)
}
