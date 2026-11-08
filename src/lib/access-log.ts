// 访问日志（方案 A：只记 API 写操作与敏感操作，不记普通读请求）
// 存储形态：data/logs/access.jsonl（JSON Lines，一行一条），与菜谱库同受 data/ 卷持久化保护
// 容量控制：超过上限（MAX_ENTRIES）时滚动丢弃最旧条目，文件永不无限增长
// 隐私红线：只记 时间/IP/方法/路径/状态码，不含任何密码、Key、查询参数（搜索词不记录）
import { promises as fs } from 'node:fs'
import path from 'node:path'

// 单条访问记录
export interface AccessLogEntry {
  /** ISO 8601 访问时间 */
  time: string
  /** 客户端 IP（TRUST_PROXY=true 时取 x-forwarded-for 首段；否则取 socket 地址，取不到为 unknown） */
  ip: string
  /** HTTP 方法 */
  method: string
  /** 请求路径（不含查询参数——搜索词等查询串不记录） */
  path: string
  /** 响应状态码 */
  status: number
}

// 日志文件路径：data/logs/access.jsonl（AI_EAT_DATA_DIR 指向 data/recipes，
// 故这里取其父目录下的 logs/——与 recipes 目录同级，同受 data 卷保护）
function accessLogPath(): string {
  const dataDir = process.env.AI_EAT_DATA_DIR
    ? path.dirname(process.env.AI_EAT_DATA_DIR)
    : path.join(process.cwd(), 'data')
  return path.join(dataDir, 'logs', 'access.jsonl')
}

// 容量上限：超过即丢弃最旧条目（保留最近 MAX_ENTRIES 条）。200 条（4 页）足够回溯近期敏感操作
const MAX_ENTRIES = 200

// 从请求中提取客户端 IP（审计修复 #15：不再默认信任 x-forwarded-for——该头可被客户端伪造，
// 直连部署下伪造 IP 会污染审计记录。行为按部署形态二分：
// - 直连（默认，TRUST_PROXY 未设）：读 Node 扩展的 socket 远端地址，取不到返回 'unknown'；XFF 头一律不读
// - 反代（TRUST_PROXY=true）：前置代理可信，取 x-forwarded-for 首段（真实客户端 IP 由代理写入）
export function clientIpOf(req: Request): string {
  if (process.env.TRUST_PROXY === 'true') {
    const fwd = req.headers.get('x-forwarded-for')
    const first = fwd?.split(',')[0]?.trim()
    if (first) return first
  }
  // Node 的 Request 带 socket 扩展（undici 类型未暴露，运行时存在）；App Router 下 Next 可能已把
  // socket IP 注入 XFF，但代码语义上不再主动信任该头（仅 TRUST_PROXY=true 时读取）
  const anyReq = req as Request & { socket?: { remoteAddress?: string } }
  const addr = anyReq.socket?.remoteAddress
  return addr && addr !== '' ? addr : 'unknown'
}

// 追加一条访问记录：写失败静默吞掉——日志是辅助设施，绝不能因日志故障打断主业务响应。
// 正常路径：fs.appendFile（内核 O_APPEND 单次 write 追加，单行原子，无需先读后写整文件）。
// 容量压缩路径（仅当条目数达上限）：读旧文件 → 截取最近条目 → 写 .tmp → rename 原子替换；
// 压缩经模块级 Promise 链串行化，防止并发请求同时触发「读→截断→rename」互相踩踏导致丢条目
let compacting: Promise<void> = Promise.resolve()

export async function appendAccessLog(entry: Omit<AccessLogEntry, 'time'>): Promise<void> {
  const full: AccessLogEntry = { ...entry, time: new Date().toISOString() }
  const line = JSON.stringify(full) + '\n'
  const file = accessLogPath()
  try {
    await fs.mkdir(path.dirname(file), { recursive: true })
    let count = 0
    try {
      const raw = await fs.readFile(file, 'utf8')
      count = raw.split('\n').filter((l) => l.trim() !== '').length
    } catch {
      // 首次写入：文件尚不存在，count 保持 0
    }
    if (count < MAX_ENTRIES) {
      // 未达上限：O_APPEND 单行原子追加（多进程/多请求并发下不会互相覆盖）
      await fs.appendFile(file, line, { encoding: 'utf8' })
      return
    }
    // 达上限：压缩串行队列——链在全局 Promise 上，前一个压缩完成才开始下一个
    const run = compacting.catch(() => {}).then(() => compactFile(file, line))
    compacting = run
    await run
  } catch {
    // 日志写失败不打断主业务（删除/入库等操作已在前完成）
  }
}

// 压缩：读旧文件 → 丢弃最旧条目腾一位 → 写 .tmp → rename 原子替换（无中间态可见）
async function compactFile(file: string, line: string): Promise<void> {
  let existing = ''
  try {
    existing = await fs.readFile(file, 'utf8')
  } catch {
    // 文件被并发删除等极端场景：视作空文件重写
  }
  const lines = existing.split('\n').filter((l) => l.trim() !== '')
  // 超上限：丢弃最旧的（保留 MAX_ENTRIES - 1 条，给新条目腾位）
  const kept = lines.length >= MAX_ENTRIES ? lines.slice(lines.length - (MAX_ENTRIES - 1)) : lines
  const tmp = `${file}.tmp`
  await fs.writeFile(tmp, [...kept, line.trim()].join('\n') + '\n', 'utf8')
  await fs.rename(tmp, file)
}

// 读取全部访问记录：最新在前（文件尾部是最新的，倒序返回）。文件不存在返回空数组
export async function readAccessLogs(): Promise<AccessLogEntry[]> {
  try {
    const raw = await fs.readFile(accessLogPath(), 'utf8')
    const out: AccessLogEntry[] = []
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue
      try {
        const obj = JSON.parse(line) as Partial<AccessLogEntry>
        if (
          typeof obj.time === 'string' &&
          typeof obj.ip === 'string' &&
          typeof obj.method === 'string' &&
          typeof obj.path === 'string' &&
          typeof obj.status === 'number'
        ) {
          out.push({ time: obj.time, ip: obj.ip, method: obj.method, path: obj.path, status: obj.status })
        }
      } catch {
        // 单行坏数据跳过（手改文件容忍语义，与菜谱库一致）
      }
    }
    // 文件按时间正序追加，读取时倒序 = 最新在前
    return out.reverse()
  } catch {
    return []
  }
}
