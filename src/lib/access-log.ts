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
  /** 客户端 IP（反代场景取 x-forwarded-for 首段；直连取 socket 地址） */
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

// 容量上限：超过即丢弃最旧条目（保留最近 MAX_ENTRIES 条）。自用写操作频率低，1000 条足够回溯
const MAX_ENTRIES = 1000

// 从请求中提取客户端 IP：优先 x-forwarded-for 首段（反代场景，借鉴 LibreTV 惯例），
// 回退到 Node 扩展的 socket 远端地址（直连场景）。取不到返回 'unknown'
export function clientIpOf(req: Request): string {
  const fwd = req.headers.get('x-forwarded-for')
  if (fwd) {
    const first = fwd.split(',')[0]?.trim()
    if (first !== '') return first
  }
  // Node 的 Request 带 socket 扩展（undici 类型未暴露，运行时存在）
  const anyReq = req as Request & { socket?: { remoteAddress?: string } }
  const addr = anyReq.socket?.remoteAddress
  return addr && addr !== '' ? addr : 'unknown'
}

// 追加一条访问记录：写失败静默吞掉——日志是辅助设施，绝不能因日志故障打断主业务响应。
// 超容量时读旧文件 → 截取最近 MAX_ENTRIES-1 条 → 与新条目一起重写（低频写操作下开销可忽略）
export async function appendAccessLog(entry: Omit<AccessLogEntry, 'time'>): Promise<void> {
  const full: AccessLogEntry = { ...entry, time: new Date().toISOString() }
  const line = JSON.stringify(full) + '\n'
  const file = accessLogPath()
  try {
    await fs.mkdir(path.dirname(file), { recursive: true })
    let existing = ''
    try {
      existing = await fs.readFile(file, 'utf8')
    } catch {
      // 首次写入：文件尚不存在
    }
    const lines = existing.split('\n').filter(l => l.trim() !== '')
    // 超上限：丢弃最旧的（保留 MAX_ENTRIES - 1 条，给新条目腾位）
    const kept = lines.length >= MAX_ENTRIES ? lines.slice(lines.length - (MAX_ENTRIES - 1)) : lines
    await fs.writeFile(file, [...kept, line.trim()].join('\n') + '\n', 'utf8')
  } catch {
    // 日志写失败不打断主业务（删除/入库等操作已在前完成）
  }
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
