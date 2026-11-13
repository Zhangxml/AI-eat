// 菜谱库筛选状态的前端纯逻辑单测
// 覆盖：切分类后旧标签是否失效（自动回退「全部」）、空态文案的条件描述
import { describe, expect, it } from 'vitest'
import {
  describeFilters,
  initialDimensions,
  reduceDimensions,
  resolveTagAfterCategoryChange,
} from './recipe-filter-state'

describe('resolveTagAfterCategoryChange 切换分类后标签是否保留', () => {
  it('旧标签仍在新 facets 中 → 保留', () => {
    expect(resolveTagAfterCategoryChange(['家常菜', '下饭菜'], '家常菜')).toBe('家常菜')
  })

  it('旧标签不在新 facets 中 → 回退 null（全部）', () => {
    // 真实场景：选「清淡」（汤里有）后切到「荤菜」，清淡已不在 facets
    expect(resolveTagAfterCategoryChange(['家常菜', '下饭菜'], '清淡')).toBeNull()
  })

  it('旧标签为 null（本来就是全部）→ 保持 null', () => {
    expect(resolveTagAfterCategoryChange(['家常菜'], null)).toBeNull()
  })

  it('新 facets 为空数组 → 任何旧标签都回退 null', () => {
    expect(resolveTagAfterCategoryChange([], '家常菜')).toBeNull()
    expect(resolveTagAfterCategoryChange([], null)).toBeNull()
  })
})

describe('describeFilters 空态文案的条件描述', () => {
  it('分类 + 标签 + 搜索词都有 → 三项按分类、标签、搜索词顺序', () => {
    expect(describeFilters({ q: '番茄', category: '主食', tag: '下饭菜' })).toEqual([
      '「主食」',
      '「下饭菜」',
      '「番茄」',
    ])
  })

  it('只有分类 → 只描述分类', () => {
    expect(describeFilters({ category: '汤' })).toEqual(['「汤」'])
  })

  it('全部为空 / null → 返回空数组（调用方据此用「库为空」文案）', () => {
    expect(describeFilters({})).toEqual([])
    expect(describeFilters({ q: '', category: null, tag: null })).toEqual([])
    expect(describeFilters({ q: '   ', category: null, tag: null })).toEqual([])
  })

  it('搜索词两端空白被裁掉', () => {
    expect(describeFilters({ q: '  番茄  ' })).toEqual(['「番茄」'])
  })
})

describe('reduceDimensions 两维度的状态变迁', () => {
  it('setCategory 只改分类，**不动标签**（跨行独立，切回「全部」也不清标签）', () => {
    const withTag = { category: '荤菜', tag: '下饭菜' }
    // 切到另一个分类：标签必须保留（新分类下若无效，由 syncFacetTags 负责）
    expect(reduceDimensions(withTag, { type: 'setCategory', value: '汤' })).toEqual({
      category: '汤',
      tag: '下饭菜',
    })
    // 切回「全部」：标签同样保留——facets.tags 会变成全量，已选标签必然仍有效
    expect(reduceDimensions(withTag, { type: 'setCategory', value: null })).toEqual({
      category: null,
      tag: '下饭菜',
    })
  })

  it('setTag 只改标签，不动分类', () => {
    expect(
      reduceDimensions({ category: '荤菜', tag: null }, { type: 'setTag', value: '家常菜' }),
    ).toEqual({ category: '荤菜', tag: '家常菜' })
  })

  it('syncFacetTags：标签仍在新 facets 中 → 保留', () => {
    const s = { category: '荤菜', tag: '家常菜' }
    expect(reduceDimensions(s, { type: 'syncFacetTags', facetTags: ['家常菜', '下饭菜'] })).toBe(s)
  })

  it('syncFacetTags：标签已不在新 facets 中 → 回退「全部」', () => {
    expect(
      reduceDimensions({ category: '主食', tag: '下饭菜' }, { type: 'syncFacetTags', facetTags: ['快手菜'] }),
    ).toEqual({ category: '主食', tag: null })
  })

  it('syncFacetTags：状态无变化时返回同一个对象引用（避免多余重渲染）', () => {
    const s = { category: null, tag: null }
    expect(reduceDimensions(s, { type: 'syncFacetTags', facetTags: ['家常菜'] })).toBe(s)
  })

  it('clear：两个维度都回「全部」', () => {
    expect(reduceDimensions({ category: '汤', tag: '清淡' }, { type: 'clear' })).toEqual(
      initialDimensions,
    )
  })
})
