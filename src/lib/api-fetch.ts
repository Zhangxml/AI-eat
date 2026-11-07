// 前端统一 fetch 封装（完整行为见 Task 16 定义，本文件为按裁定的最小实现）
// 职责：所有前端请求统一走 apiFetch；响应 401（未登录）时跳转登录页，
// 并把该 Response 原样返回给调用方自行处理，不抛异常、不吞响应体
export async function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const res = await fetch(input, init)
  if (res.status === 401) {
    // 未登录：整页跳转登录页（登录页由后续任务提供，当前阶段此分支不会被触发）
    window.location.href = '/login'
  }
  return res
}
