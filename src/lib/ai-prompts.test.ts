// AI 提示词与结构化输出解析的单测（Task 9）
// 覆盖：库摘要注入（设计 5.2）、格式规则文本（内嵌 5.3 番茄炒蛋示例）、三形态输出提取 + 校验失败返回 null
import { describe, expect, it } from 'vitest'
import { systemPromptWithLibrary, RECIPE_FORMAT_RULE, extractJson, extractRecipeJson } from './ai-prompts'
import type { Recipe } from './recipe-types'

// 合法 Recipe 夹具：番茄炒蛋，字段与设计文档 5.3 示例一致（含 id/时间戳/source:'ai'/nutrition.estimated:true）
const recipeFixture: Recipe = {
  id: 'r-1730000000-ab12cd',
  name: '番茄炒蛋',
  category: '荤菜',
  servings: 2,
  difficulty: '简单',
  totalTimeMin: 20,
  tags: ['家常菜', '快手菜'],
  ingredients: [
    { name: '番茄', amount: '2个（约300g）' },
    { name: '鸡蛋', amount: '3个' },
  ],
  steps: ['番茄切块……', '热锅下油……'],
  nutrition: { caloriesKcal: 180, proteinG: 8, fatG: 10, carbG: 12, estimated: true },
  source: 'ai',
  createdAt: '2026-11-07T12:00:00.000Z',
  updatedAt: '2026-11-07T12:00:00.000Z',
}

describe('systemPromptWithLibrary 库摘要注入', () => {
  it('库摘要包含每道菜名称与食材', () =>
    expect(systemPromptWithLibrary([recipeFixture])).toContain('番茄炒蛋｜食材:番茄,鸡蛋'))
  it('空库提示为空', () => expect(systemPromptWithLibrary([])).toContain('菜谱库为空'))
  it('多道菜时每菜一行', () => {
    const other: Recipe = {
      ...recipeFixture,
      id: 'r-2',
      name: '青椒肉丝',
      ingredients: [
        { name: '青椒', amount: '200g' },
        { name: '猪肉', amount: '150g' },
      ],
    }
    const prompt = systemPromptWithLibrary([recipeFixture, other])
    expect(prompt).toContain('番茄炒蛋｜食材:番茄,鸡蛋')
    expect(prompt).toContain('青椒肉丝｜食材:青椒,猪肉')
  })
  it('菜谱库仅作防重复参考，不再要求优先推荐已有菜', () => {
    const prompt = systemPromptWithLibrary([recipeFixture])
    expect(prompt).toContain('不必优先推荐库中已有的菜')
    expect(prompt).toContain('有新意的搭配')
    expect(prompt).not.toContain('推荐时优先推荐菜谱库中已有的菜')
  })
})

describe('CHAT_MENU_FORMAT_RULE 食材用途规则', () => {
  it('允许食材自然合并成一道菜，不要求菜品数等于食材数', async () => {
    const { CHAT_MENU_FORMAT_RULE } = await import('./ai-prompts')
    // 明确取消「一种食材对应一道菜」的硬绑定
    expect(CHAT_MENU_FORMAT_RULE).not.toContain('dishes 的数量与用户给出的食材数量一致')
    expect(CHAT_MENU_FORMAT_RULE).toContain('可以合并')
    // 每种主要食材必须有用武之地
    expect(CHAT_MENU_FORMAT_RULE).toContain('每种主要食材都要体现')
    // 禁止为凑数硬拆
    expect(CHAT_MENU_FORMAT_RULE).toContain('不要为了凑数量')
    // 食材本身就是一道菜的完整搭配时，只推荐这一道
    expect(CHAT_MENU_FORMAT_RULE).toContain('本身就是一道菜的完整搭配')
    expect(CHAT_MENU_FORMAT_RULE).toContain('只推荐这一道')
  })

  it('规则要求「继续」只出新菜，且食材覆盖为次要偏好', async () => {
    const { CHAT_MENU_FORMAT_RULE } = await import('./ai-prompts')
    expect(CHAT_MENU_FORMAT_RULE).toContain('继续')
    // 第一约束：不重复已推荐
    expect(CHAT_MENU_FORMAT_RULE).toContain('不得重复')
    // 次要偏好：尚未用到的食材
    expect(CHAT_MENU_FORMAT_RULE).toContain('尚未用到')
    // 「就这些」时不再输出清单
    expect(CHAT_MENU_FORMAT_RULE).toContain('不再输出')
  })
})

