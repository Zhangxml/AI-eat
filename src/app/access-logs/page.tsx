'use client'

// 访问记录列表页（/access-logs）：从设置页进入，展示敏感操作审计日志
// 数据契约：GET /api/access-logs → 200 { logs: [{ time, ip, method, path, status }] }（最新在前）
// 交互：进入拉取一次（读操作不写日志，无轮询必要）；「刷新」手动重拉；空态/错误态/加载态三态
// 移动端三约束：条目单列、触摸目标 ≥44px、无横滚（长路径 break-all）
import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { apiFetch } from '@/lib/api-fetch'

// 日志条目契约（与 src/lib/access-log.ts 的 AccessLogEntry 一致）
interface AccessLogEntry {
  time: string
  ip: string
  method: string
  path: string
  status: number
}

// 每页条数：50 条/页，1000 条上限即最多 20 页
const PAGE_SIZE = 50

// 状态码配色：2xx 绿（正常）、3xx/4xx 中 401/403 红（鉴权失败=有人在乱试）、其余灰
function statusColor(status: number): string {
  if (status >= 200 && status < 300) return 'text-green-600 dark:text-green-400'
  if (status === 401 || status === 403) return 'text-red-600 dark:text-red-400'
  return 'text-neutral-500 dark:text-neutral-400'
}

// ISO 时间转本地可读格式（YYYY-MM-DD HH:mm:ss）
function formatTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso // 手改文件的坏时间原样显示
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export default function AccessLogsPage() {
  const [logs, setLogs] = useState<AccessLogEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  // 前端分页：数据一次拉全量（上限 1000 条，局域网传输无感），按 PAGE_SIZE 切片渲染，
  // 避免一次渲染 1000 个 DOM 节点（手机渲染慢、列表长难翻找）
  const [page, setPage] = useState(1)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await apiFetch('/api/access-logs')
      if (!res.ok) {
        setError(`加载失败（HTTP ${res.status}）`)
        return
      }
      const data = (await res.json()) as { logs?: AccessLogEntry[] }
      setLogs(Array.isArray(data.logs) ? data.logs : [])
    } catch {
      setError('加载失败，网络异常，请稍后重试')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // 分页计算：总页数与当前页切片（logs 顺序为最新在前，页码越大越旧）
  const totalPages = Math.max(1, Math.ceil(logs.length / PAGE_SIZE))
  const safePage = Math.min(page, totalPages) // 刷新后日志变少时页码收敛
  const pageLogs = logs.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE)

  // 刷新时页码重置到第一页（新数据从最新看起）
  const refresh = () => {
    setPage(1)
    return load()
  }

  return (
    <main className="mx-auto max-w-3xl px-4 py-4">
      {/* 页头：标题 + 刷新 + 返回设置 */}
      <header className="mb-4 flex items-center justify-between gap-2">
        <h1 className="text-lg font-medium text-neutral-900 dark:text-neutral-100">访问记录</h1>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={loading}
            aria-label="刷新访问记录"
            className="shrink-0 rounded-lg border border-neutral-900 px-3 py-1.5 text-sm font-medium text-neutral-900 transition-colors active:bg-neutral-100 disabled:border-neutral-300 disabled:text-neutral-400 dark:border-neutral-100 dark:text-neutral-100 dark:active:bg-neutral-800 dark:disabled:border-neutral-700 dark:disabled:text-neutral-500"
          >
            {loading ? '刷新中…' : '刷新'}
          </button>
          <Link
            href="/settings"
            className="shrink-0 text-sm text-neutral-500 transition-colors active:text-neutral-900 dark:text-neutral-400 dark:active:text-neutral-100"
          >
            返回设置
          </Link>
        </div>
      </header>

      {/* 说明条：记录范围（方案 A）——写操作/AI 调用/登录尝试，普通读请求不记 */}
      <p className="mb-3 text-xs leading-5 text-neutral-400 dark:text-neutral-500">
        记录范围：菜谱写入、删除、AI 生成/点菜、备份导入、登录尝试等敏感操作（普通浏览不记录）；最多保留最近 200 条。
      </p>

      {/* 错误条 */}
      {error !== '' && (
        <div role="alert" className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
          {error}
        </div>
      )}

      {/* 三态：加载 / 空 / 列表（分页切片渲染） */}
      {loading && logs.length === 0 ? (
        <p className="py-10 text-center text-sm text-neutral-400 dark:text-neutral-500">加载中…</p>
      ) : !loading && error === '' && logs.length === 0 ? (
        <p className="py-10 text-center text-sm text-neutral-400 dark:text-neutral-500">暂无访问记录</p>
      ) : (
        <>
          <ul className="flex flex-col gap-2">
            {pageLogs.map((log, i) => (
              <li
                key={`${log.time}-${i}`}
                className="rounded-lg border border-neutral-200 bg-white p-3 dark:border-neutral-800 dark:bg-neutral-900"
              >
                {/* 第一行：方法 + 路径（break-all 防长路径横滚）+ 状态码 */}
                <div className="flex min-w-0 items-baseline gap-2">
                  <span className="shrink-0 font-mono text-sm font-medium text-neutral-900 dark:text-neutral-100">
                    {log.method}
                  </span>
                  <span className="min-w-0 flex-1 break-all font-mono text-sm text-neutral-700 dark:text-neutral-300">
                    {log.path}
                  </span>
                  <span className={`shrink-0 font-mono text-sm ${statusColor(log.status)}`}>{log.status}</span>
                </div>
                {/* 第二行：时间 + IP */}
                <div className="mt-1 flex min-w-0 flex-wrap gap-x-3 gap-y-0.5 text-xs text-neutral-500 dark:text-neutral-400">
                  <span>{formatTime(log.time)}</span>
                  <span className="break-all">IP: {log.ip}</span>
                </div>
              </li>
            ))}
          </ul>

          {/* 分页控制：总数 / 页码 / 上一下一（多于一页才显示） */}
          {totalPages > 1 && (
            <nav aria-label="分页" className="mt-4 flex items-center justify-center gap-3">
              <button
                type="button"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={safePage <= 1}
                aria-label="上一页"
                className="min-h-[44px] rounded-lg border border-neutral-300 px-3 py-1.5 text-sm text-neutral-700 transition-colors active:bg-neutral-100 disabled:border-neutral-200 disabled:text-neutral-300 dark:border-neutral-700 dark:text-neutral-300 dark:active:bg-neutral-800 dark:disabled:border-neutral-800 dark:disabled:text-neutral-600"
              >
                上一页
              </button>
              <span className="text-sm tabular-nums text-neutral-600 dark:text-neutral-400">
                第 {safePage} / {totalPages} 页 · 共 {logs.length} 条
              </span>
              <button
                type="button"
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={safePage >= totalPages}
                aria-label="下一页"
                className="min-h-[44px] rounded-lg border border-neutral-300 px-3 py-1.5 text-sm text-neutral-700 transition-colors active:bg-neutral-100 disabled:border-neutral-200 disabled:text-neutral-300 dark:border-neutral-700 dark:text-neutral-300 dark:active:bg-neutral-800 dark:disabled:border-neutral-800 dark:disabled:text-neutral-600"
              >
                下一页
              </button>
            </nav>
          )}
        </>
      )}
    </main>
  )
}
