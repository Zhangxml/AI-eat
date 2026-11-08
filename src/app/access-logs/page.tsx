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

  return (
    <main className="mx-auto max-w-3xl px-4 py-4">
      {/* 页头：标题 + 刷新 + 返回设置 */}
      <header className="mb-4 flex items-center justify-between gap-2">
        <h1 className="text-lg font-medium text-neutral-900 dark:text-neutral-100">访问记录</h1>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => void load()}
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
        记录范围：菜谱写入、删除、AI 生成/点菜、备份导入、登录尝试等敏感操作（普通浏览不记录）；最多保留最近 1000 条。
      </p>

      {/* 错误条 */}
      {error !== '' && (
        <div role="alert" className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
          {error}
        </div>
      )}

      {/* 三态：加载 / 空 / 列表 */}
      {loading && logs.length === 0 ? (
        <p className="py-10 text-center text-sm text-neutral-400 dark:text-neutral-500">加载中…</p>
      ) : !loading && error === '' && logs.length === 0 ? (
        <p className="py-10 text-center text-sm text-neutral-400 dark:text-neutral-500">暂无访问记录</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {logs.map((log, i) => (
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
      )}
    </main>
  )
}
