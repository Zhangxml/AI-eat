// 前端 SSE 解析（Task 12）：与 src/lib/sse.ts 的服务端编码互为镜像
// 编码契约：`event: <name>\ndata: <json>\n\n`；解析规则（标准 SSE 子集）：
// - 按空行分帧，帧内 `event:` 行定事件类型（缺省 'message'）
// - `data:` 行 JSON.parse 后传 onEvent(event, data)；多行 data 以换行拼接后整体解析
// - 注释行（: 开头）忽略；data 非法 JSON 或帧内无 data 的帧跳过，不中断整条流
// node 可测：仅依赖 Response/ReadableStream 标准接口，不依赖浏览器 EventSource
/* eslint-disable @typescript-eslint/no-explicit-any -- 简报契约签名逐字保留：data: any */
export interface ReadSseOptions {
  /**
   * 空闲超时（毫秒）：超过该时长没收到任何字节则抛错。
   * 必要性：`reader.read()` 在网络切换/上游挂起时既不 resolve 也不 reject，
   * 调用方的 finally 永不到达——ChatView 曾因此把输入区永久置为 disabled（唯一出路是刷新，上下文全丢）。
   * 不传则不设超时（保持原有语义，测试与一次性响应仍可用）。
   */
  idleTimeoutMs?: number
}

export async function readSse(
  res: Response,
  onEvent: (event: string, data: any) => Promise<void> | void,
  options: ReadSseOptions = {},
): Promise<void> {
  if (!res.body) {
    throw new Error('SSE 响应无内容')
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  // 行缓冲：跨 chunk 拼装半行；中文多字节字符由 TextDecoder stream 模式安全切分
  let lineBuf = ''
  // 帧缓冲：当前帧内收集 event 行与 data 行（多行 data 拼接）
  let event = ''
  let dataLines: string[] = []

  const dispatch = async () => {
    if (dataLines.length === 0) return // 帧内无 data（纯注释/空帧）不分发
    let data: any

    try {
      data = JSON.parse(dataLines.join('\n'))
    } catch {
      return // 非法 JSON 的帧跳过，不影响后续帧
    }
    await onEvent(event === '' ? 'message' : event, data)
  }

  // 处理一行完整文本：只认 event:/data: 前缀，其余行忽略；换行符统一后按 SSE 规范剥一个前导空格
  const handleLine = async (raw: string) => {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw // 容忍 CRLF
    if (line === '') {
      await dispatch() // 空行 = 帧边界
      event = ''
      dataLines = []
      return
    }
    if (line.startsWith(':')) return // 注释行（心跳等）忽略
    if (line.startsWith('event:')) {
      event = line.slice(6).trim()
    } else if (line.startsWith('data:')) {
      const v = line.slice(5)
      dataLines.push(v.startsWith(' ') ? v.slice(1) : v) // 规范允许 "data: x" 剥一个空格
    }
    // 其他字段（id:/retry:）本项目协议不使用，忽略
  }

  // 单次读取：可选空闲超时。超时后取消 reader（释放上游连接）并抛错，让调用方 finally 复位 UI
  const readOnce = async (): Promise<ReadableStreamReadResult<Uint8Array>> => {
    const idle = options.idleTimeoutMs
    if (idle === undefined || idle <= 0) return reader.read()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            // 顺序很重要：先 reject 再 cancel。cancel() 会让挂起的 read() 立刻以
            // {done:true} 完成，若先 cancel，Promise.race 会当成「流正常结束」而静默返回
            // （实测：先 cancel 时 50ms 超时后 readSse 正常 resolve，超时形同虚设）。
            reject(new Error(`SSE 接收超时（${idle} 毫秒无数据）`))
            void reader.cancel().catch(() => {})
          }, idle)
        }),
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  try {
    while (true) {
      const { done, value } = await readOnce()
      if (done) break
      lineBuf += decoder.decode(value, { stream: true })
      const lines = lineBuf.split('\n')
      lineBuf = lines.pop() ?? '' // 半行留待下个 chunk
      for (const l of lines) await handleLine(l)
    }
    // 上游结束：冲刷残留半行；若流未以空行收尾，最后一帧仍需分发
    if (lineBuf !== '') await handleLine(lineBuf)
    await dispatch()
  } finally {
    reader.releaseLock()
  }
}
