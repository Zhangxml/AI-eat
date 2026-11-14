// 全局中间件（Edge runtime）：在 HTML 返回之前就挡掉未登录的页面访问。
//
// 为什么需要它：页面是客户端组件，`Link` 软导航会先把整页骨架渲染出来，
// 数据请求拿到 401 后才由 apiFetch 整页跳转到 /login——用户看到「菜谱库/设置页闪一下再跳登录页」。
//
// 两级判定（缺一不可）：
// 1. 没有会话 Cookie → 直接 303 到 /login
// 2. 有 Cookie → **验签 + 验过期**（edge-session.ts，Web Crypto）。
//    只查「Cookie 存在」是不够的：Cookie 按 domain 匹配、**不区分端口**，
//    所以另一个实例（如临时测试端口）留下的 Cookie 会被带来，导致骨架先渲染再被 401 踢走。
//
// 边界：验签只覆盖「签名/过期」。用户是否被禁用、sessionVersion 是否匹配需要读 users.json，
// Edge 没有文件系统——这部分仍由 API 层守卫负责，因此「改密/禁用后的旧会话」仍会有一次骨架闪现。
//
// 密钥来源：env.SESSION_SECRET（run.sh 启动时从 data/.session-secret 注入）。
// 若未注入（例如直接 `next start` 或 Docker 未配），退化为只查存在性并打印明确警告，
// 保证不因缺密钥把所有人锁在门外。
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
// SESSION_COOKIE 与验签都来自 edge-session（无 node 依赖，可进 Edge bundle）；
// 不能在 middleware 里本地再定义一份，否则改名只改一处会导致全员登不进去
import { SESSION_COOKIE, verifySessionEdge } from '@/lib/edge-session'

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
  const { pathname } = req.nextUrl

  // 登录页放行（否则重定向循环）
  if (pathname === '/login') return NextResponse.next()

  const token = req.cookies.get(SESSION_COOKIE)?.value
  if (!token) return redirectToLogin(req)

  const secret = process.env.SESSION_SECRET ?? ''
  if (secret === '') {
    // 未注入密钥：无法验签。放行（退化为旧行为），避免把已登录用户全部锁在门外。
    // 但必须留下明确警告——否则部署时漏配会让防护静默失效（无效/跨实例 Cookie 又会闪骨架）。
    console.warn(
      '[middleware] 未设置 SESSION_SECRET，无法验证会话签名，已退化为「只查 Cookie 存在性」。' +
        '请通过 run.sh 启动（会自动注入 data/.session-secret），或直接设置 SESSION_SECRET。',
    )
    return NextResponse.next()
  }

  // 只关心「验签是否通过」：uid 等载荷不参与页面层判定（数据仍由 API 按 uid 取）
  if ((await verifySessionEdge(token, secret)) === null) return redirectToLogin(req)

  return NextResponse.next()
}

export const config = {
  // 只拦页面路由：排除 API（自己会返回 401 JSON）、Next 内部资源、favicon 等静态文件
  matcher: [
    '/((?!api/|_next/|__nextjs|favicon.ico|.*\\.(?:png|jpe?g|svg|ico|webp|avif|gif|css|js|map|txt|xml|json|webmanifest|woff2?)$).*)',
  ],
}
