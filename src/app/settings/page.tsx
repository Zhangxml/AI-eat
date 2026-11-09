'use client'

// 设置页（Task 15，设计 5.5 /settings）：备份导出/导入 + AI 供应商只读展示 + 鉴权状态展示
// 契约：GET /api/backup → 200 { exportedAt, recipes }（Content-Disposition 附件头）
//       POST /api/backup { recipes } → 200 { imported, skipped, skippedIds, invalidIds } | 400 { error }
//       GET /api/config → 200 { aiConfigured, baseUrl, model, authEnabled }（绝不含 apiKey）
//       GET/PATCH /api/settings → 用户级可写偏好（推荐风格等），存服务器 data/settings.json
// 纯 UI 页无单测（裁定 5），移动端三约束：单列、触摸目标 ≥44px、无横向滚动
// 「访问记录」入口默认隐藏（避免家人一眼看到审计记录），在「访问鉴权」卡片连点 5 次才显示；
// 用组件内存态实现 → 刷新/重进页面天然回到隐藏（计数逻辑见 src/lib/tap-reveal.ts，有单测）
import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { apiFetch } from '@/lib/api-fetch'
import { createTapReveal } from '@/lib/tap-reveal'

// GET /api/config 响应契约（与 route.ts 一致，绝不含 apiKey 字段）
interface ConfigResponse {
  aiConfigured: boolean
  baseUrl: string | null
  model: string | null
  authEnabled: boolean
  deleteEnabled: boolean
}

// GET/PATCH /api/settings 响应契约（与 src/lib/settings.ts 一致）
interface SettingsResponse {
  version: number
  style: 'home' | 'creative'
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
  // 审计 #24：配置加载失败态与「加载中」区分——初次渲染 config 为 null 时显示加载中，
  // 仅请求真正失败后才显示「加载失败」并给重试入口（原实现初载必现失败文案闪烁）
  const [configFailed, setConfigFailed] = useState(false)
  // 导入流程状态：selectedFile 选中待导入的文件；importing 导入请求进行中；result 导入结果
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [importing, setImporting] = useState(false)
  const [result, setResult] = useState<ImportResult | null>(null)
  const [error, setError] = useState('')
  // 导出进行中状态
  const [exporting, setExporting] = useState(false)
  // 访问记录入口是否可见：默认隐藏，连点「访问鉴权」5 次后显示。
  // 只用组件内存态——刷新页面即回到隐藏（需求明确要求「刷新后隐藏」）
  const [accessLogsVisible, setAccessLogsVisible] = useState(false)
  // 连击计数器放在 ref：不触发渲染，也不参与 effect 依赖
  const tapRevealRef = useRef<ReturnType<typeof createTapReveal> | null>(null)
  if (tapRevealRef.current === null) tapRevealRef.current = createTapReveal()
  // 用户偏好（推荐风格）：null=加载中；保存中禁用切换防连点；错误显示在分组内
  const [settings, setSettings] = useState<SettingsResponse | null>(null)
  const [savingStyle, setSavingStyle] = useState(false)
  const [styleError, setStyleError] = useState('')
  // 竞态防护：组件卸载后不再 setState
  const mountedRef = useRef(true)

  // 拉取配置状态：只读展示；失败置 configFailed 供页面显示「加载失败 + 重试」
  const loadConfig = useCallback(async () => {
    setConfigFailed(false)
    try {
      const res = await apiFetch('/api/config')
      if (!res.ok || !mountedRef.current) {
        if (mountedRef.current) setConfigFailed(true)
        return
      }
      const data = (await res.json()) as ConfigResponse
      if (mountedRef.current) setConfig(data)
    } catch {
      // 网络异常：标记失败态（页面据此显示「加载失败」与重试按钮）
      if (mountedRef.current) setConfigFailed(true)
    }
  }, [])

  // 拉取用户偏好：失败保持 null（分组显示「加载失败」+ 重试），不影响其他分组
  const loadSettings = useCallback(async () => {
    try {
      const res = await apiFetch('/api/settings')
      if (!res.ok || !mountedRef.current) {
        if (mountedRef.current) setStyleError('偏好加载失败')
        return
      }
      const data = (await res.json()) as SettingsResponse
      if (mountedRef.current) {
        setSettings(data)
        setStyleError('')
      }
    } catch {
      if (mountedRef.current) setStyleError('偏好加载失败')
    }
  }, [])

