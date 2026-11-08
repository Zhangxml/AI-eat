// 请求体体积上限（审计 P1）：写路由在 req.json()/parseInput 之前先看 content-length 头，
// 超限直接 413 快速失败，避免把巨大 body 整体读进内存再解析（内存/带宽 DoS 面收敛）。
// 说明：Node 内部调用（单测直调 handler）不带该头 → 放行；真正的结构校验仍由各路由的
// 参数校验（400）兜底，本层只是前置的体积闸门。
export const BODY_LIMIT_BYTES = 1024 * 1024 // 通用写接口上限：1MB
export const BACKUP_BODY_LIMIT_BYTES = 5 * 1024 * 1024 // 备份导入上限：5MB（整库备份合法体积更大）

// 判断请求体是否可继续处理：读 content-length 头（字节）与上限比较；
// 头缺失或值非法（非数字/负数）时放行（返回 true），交由后续解析与参数校验兜底
export function checkBodySize(req: Request, limitBytes: number): boolean {
  const raw = req.headers.get('content-length')
  if (raw === null) return true
  const len = Number(raw)
  if (!Number.isFinite(len) || len < 0) return true
  return len <= limitBytes
}

// 统一 413 响应（中文文案，全站一致）
export function bodyTooLarge(): Response {
  return Response.json({ error: '请求体过大' }, { status: 413 })
}
