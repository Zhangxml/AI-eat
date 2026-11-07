'use client'

// 登录页（Task 16，设计 5.6 /login）：PASSWORD 口令登录
// 流程：POST /api/auth（原生 fetch）→ 200 跳首页；401 alert 中文错误
// 用原生 fetch 而非 apiFetch：apiFetch 会对 401 整页跳 /login，
// 登录失败的 401 会触发「登录页 → 登录页」的跳转循环（裁定 6）
// 未启用鉴权（GET /api/auth enabled=false）时提示可直接使用并放行回首页
// 移动端约束与设置页同款：单列、触摸目标 ≥44px、无横向滚动
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'

export default function LoginPage() {
  const router = useRouter()
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  // enabled=null 表示开关查询尚未完成，提交按钮暂不可用，避免无谓的 401 往返
  const [enabled, setEnabled] = useState<boolean | null>(null)

  // 进入登录页先查鉴权开关：未启用则无需登录，直接提示并允许回首页
  useEffect(() => {
    let alive = true
    // 原生 fetch：本页对 401 的处理是展示错误而非跳转，不走 apiFetch（避免跳转循环）
    fetch('/api/auth')
      .then(res => res.json())
      .then((data: { enabled?: boolean }) => {
        if (alive) setEnabled(Boolean(data.enabled))
      })
      .catch(() => {
        // 查询失败按未启用兜底：提交后由服务端裁决（未启用时 POST 也放行）
        if (alive) setEnabled(false)
      })
    return () => {
      alive = false
    }
  }, [])

  // 提交登录：200 → 跳首页；401/其余非 2xx → alert 服务端中文文案（网络异常也有兜底文案）
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (submitting) return
    setSubmitting(true)
    try {
      // 原生 fetch（裁定 6）：登录失败 401 不能触发 apiFetch 的 /login 跳转循环
      const res = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      })
      if (res.ok) {
        // 登录成功：整页跳首页（带新会话 Cookie，路由数据按已登录状态重新拉取）
        router.push('/')
        return
      }
      let msg = '登录失败，请稍后重试'
      try {
        const data = (await res.json()) as { error?: string }
        if (typeof data?.error === 'string' && data.error !== '') msg = data.error
      } catch {
        // 保留默认文案
      }
      alert(msg)
    } catch {
      alert('登录失败，网络异常，请稍后重试')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="mx-auto flex max-w-sm flex-col justify-center px-4 py-10">
      <h1 className="mb-2 text-lg font-medium text-neutral-900 dark:text-neutral-100">AI-eat 登录</h1>
      <p className="mb-6 text-sm text-neutral-600 dark:text-neutral-400">
        {enabled === false ? '本实例未启用访问鉴权，可直接返回使用。' : '请输入访问口令（服务器 PASSWORD 环境变量）'}
      </p>

      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
        <input
          type="password"
          value={password}
          onChange={e => setPassword(e.target.value)}
          placeholder="访问口令"
          aria-label="访问口令"
          autoComplete="current-password"
          className="min-h-[44px] w-full rounded-lg border border-neutral-300 bg-white px-3 text-base text-neutral-900 focus:border-neutral-900 focus:outline-none dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100 dark:focus:border-neutral-100"
        />
        <button
          type="submit"
          disabled={submitting || password === ''}
          className="min-h-[44px] w-full rounded-lg bg-neutral-900 py-3 text-base font-medium text-white transition-colors active:bg-neutral-700 disabled:opacity-60 dark:bg-neutral-100 dark:text-neutral-900 dark:active:bg-neutral-300"
        >
          {submitting ? '登录中…' : '登录'}
        </button>
        {enabled === false && (
          <button
            type="button"
            onClick={() => router.push('/')}
            className="min-h-[44px] w-full rounded-lg border border-neutral-900 py-3 text-base font-medium text-neutral-900 transition-colors active:bg-neutral-100 dark:border-neutral-100 dark:text-neutral-100 dark:active:bg-neutral-800"
          >
            返回首页
          </button>
        )}
      </form>
    </main>
  )
}
