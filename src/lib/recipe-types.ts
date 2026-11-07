// 菜谱数据模型与 zod 校验（设计文档 5.3 数据模板）
// 本层只校验结构，不校验语义合理性（如时间字符串格式），以保障 T3/T15 的时间戳与备份导入
import { z } from 'zod'
import { randomBytes } from 'node:crypto'

// 营养信息：estimated 恒为字面量 true（AI 估算，非实测）
const nutritionSchema = z
  .object({
    caloriesKcal: z.number(),
    proteinG: z.number(),
    fatG: z.number(),
    carbG: z.number(),
    estimated: z.literal(true),
  })
  .strict()

// 食材项
const ingredientSchema = z
  .object({
    name: z.string().min(1),
    amount: z.string().min(1),
  })
  .strict()

// 完整菜谱 schema：source 枚举 ai|manual；category 可选，枚举 荤菜|素菜|汤|主食|其他；
// 食材与步骤列表禁止为空（.strict() 拒绝多余字段，防止脏数据入库）
const recipeSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    category: z.enum(['荤菜', '素菜', '汤', '主食', '其他']).optional(),
    servings: z.number().int().min(1),
    difficulty: z.string().min(1),
    totalTimeMin: z.number().int().min(1),
    tags: z.array(z.string().min(1)),
    ingredients: z.array(ingredientSchema).min(1),
    steps: z.array(z.string().min(1)).min(1),
    nutrition: nutritionSchema.optional(),
    source: z.enum(['ai', 'manual']),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict()

// 草稿 schema：完整 schema 去掉 id/createdAt/updatedAt 三个字段
const draftRecipeSchema = recipeSchema.omit({ id: true, createdAt: true, updatedAt: true })

export type Nutrition = z.infer<typeof nutritionSchema>
export type Recipe = z.infer<typeof recipeSchema>
export type DraftRecipe = Omit<Recipe, 'id' | 'createdAt' | 'updatedAt'>

// 校验完整菜谱，失败返回 null
export function validateRecipe(input: unknown): Recipe | null {
  const result = recipeSchema.safeParse(input)
  return result.success ? result.data : null
}

// 校验草稿（不含 id/时间戳），失败返回 null
export function validateDraft(input: unknown): DraftRecipe | null {
  const result = draftRecipeSchema.safeParse(input)
  return result.success ? result.data : null
}

// 生成菜谱 id：r-<毫秒时间戳>-<6位hex>；now 仅供测试注入
export function makeRecipeId(now?: number): string {
  const ts = now ?? Date.now()
  return `r-${ts}-${randomBytes(3).toString('hex')}`
}
