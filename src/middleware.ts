// 全局中间件（Edge runtime）：在 HTML 返回之前就挡掉未登录的页面访问。
//
// 为什么需要它：页面是客户端组件，`Link` 软导航会先把整页骨架渲染出来，
// 数据请求拿到 401 后才由 apiFetch 用 window.location.href 整页跳转到 /login——
// 用户看到「菜谱库/设置页闪一下再跳到登录页」。在服务端拦截后，页面根本不会渲染。
//
// 判定口径：
// - 无会话 Cookie → 直接重定向 /login（这是绝大多数「未登录」场景）
// - 有 Cookie → 放行；真伪/过期仍由 API 与页面内的守卫校验（这里不验签，避免在 Edge 里依赖 node:crypto）
// - /login 自身永远放行（否则重定向循环）
// - /api/*、静态资源不经过本中间件（见 config.matcher）
//
// 与「旧模式（尚未创建任何用户）」的关系：旧模式下同样没有 Cookie，会被引导到 /login，
// 而 /login 检测到 needsSetup 会显示「初始化管理员」表单；建号时 `/api/auth` 会自动把
// data/recipes 与 data/settings.json 接管到该用户名下（见 src/lib/legacy-migration.ts），
// 所以「创建管理员（将接收现有菜谱库）」这句文案是成立的，不需要再手工跑迁移脚本。
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

// 与 src/lib/session.ts 保持一致（middleware 不能 import 业务模块：那会把 node:crypto / fs 带进 Edge bundle）
const SESSION_COOKIE = 'ai-eat-session'

export function middleware(req: NextRequest): NextResponse {
  const { pathname } = req.nextUrl

  // 登录页放行（含请求 /login 本身）
  if (pathname === '/login') return NextResponse.next()

  const hasSession = req.cookies.get(SESSION_COOKIE)?.value
  if (hasSession) return NextResponse.next()

  // 未登录：重定向到登录页，并带上原路径便于登录后回跳
  const url = req.nextUrl.clone()
  url.pathname = '/login'
  url.search = ''
  if (pathname !== '/') url.searchParams.set('next', pathname)
  // 用 303（See Other）：明确「去那个地址用 GET 取」，避免将来若有非 GET 请求打到页面路由时被原样重放。
  // （NextResponse.redirect 默认是 307，会保留原方法。）
  return NextResponse.redirect(url, 303)
}

export const config = {
  // 只拦页面路由：排除 API（自己会返回 401 JSON）、Next 内部资源、favicon 等静态文件
  // - 排除 api/、_next/（含 dev 的 webpack-hmr）、__nextjs（错误浮层）、以及常见静态后缀
  //   （含 json/webmanifest/sw.js/字体，避免将来加 PWA 清单时被误拦）
  matcher: [
    '/((?!api/|_next/|__nextjs|favicon.ico|.*\\.(?:png|jpe?g|svg|ico|webp|avif|gif|css|js|map|txt|xml|json|webmanifest|woff2?)$).*)',
  ],
}
