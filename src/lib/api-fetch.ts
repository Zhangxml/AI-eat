// 前端统一 fetch 封装（完整行为见 Task 16 定义，本文件为按裁定的最小实现）
// 职责：所有前端请求统一走 apiFetch；响应 401（未登录）时跳转登录页，
// 并把该 Response 原样返回给调用方自行处理，不抛异常、不吞响应体
export async function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const res = await fetch(input, init)
  if (res.status === 401) {
    // 未登录：整页跳转登录页。
    // 用 replace 而不是 href——不新增历史项（否则登录后按「后退」又回到受保护页面，再 401 再跳，来回循环）。
    // 带上 next：登录后回到原页面（由登录页的 safeNextPath 校验，防止开放重定向）。
    // 注意：正常路径下 middleware 已在服务端拦掉未登录访问，这里只是兜底（例如 Cookie 过期）。
    const here = window.location.pathname + window.location.search
    window.location.replace(`/login?next=${encodeURIComponent(here)}`)
  }
  return res
}
