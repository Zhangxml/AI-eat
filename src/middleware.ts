// 全局中间件：在 HTML 下发之前就挡掉「未登录 / 会话已失效」的页面访问。
//
// 为什么跑在 Node runtime（而不是 Edge）：
// 判定「这个会话现在还有效吗」必须读 data/users.json（用户是否被禁用/删除、sessionVersion 是否已变），
// 而 Edge runtime 没有文件系统。之前用 Edge + 回调自身 HTTP 接口兜底，代价是：
// 多一次回环请求、依赖 req.nextUrl.origin（反代下发 X-Forwarded-Proto: https 时会失败并静默放行）。
// Next 15.5 起 Node runtime middleware 已稳定，这里直接用 Node：与各 API 路由**共用同一个
// requireSession**，判定不可能分叉，也没有回环调用。
//
// 判定口径（与 API 层完全一致，不重复实现）：
// - 未登录（无 Cookie / 签名不对 / 已过期）→ 303 到 /login?next=<原路径>
// - 用户被禁用 / 已删除 / 改密后 sessionVersion 不符 → 同样 303（旧 token 签名仍合法，但人已无权）
// - 用户表损坏或为空（503）→ **放行**，让页面把「请从备份恢复」的错误显示出来；跳到登录页只会更困惑
// - 免密单用户（env.PASSWORD 空）→ requireSession 自动建/取管理员并放行，登录页直接跳首页
// - 密码模式 + 未初始化 → 401 → 303 到 /login 引导建号
//
// 为什么不能只在客户端跳转：页面是客户端组件，`Link` 软导航会先把整页骨架渲染出来，
// 数据请求拿到 401 后才整页跳走——实测会闪完整骨架。
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { requireSession } from '@/lib/auth'
import { isPasswordlessMode } from '@/lib/auth-mode'

function redirectToLogin(req: NextRequest): NextResponse {
  const url = req.nextUrl.clone()
  url.pathname = '/login'
  url.search = ''
  // 保留原路径与查询串，登录后可回跳（登录页用 safeNextPath 校验，防开放重定向）
  const here = req.nextUrl.pathname + req.nextUrl.search
  if (here !== '/') url.searchParams.set('next', here)
  // 303 See Other：明确「用 GET 去那个地址」，避免将来非 GET 请求打到页面路由时被原样重放
  return NextResponse.redirect(url, 303)
}

export async function middleware(req: NextRequest): Promise<NextResponse> {
  // 登录页：
  // - 免密模式不需要登录 → 服务端直接 303 回首页（不先渲染表单，避免闪一下）
  // - 密码模式放行（否则未登录 → /login → 又被拦 → 重定向循环）
  if (req.nextUrl.pathname === '/login') {
    if (isPasswordlessMode()) {
      return NextResponse.redirect(new URL('/', req.nextUrl.origin), 303)
    }
    return NextResponse.next()
  }

  const auth = await requireSession(req)
  if (auth.ok) return NextResponse.next()

  // 未登录 / 已禁用 / 已删除 / 版本不符 → 回登录页
  // 用户表损坏（503）等其他原因 → 放行，页面内的请求会把明确错误展示出来（不把用户困在登录页）
  return auth.reason === 'unauthenticated' ? redirectToLogin(req) : NextResponse.next()
}

export const config = {
  // Node runtime：需要读 users.json（Edge 没有文件系统）。必须写成字面量对象，
  // 加 `as const` 会让 Next 的静态解析取不到 runtime，退回 Edge 并在构建时报 node:fs 无法打包。
  runtime: 'nodejs',
  // 只拦页面路由：排除 API（自己会返回 401 JSON）、Next 内部资源、favicon 等静态文件
  matcher: [
    '/((?!api/|_next/|__nextjs|favicon.ico|.*\\.(?:png|jpe?g|svg|ico|webp|avif|gif|css|js|map|txt|xml|json|webmanifest|woff2?)$).*)',
  ],
}