describe('RECIPE_FORMAT_RULE 格式规则', () => {
  it('要求介绍文字后输出 <recipe> 包裹的完整 JSON', () => {
    expect(RECIPE_FORMAT_RULE).toContain('<recipe>')
    expect(RECIPE_FORMAT_RULE).toContain('</recipe>')
  })
  it('规则内嵌的番茄炒蛋示例可被提取且通过校验（与规格 5.3 一致）', () => {
    expect(extractRecipeJson(RECIPE_FORMAT_RULE)).toEqual(recipeFixture)
  })
  it('明确 source 恒为 ai、营养为估算值', () => {
    expect(RECIPE_FORMAT_RULE).toContain('"source":"ai"')
    expect(RECIPE_FORMAT_RULE).toContain('"estimated":true')
  })
})

describe('extractRecipeJson 三形态提取', () => {
  it('<recipe> 标签包裹', () =>
    expect(extractRecipeJson('好的！<recipe>' + JSON.stringify(recipeFixture) + '</recipe>')?.name).toBe('番茄炒蛋'))
  it('markdown 代码栅栏包裹（带 json 语言标记、多行）', () =>
    expect(
      extractRecipeJson('这是菜谱：\n```json\n' + JSON.stringify(recipeFixture, null, 2) + '\n```\n请慢用')?.name,
    ).toBe('番茄炒蛋'))
  it('代码栅栏无语言标记（裸 ```）', () =>
    expect(extractRecipeJson('```\n' + JSON.stringify(recipeFixture) + '\n```')?.name).toBe('番茄炒蛋'))
  it('前后杂文本包裹裸 JSON 不干扰', () =>
    expect(extractRecipeJson('好的，这是菜谱：' + JSON.stringify(recipeFixture) + ' 请慢用')?.name).toBe('番茄炒蛋'))
  it('优先级：<recipe> 标签先于栅栏与裸 JSON', () => {
    // 栅栏内与尾部放置缺字段的坏 JSON：若优先级错误会取到坏对象并返回 null
    const bad = JSON.stringify({ name: '坏对象' })
    const text = '<recipe>' + JSON.stringify(recipeFixture) + '</recipe>\n```json\n' + bad + '\n```\n' + bad
    expect(extractRecipeJson(text)?.id).toBe(recipeFixture.id)
  })
  it('字段缺失返回 null', () => expect(extractRecipeJson('<recipe>{"name":"x"}</recipe>')).toBeNull())
  it('文本中完全没有 JSON 返回 null', () => expect(extractRecipeJson('抱歉，我没有理解你的需求')).toBeNull())
  it('只有开标签没有 JSON 时返回 null', () => expect(extractRecipeJson('<recipe>对不起')).toBeNull())
})

describe('extractJson 通用提取', () => {
  it('自定义 parse 回调生效', () => {
    const parsed = extractJson<{ a: number }>('前缀 {"a":1} 后缀', s => {
      try {
        return JSON.parse(s) as { a: number }
      } catch {
        return null
      }
    })
    expect(parsed?.a).toBe(1)
  })
  it('parse 返回 null 时整体返回 null', () => expect(extractJson('{"a":1}', () => null)).toBeNull())
  it('字符串内含花括号/引号不破坏平衡扫描', () => {
    const tricky: Recipe = {
      ...recipeFixture,
      name: '怪"{}"名',
      steps: ['锅里放 "{" 焖 3 分钟', '撒 "盐}" 出锅'],
    }
    const out = extractRecipeJson('答案如下 ' + JSON.stringify(tricky) + ' 完毕')
    expect(out?.name).toBe('怪"{}"名')
    expect(out?.steps).toEqual(['锅里放 "{" 焖 3 分钟', '撒 "盐}" 出锅'])
  })
  it('嵌套对象（ingredients 数组、nutrition）花括号深度正确', () => {
    const out = extractRecipeJson('前缀 ' + JSON.stringify(recipeFixture) + ' 后缀')
    expect(out?.ingredients).toEqual(recipeFixture.ingredients)
    expect(out?.nutrition).toEqual(recipeFixture.nutrition)
  })
  it('未闭合的花括号返回 null', () => expect(extractJson<string>('{"a":1', () => 'x')).toBeNull())
})
