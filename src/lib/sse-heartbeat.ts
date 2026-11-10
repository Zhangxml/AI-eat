// SSE 心跳：定时发送 SSE 注释帧（`: ping\n\n`），让客户端知道连接还活着。
// 为什么需要：聊天接口在「结构化输出解析失败 → 非流式重试」期间不向客户端发任何字节，
// 该重试最多 120 秒；加上流式首 token 的 120 秒上限，最坏无帧时长可达 240 秒。
// 客户端只能靠「多久没收到字节」判断断流，阈值只要小于 240 秒就会误杀合法请求——
// 实测出现过「服务端 200 且已产出菜谱，客户端已放弃」，而聊天记录不持久化 → 用户永久丢失。
// 注释行是 SSE 规范的一部分：EventSource 忽略，本项目的 readSse 也会跳过 `:` 开头的行。
// 因此心跳对协议零影响，只重置客户端计时器。
// 约束：客户端空闲阈值必须显著大于本间隔（当前 ChatView 用 60 秒 = 6 个周期）。
// 若将来调大此值，务必同步检查 SSE_IDLE_TIMEOUT_MS，否则客户端会静默开始误杀合法请求。
export const SSE_HEARTBEAT_MS = 10_000

/**
 * 启动心跳，返回停止函数（幂等）。
 * emit 抛错（流已被客户端关闭）时静默忽略，绝不让定时器异常冒泡到进程。
 */
export function startSseHeartbeat(
  emit: (chunk: string) => void,
  intervalMs: number = SSE_HEARTBEAT_MS,
): () => void {
  const timer = setInterval(() => {
    try {
      emit(': ping\n\n')
    } catch {
      // 流已关闭/已取消：忽略。下次 stop() 会清掉定时器
    }
  }, intervalMs)
  // 心跳本身不应阻止进程退出
  if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
    ;(timer as { unref: () => void }).unref()
  }

  let stopped = false
  return () => {
    if (stopped) return
    stopped = true
    clearInterval(timer)
  }
}
