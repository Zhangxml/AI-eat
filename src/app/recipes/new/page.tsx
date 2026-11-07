'use client'

// 人工录入页：复用 RecipeForm，onSubmit 组装为 POST /api/recipes，成功后跳详情页
// 契约（Task 4）：POST /api/recipes（body: DraftRecipe）→ 201 Recipe | 400 { error: 中文 }
// 防重复提交由 RecipeForm 内部 submitting 状态承担，本页不重复维护
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import RecipeForm from '@/components/RecipeForm'
import { apiFetch } from '@/lib/api-fetch'
import type { DraftRecipe, Recipe } from '@/lib/recipe-types'

export default function NewRecipePage() {
  const router = useRouter()

  // RecipeForm onSubmit 契约：交草稿、返回 Response；成功跳转在此完成
  async function handleSubmit(draft: DraftRecipe): Promise<Response> {
    const res = await apiFetch('/api/recipes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(draft),
    })
    if (res.ok) {
      // 201 响应为裸 Recipe（route.ts: Response.json(recipe)），无 { recipe } 包裹
      const data = (await res.json()) as Recipe
      router.push(`/recipes/${data.id}`)
    }
    // 失败时 Response 原样交还 RecipeForm 统一 alert 错误文案
    return res
  }

  return (
    <main className="mx-auto max-w-3xl px-4 py-4">
      {/* 页头：标题 + 返回菜谱库 */}
      <header className="mb-4 flex items-center justify-between gap-2">
        <h1 className="text-lg font-medium text-neutral-900">录入新菜谱</h1>
        <Link
          href="/recipes"
          className="flex min-h-[44px] items-center text-sm text-neutral-500 transition-colors active:text-neutral-900"
        >
          返回菜谱库
        </Link>
      </header>
      <RecipeForm onSubmit={handleSubmit} submitLabel="保存菜谱" />
    </main>
  )
}
