// 原子写（临时文件 + rename）：菜谱库与用户设置共用的唯一写盘原语。
// 并发安全：临时文件名带随机后缀——原实现用固定 `${file}.tmp`，两个并发写会争用同一临时文件，
// 实测 50 轮并发里 41 轮出现「一方 rename 时报 ENOENT（表现为 500），但磁盘上是另一方内容」，
// 失败方的修改被静默吞掉。随机后缀让每个写手独占自己的临时文件。
// 失败语义：写失败向上抛（由 API 层映射 500），并把临时文件清理干净，不残留 .tmp。
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

export async function atomicWriteFile(file: string, data: string): Promise<void> {
  // 随机后缀放在同目录（跨文件系统 rename 会退化失败，必须同目录）
  const tmp = `${file}.${randomUUID()}.tmp`
  try {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(tmp, data, 'utf8')
    await fs.rename(tmp, file)
  } finally {
    // 成功时 tmp 已被 rename，rm 为 no-op；失败时清理自己的临时文件
    await fs.rm(tmp, { force: true }).catch(() => {})
  }
}
