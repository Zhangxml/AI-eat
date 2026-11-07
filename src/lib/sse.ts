// SSE 编码纯函数库（Task 11）：只做服务端编码，不含解析；
// 前端解析（readSse）由 Task 12 在浏览器侧自行实现，两端以本协议字符串为唯一契约：
// `event: <name>\ndata: <json>\n\n`
export function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

// SSE 响应标准响应头：禁缓存 + 长连接
export function sseHeaders(): Record<string, string> {
  return {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  }
}