  // 「访问鉴权」卡片被点击：累计连点，达到阈值后显示访问记录入口。
  // 刻意不做任何进度提示——否则连点 3 次就会被旁人看出端倪，隐藏就失去意义
  const handleAuthCardTap = useCallback(() => {
    if (tapRevealRef.current?.tap(Date.now()) === true) setAccessLogsVisible(true)
  }, [])

  // 切换推荐风格：乐观更新（点即高亮）→ PATCH；失败回滚并提示
  const changeStyle = useCallback(
    async (next: SettingsResponse['style']) => {
      if (savingStyle || settings === null || settings.style === next) return
      const prev = settings
      setStyleError('')
      setSettings({ ...prev, style: next })
      setSavingStyle(true)
      try {
        const res = await apiFetch('/api/settings', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ style: next }),
        })
        if (!res.ok) {
          let msg = '保存失败，请重试'
          try {
            const data = (await res.json()) as { error?: string }
            if (typeof data?.error === 'string' && data.error !== '') msg = data.error
          } catch {
            // 非 JSON 错误体：沿用默认文案
          }
          if (mountedRef.current) {
            setSettings(prev)
            setStyleError(msg)
          }
          return
        }
        const data = (await res.json()) as SettingsResponse
        if (mountedRef.current) setSettings(data)
      } catch {
        if (mountedRef.current) {
          setSettings(prev)
          setStyleError('保存失败，网络异常，请稍后重试')
        }
      } finally {
        if (mountedRef.current) setSavingStyle(false)
      }
    },
    [savingStyle, settings],
  )

  useEffect(() => {
    mountedRef.current = true
    void loadConfig()
    void loadSettings()
    return () => {
      mountedRef.current = false
    }
  }, [loadConfig, loadSettings])

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

  // 文件选择：只记录文件并清空上次结果/错误，真正导入由「开始导入」按钮触发。
  // 审计 #19：选中后清空 input.value——否则同一文件二次选择不触发 onChange（失败后重试导入的常见场景）
  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0] ?? null
    setSelectedFile(file)
    setResult(null)
    setError('')
    e.target.value = ''
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

      {/* 推荐风格：全局偏好（存服务端 data/settings.json），影响问问AI 与买什么两个模块 */}
      <section className="mb-6 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
        <h2 className="mb-3 text-sm font-medium text-neutral-900 dark:text-neutral-100">推荐风格</h2>
        {settings === null ? (
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            {styleError !== '' ? (
              <>
                {styleError}{' '}
                <button
                  type="button"
                  onClick={() => void loadSettings()}
                  className="underline underline-offset-2"
                >
                  重试
                </button>
              </>
            ) : (
              '加载中…'
            )}
          </p>
        ) : (
          <>
            <div className="flex items-center gap-2" role="group" aria-label="推荐风格">
              {[
                { key: 'home' as const, label: '湖北家常' },
                { key: 'creative' as const, label: '换换口味' },
              ].map((opt) => (
                <button
                  key={opt.key}
                  type="button"
                  onClick={() => void changeStyle(opt.key)}
                  aria-pressed={settings.style === opt.key}
                  disabled={savingStyle}
                  className={`min-h-[36px] rounded-full border px-4 py-1 text-sm transition-colors disabled:opacity-60 ${
                    settings.style === opt.key
                      ? 'border-neutral-900 bg-neutral-900 text-white dark:border-neutral-100 dark:bg-neutral-100 dark:text-neutral-900'
                      : 'border-neutral-300 bg-white text-neutral-600 active:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300 dark:active:bg-neutral-800'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
              {settings.style === 'home'
                ? '湖北家常菜优先：粉蒸、煨汤、腊味、藕与鱼鲜，做法简单下饭'
                : '中式地方风味优先，避免常见大路菜'}
            </p>
          </>
        )}
        {styleError !== '' && settings !== null && (
          <p role="alert" className="mt-2 break-words text-sm text-red-600 dark:text-red-400">
            {styleError}
          </p>
        )}
      </section>

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

        {/* 导入：文件选择 + 开始导入（与导出按钮间距 12px）；行内 flex 弹性收缩，无横向滚动；
            两按钮统一描边规格等高对齐（file input 不设 min-h，高度由 ::file-selector-button 决定） */}
        <div className="mt-3 flex items-center gap-3">
          <input
            type="file"
            accept=".json,application/json"
            onChange={handleFileChange}
            aria-label="选择备份文件"
            className="w-full min-w-0 flex-1 text-sm text-neutral-600 file:cursor-pointer file:mr-3 file:rounded-lg file:border file:border-neutral-300 file:bg-transparent file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-neutral-900 dark:text-neutral-400 dark:file:border-neutral-700 dark:file:text-neutral-100"
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
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            {configFailed ? (
              <>
                状态加载失败{' '}
                <button
                  type="button"
                  onClick={() => void loadConfig()}
                  className="underline underline-offset-2"
                >
                  重试
                </button>
              </>
            ) : (
              '加载中…'
            )}
          </p>
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

      {/* 鉴权状态展示：PASSWORD 是否启用。与删除保护卡构成一组（分组卡片样式）：
          上卡只留顶部圆角、下卡只留底部圆角，两卡贴合无间隔，组间与其他卡片一致（mb-6）。
          整卡可点：连点 5 次显示「访问记录」入口（默认隐藏；刷新即回隐藏）。
          刻意不给任何进度提示，否则连点几次就暴露了 */}
      <section
        role="button"
        tabIndex={0}
        // 不用 aria-label：它会覆盖子内容，读屏用户就听不到「已启用/未启用」这句唯一的有效信息。
        // 改用 labelledby/describedby 把标题与状态都挂进可访问名与描述。
        aria-labelledby="auth-card-title"
        aria-describedby="auth-card-desc"
        onClick={handleAuthCardTap}
        onKeyDown={(e) => {
          // 键盘可达：Enter / Space 计一次点击。
          if (e.key !== 'Enter' && e.key !== ' ') return
          // preventDefault 必须放在 e.repeat 之前：Space 的默认动作是滚动页面，
          // 而浏览器对「按住键」会逐次派发 keydown，前一次的 preventDefault 管不住后续 repeat
          // （实测：先判 repeat 再 return，按住 Space 页面会一路滚到底）。
          e.preventDefault()
          // e.repeat 拦掉按住键的自动重复——否则一次长按就能刷满 5 次，违背「连续点击 5 次」语义
          if (e.repeat) return
          handleAuthCardTap()
        }}
        className="cursor-default rounded-t-xl border border-b-0 border-neutral-200 p-4 outline-none transition-colors active:bg-neutral-50 focus-visible:ring-2 focus-visible:ring-neutral-400 dark:border-neutral-800 dark:active:bg-neutral-900"
      >
        <h2 id="auth-card-title" className="mb-3 text-sm font-medium text-neutral-900 dark:text-neutral-100">
          访问鉴权
        </h2>
        <p id="auth-card-desc" className="text-sm text-neutral-600 dark:text-neutral-400">
          {config === null
            ? configFailed
              ? '状态加载失败'
              : '加载中…'
            : config.authEnabled
              ? '已启用（需口令登录后访问）'
              : '未启用（局域网信任边界，无需登录）'}
        </p>
      </section>

      {/* 删除保护状态展示：DELETE_ENABLED+DELETE_PASSWORD 是否启用（删除菜谱需输密码，服务端校验）。
          圆角随访问记录入口的可见性联动：入口隐藏时它是组尾（需底部圆角 + 下边框），
          否则会出现「页面底部缺一个圆角 + 多一条断掉的边框」的视觉瑕疵 */}
      <section
        className={`border border-neutral-200 p-4 dark:border-neutral-800 ${
          accessLogsVisible ? 'rounded-none border-b-0' : 'rounded-b-xl'
        }`}
      >
        <h2 className="mb-3 text-sm font-medium text-neutral-900 dark:text-neutral-100">删除保护</h2>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          {config === null
            ? configFailed
              ? '状态加载失败'
              : '加载中…'
            : config.deleteEnabled
              ? '已启用（删除菜谱需输入删除密码，服务端校验）'
              : '未启用（删除仅浏览器确认，无密码校验）。启用：设置 DELETE_ENABLED=true 与 DELETE_PASSWORD 后重启'}
        </p>
      </section>

      {/* 访问记录入口：默认隐藏；在「访问鉴权」卡连点 5 次后显示（内存态，刷新即回隐藏）。
          显示时作为状态组组尾卡（底部圆角），与上两卡贴合无间隔 */}
      {accessLogsVisible && (
        <Link
          href="/access-logs"
          className="block rounded-b-xl border border-neutral-200 p-4 transition-colors active:bg-neutral-50 dark:border-neutral-800 dark:active:bg-neutral-900"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-medium text-neutral-900 dark:text-neutral-100">访问记录</span>
            <span className="shrink-0 text-neutral-400 dark:text-neutral-500">›</span>
          </div>
          <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
            查看写入、AI 调用与登录尝试等敏感操作记录
          </p>
        </Link>
      )}
    </main>
  )
}
