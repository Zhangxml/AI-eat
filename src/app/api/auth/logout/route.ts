// POST /api/auth/logout：清会话 Cookie。
// 独立成路由（而不是在 /api/auth 里按 pathname 分支），因为 App Router 的路由文件只匹配自身路径。
import { SESSION_COOKIE } from '@/lib/session'

export async function POST(): Promise<Response> {
  return new Response(null, {
    status: 204,
    headers: {
      'Set-Cookie': `${SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`,
    },
  })
}
