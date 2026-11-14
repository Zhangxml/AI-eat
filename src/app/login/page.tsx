'use client'

// 登录页（多用户）：首次使用显示「初始化管理员」，之后显示「用户名 + 密码」登录。
// 免密单用户模式（env.PASSWORD 为空）下不显示任何表单，直接跳回目标页。
// 流程：GET /api/auth 查 passwordless / needsSetup → POST /api/auth { username, password } → 200 跳首页
// 用原生 fetch 而非 apiFetch：apiFetch 会对 401 整页跳 /login，登录失败的 401 会触发「登录页 → 登录页」死循环
import { useEffect, useRef, useState } from 'react'
import { safeNextPath } from '@/lib/safe-next-path'

interface AuthState {
  needsSetup: boolean
  enabled: boolean
  /** 免密单用户模式：直接进站，不显示表单 */
  passwordless?: boolean
  /** 用户名预填（第一个管理员的实际名字；管理员禁止改名，所以稳定） */
  defaultUsername?: string
  currentUser?: { name: string; role: string }
}

export default function LoginPage() {
  // middleware 重定向时带 ?next=<原路径>，登录后回跳。
  // 用 window.location.search 而不是 useSearchParams：后者要求 Suspense 边界（构建会报错），
  // 而这里只在客户端读取，放在 effect 里即可（SSR 时不执行）。
  // 只接受站内绝对路径，防开放重定向（//evil.com 与 http://... 一律回落首页）。
  // 用 ref 保存回跳目标：effect 只跑一次（不因它重跑），读取时拿最新值
  const targetRef = useRef('/')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  // null = 尚未查到开关；决定显示「初始化」还是「登录」
  const [state, setState] = useState<AuthState | null>(null)
  const [error, setError] = useState('')

  // 进入登录页先查状态：需要初始化 / 需要登录 / 已登录可直接回目标页
  useEffect(() => {
    const raw = new URLSearchParams(window.location.search).get('next')
    // 统一走 safeNextPath：反斜杠/协议相对/绝对 URL/javascript: 等变体一律回落首页（防开放重定向）
    targetRef.current = safeNextPath(raw, window.location.origin)

    let alive = true
    fetch('/api/auth')
      .then(res => res.json())
      .then((data: AuthState) => {
        if (!alive) return
        setState(data)
        // 预填用户名：管理员禁止改名，所以这个值稳定；用户只需输密码
        if (data.defaultUsername) setUsername(data.defaultUsername)
        // 已登录 / 免密模式直接回目标页。
        // 必须整页跳转（location.replace）：登录态刚变化时，Next 客户端路由缓存里可能还存着
        // 「未登录 → 307 到 /login」的预取结果，用 router.replace 会复用该缓存、又被弹回登录页。
        if (data.currentUser || data.passwordless) window.location.replace(targetRef.current)
      })
      .catch(() => {
        // 查询失败：保守按「需要登录」处理，提交后由服务端裁决
        if (alive) setState({ needsSetup: false, enabled: true })
      })
    return () => {
      alive = false
    }
  }, [])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (submitting) return
    setSubmitting(true)
    setError('')
    try {
      const res = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username.trim(), password }),
      })
      if (res.ok) {
        // 整页跳转：绕过客户端路由缓存（详见上方注释），并让 middleware 在新请求上看到新 Cookie。
        // 现读一次 next（不是用挂载时缓存的值）——用户在登录页点了别的 tab 后，URL 上的 next 会更新
        const nowRaw = new URLSearchParams(window.location.search).get('next')
        window.location.replace(safeNextPath(nowRaw, window.location.origin))
        return
      }
      let msg = '登录失败，请稍后重试'
      try {
        const data = (await res.json()) as { error?: string }
        if (typeof data?.error === 'string' && data.error !== '') msg = data.error
      } catch {
        // 保留默认文案
      }
      setError(msg)
    } catch {
      setError('登录失败，网络异常，请稍后重试')
    } finally {
      setSubmitting(false)
    }
  }

  const needsSetup = state?.needsSetup === true
  const canSubmit = username.trim() !== '' && password !== '' && !submitting
  const inputClass =
    'min-h-[44px] w-full rounded-lg border border-neutral-300 bg-white px-3 text-base text-neutral-900 focus:border-neutral-900 focus:outline-none dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100 dark:focus:border-neutral-100'

  return (
    <main className="mx-auto flex max-w-sm flex-col justify-center px-4 py-10">
      <h1 className="mb-2 text-lg font-medium text-neutral-900 dark:text-neutral-100">
        {needsSetup ? '初始化管理员' : 'AI-eat 登录'}
      </h1>
      <p className="mb-6 text-sm text-neutral-600 dark:text-neutral-400">
        {state === null
          ? '加载中…'
          : needsSetup
            ? '首次使用：创建管理员账号（将接收现有菜谱库）'
            : '请输入用户名与密码'}
      </p>

      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
        <input
          type="text"
          value={username}
          onChange={e => setUsername(e.target.value)}
          placeholder={needsSetup ? '管理员用户名，例如：爸爸' : '用户名'}
          aria-label="用户名"
          autoComplete="username"
          className={inputClass}
        />
        <input
          type="password"
          value={password}
          onChange={e => setPassword(e.target.value)}
          placeholder={needsSetup ? '设置密码（至少 4 位）' : '密码'}
          aria-label="密码"
          autoComplete={needsSetup ? 'new-password' : 'current-password'}
          className={inputClass}
        />
        {error !== '' && (
          <p role="alert" className="break-words text-sm text-red-600 dark:text-red-400">
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={!canSubmit}
          className="min-h-[44px] w-full rounded-lg bg-neutral-900 py-3 text-base font-medium text-white transition-colors active:bg-neutral-700 disabled:opacity-60 dark:bg-neutral-100 dark:text-neutral-900 dark:active:bg-neutral-300"
        >
          {submitting ? (needsSetup ? '创建中…' : '登录中…') : needsSetup ? '创建并进入' : '登录'}
        </button>
      </form>
    </main>
  )
}
