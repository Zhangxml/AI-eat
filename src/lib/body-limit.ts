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

export type JsonBodyResult =
  | { ok: true; value: unknown }
  | { ok: false; response: Response }

/**
 * 读取并解析 JSON 请求体，带**真实**体积上限。
 *
 * 为什么不能只看 content-length（checkBodySize）：
 * `Transfer-Encoding: chunked` 没有该头，或客户端可以少报。实测同一份 1.1MB 的合法请求，
 * 带 Content-Length 会被 413 拦下，改成 chunked 就直接入库 —— 上限形同虚设。
 * 这里改为流式累计字节，超限立即 cancel，不把整个 body 读进内存。
 */
export async function readJsonBody(req: Request, limitBytes: number): Promise<JsonBodyResult> {
  // 快速失败：有 content-length 且明显超限时不必开始读
  const raw = req.headers.get('content-length')
  if (raw !== null) {
    const len = Number(raw)
    if (Number.isFinite(len) && len > limitBytes) {
      return { ok: false, response: bodyTooLarge() }
    }
  }
  if (req.body === null) {
    return { ok: false, response: Response.json({ error: '请求体不能为空' }, { status: 400 }) }
  }

  const reader = req.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value === undefined) continue
      total += value.byteLength
      if (total > limitBytes) {
        await reader.cancel().catch(() => {})
        return { ok: false, response: bodyTooLarge() }
      }
      chunks.push(value)
    }
  } catch {
    return { ok: false, response: Response.json({ error: '请求体读取失败' }, { status: 400 }) }
  }

  const buf = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    buf.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return { ok: true, value: JSON.parse(new TextDecoder().decode(buf)) }
  } catch {
    return { ok: false, response: Response.json({ error: '请求体不是合法 JSON' }, { status: 400 }) }
  }
}
