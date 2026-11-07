'use client'

// 设置页（Task 15，设计 5.5 /settings）：备份导出/导入 + AI 供应商只读展示 + 鉴权状态展示
// 契约：GET /api/backup → 200 { exportedAt, recipes }（Content-Disposition 附件头）
//       POST /api/backup { recipes } → 200 { imported, skipped, skippedIds, invalidIds } | 400 { error }
//       GET /api/config → 200 { aiConfigured, baseUrl, model, authEnabled }（绝不含 apiKey）
// 纯 UI 页无单测（裁定 5），移动端三约束：单列、触摸目标 ≥44px、无横向滚动
import { useCallback, useEffect, useRef, useState } from 'react'
import { apiFetch } from '@/lib/api-fetch'

// GET /api/config 响应契约（与 route.ts 一致，绝不含 apiKey 字段）
interface ConfigResponse {
  aiConfigured: boolean
  baseUrl: string | null
  model: string | null
  authEnabled: boolean
  deleteEnabled: boolean
}

// POST /api/backup 导入结果契约
interface ImportResult {
  imported: number
  skipped: number
  skippedIds: string[]
  invalidIds: string[]
}

export default function SettingsPage() {
  const [config, setConfig] = useState<ConfigResponse | null>(null)
  // 导入流程状态：selectedFile 选中待导入的文件；importing 导入请求进行中；result 导入结果
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [importing, setImporting] = useState(false)
  const [result, setResult] = useState<ImportResult | null>(null)
  const [error, setError] = useState('')
  // 导出进行中状态
  const [exporting, setExporting] = useState(false)
  // 竞态防护：组件卸载后不再 setState
  const mountedRef = useRef(true)

  // 拉取配置状态：只读展示，失败静默（页面主体不依赖它）
  const loadConfig = useCallback(async () => {
    try {
      const res = await apiFetch('/api/config')
      if (!res.ok || !mountedRef.current) return
      const data = (await res.json()) as ConfigResponse
      if (mountedRef.current) setConfig(data)
    } catch {
      // 网络异常时保持 null，页面展示「加载失败」兜底文案
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    void loadConfig()
    return () => {
      mountedRef.current = false
    }
  }, [loadConfig])

  // 导出：GET /api/backup → blob → 创建 <a download> 触发浏览器下载
  // 文件名取 Content-Disposition 里的 filename（与服务端 YYYYMMDD 保持一致），解析失败回退本地日期
  async function handleExport() {
    if (exporting) return
    setExporting(true)
    try {
      const res = await apiFetch('/api/backup')
      if (!res.ok) {
        alert('导出失败，请稍后重试')
        return
      }
      const blob = await res.blob()
      // 解析 Content-Disposition: attachment; filename=ai-eat-backup-YYYYMMDD.json
      const disposition = res.headers.get('Content-Disposition') ?? ''
      const match = disposition.match(/filename=([^;]+)/)
      const filename = match ? match[1].trim() : `ai-eat-backup-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.json`
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } catch {
      alert('导出失败，网络异常，请稍后重试')
    } finally {
      setExporting(false)
    }
  }

  // 文件选择：只记录文件并清空上次结果/错误，真正导入由「开始导入」按钮触发
  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0] ?? null
    setSelectedFile(file)
    setResult(null)
    setError('')
  }

  // 导入：读文件文本 → JSON.parse → POST /api/backup → 200 展示 imported/skipped/invalid 结果
  async function handleImport() {
    if (!selectedFile || importing) return
    setImporting(true)
    setResult(null)
    setError('')
    try {
      let payload: unknown
      try {
        payload = JSON.parse(await selectedFile.text())
      } catch {
        setError('所选文件不是合法的 JSON 文件')
        return
      }
      const res = await apiFetch('/api/backup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!res.ok) {
        // 契约：400 { error: 中文 }；优先透出服务端文案，解析失败回退通用文案
        let msg = '导入失败，请稍后重试'
        try {
          const data = (await res.json()) as { error?: string }
          if (typeof data?.error === 'string' && data.error !== '') msg = data.error
        } catch {
          // 保留默认文案
        }
        setError(msg)
        return
      }
      const data = (await res.json()) as ImportResult
      setResult(data)
    } catch {
      setError('导入失败，网络异常，请稍后重试')
    } finally {
      setImporting(false)
    }
  }

  return (
    <main className="mx-auto max-w-3xl px-4 py-4">
      <h1 className="mb-4 text-lg font-medium text-neutral-900 dark:text-neutral-100">设置</h1>

      {/* 备份区块：导出 + 导入 */}
      <section className="mb-6 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
        <h2 className="mb-3 text-sm font-medium text-neutral-900 dark:text-neutral-100">备份</h2>

        {/* 导出：全宽按钮，触摸目标 ≥44px */}
        <button
          type="button"
          onClick={handleExport}
          disabled={exporting}
          className="min-h-[44px] w-full rounded-lg bg-neutral-900 py-3 text-base font-medium text-white transition-colors active:bg-neutral-700 disabled:opacity-60 dark:bg-neutral-100 dark:text-neutral-900 dark:active:bg-neutral-300"
        >
          {exporting ? '导出中…' : '导出备份（JSON 下载）'}
        </button>

        {/* 导入：文件选择 + 开始导入；行内 flex 弹性收缩，无横向滚动；两按钮统一描边规格等高对齐
            （file input 不设 min-h，其高度由 ::file-selector-button 决定，与右侧按钮同为 34px 基线对齐） */}
        <div className="flex items-center gap-2">
          <input
            type="file"
            accept=".json,application/json"
            onChange={handleFileChange}
            aria-label="选择备份文件"
            className="w-full min-w-0 flex-1 text-sm text-neutral-600 file:cursor-pointer file:rounded-lg file:border file:border-neutral-300 file:bg-transparent file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-neutral-900 dark:text-neutral-400 dark:file:border-neutral-700 dark:file:text-neutral-100"
          />
          <button
            type="button"
            onClick={handleImport}
            disabled={!selectedFile || importing}
            aria-label="开始导入"
            className="shrink-0 rounded-lg border border-neutral-900 px-3 py-1.5 text-sm font-medium text-neutral-900 transition-colors active:bg-neutral-100 disabled:border-neutral-300 disabled:text-neutral-400 dark:border-neutral-100 dark:text-neutral-100 dark:active:bg-neutral-800 dark:disabled:border-neutral-700 dark:disabled:text-neutral-500"
          >
            {importing ? '导入中…' : '开始导入'}
          </button>
        </div>

        {/* 错误条：JSON 解析失败或服务端 400 文案 */}
        {error && (
          <p role="alert" className="mt-3 break-words text-sm text-red-600 dark:text-red-400">
            {error}
          </p>
        )}

        {/* 导入结果：imported/skipped 计数 + skippedIds/invalidIds 明细 */}
        {result && (
          <div className="mt-3 rounded-lg bg-neutral-100 p-3 text-sm dark:bg-neutral-800">
            <p className="text-neutral-900 dark:text-neutral-100">
              导入完成：新导入 {result.imported} 条，跳过 {result.skipped} 条
            </p>
            {result.skippedIds.length > 0 && (
              <p className="mt-1 break-words text-neutral-600 dark:text-neutral-400">
                已存在跳过（{result.skippedIds.length}）：{result.skippedIds.join('、')}
              </p>
            )}
            {result.invalidIds.length > 0 && (
              <p className="mt-1 break-words text-red-600 dark:text-red-400">
                非法跳过（{result.invalidIds.length}）：{result.invalidIds.join('、')}
              </p>
            )}
          </div>
        )}
      </section>

      {/* AI 供应商只读展示：来自 GET /api/config，绝无 apiKey */}
      <section className="mb-6 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
        <h2 className="mb-3 text-sm font-medium text-neutral-900 dark:text-neutral-100">AI 供应商</h2>
        {config === null ? (
          <p className="text-sm text-neutral-500 dark:text-neutral-400">状态加载失败</p>
        ) : !config.aiConfigured ? (
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            未配置。请在服务器环境变量设置 AI_BASE_URL / AI_API_KEY / AI_MODEL 后重启。
          </p>
        ) : (
          <div className="flex flex-col gap-1 text-sm">
            <p className="break-words text-neutral-600 dark:text-neutral-400">
              接口地址：<span className="break-all text-neutral-900 dark:text-neutral-100">{config.baseUrl}</span>
            </p>
            <p className="break-words text-neutral-600 dark:text-neutral-400">
              模型：<span className="break-all text-neutral-900 dark:text-neutral-100">{config.model}</span>
            </p>
          </div>
        )}
      </section>

      {/* 鉴权状态展示：PASSWORD 是否启用 */}
      <section className="rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
        <h2 className="mb-3 text-sm font-medium text-neutral-900 dark:text-neutral-100">访问鉴权</h2>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          {config === null
            ? '状态加载失败'
            : config.authEnabled
              ? '已启用（需口令登录后访问）'
              : '未启用（局域网信任边界，无需登录）'}
        </p>
      </section>

      {/* 删除保护状态展示：DELETE_ENABLED+DELETE_PASSWORD 是否启用（删除菜谱需输密码，服务端校验） */}
      <section className="rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
        <h2 className="mb-3 text-sm font-medium text-neutral-900 dark:text-neutral-100">删除保护</h2>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          {config === null
            ? '状态加载失败'
            : config.deleteEnabled
              ? '已启用（删除菜谱需输入删除密码，服务端校验）'
              : '未启用（删除仅浏览器确认，无密码校验）。启用：设置 DELETE_ENABLED=true 与 DELETE_PASSWORD 后重启'}
        </p>
      </section>
    </main>
  )
}
