// 菜谱数据模型与 zod 校验的单测：约束 schema 结构（设计文档 5.3）
import { describe, expect, it } from 'vitest'
import { validateDraft, validateNutrition, validateRecipe, makeRecipeId } from './recipe-types'

const goodDraft = {
  name: '番茄炒蛋', servings: 2, difficulty: '简单', totalTimeMin: 20,
  tags: ['家常菜'], ingredients: [{ name: '番茄', amount: '2个' }],
  steps: ['番茄切块'], source: 'ai',
}

describe('菜谱校验', () => {
  it('合法草稿通过', () => expect(validateDraft(goodDraft)).not.toBeNull())
  it('空食材列表拒绝', () => expect(validateDraft({ ...goodDraft, ingredients: [] })).toBeNull())
  it('空步骤列表拒绝', () => expect(validateDraft({ ...goodDraft, steps: [] })).toBeNull())
  it('非法 source 拒绝', () => expect(validateDraft({ ...goodDraft, source: 'web' })).toBeNull())
  it('营养缺 estimated 拒绝', () =>
    expect(validateDraft({ ...goodDraft, nutrition: { caloriesKcal: 1, proteinG: 1, fatG: 1, carbG: 1 } })).toBeNull())
  it('独立营养校验：四项 + estimated:true 通过，缺字段/estimated 非 true 拒绝', () => {
    expect(validateNutrition({ caloriesKcal: 180, proteinG: 8, fatG: 10, carbG: 12, estimated: true })).toEqual({
      caloriesKcal: 180,
      proteinG: 8,
      fatG: 10,
      carbG: 12,
      estimated: true,
    })
    expect(validateNutrition({ caloriesKcal: 180, proteinG: 8, fatG: 10, carbG: 12, estimated: false })).toBeNull()
    expect(validateNutrition({ caloriesKCal: 180 })).toBeNull()
  })
  it('完整 Recipe 通过', () =>
    expect(validateRecipe({ ...goodDraft, id: 'r-1', createdAt: 'x', updatedAt: 'x' })).not.toBeNull())
  it('id 格式正确', () => expect(makeRecipeId()).toMatch(/^r-\d+-[0-9a-f]{6}$/))
})
