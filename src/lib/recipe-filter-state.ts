// 菜谱库筛选状态的前端纯逻辑（无 React / 无 IO，便于单测）：
// - reduceDimensions：分类 / 标签两个维度的状态变迁（页面 useReducer 使用，锁定"两维度互不牵连"）
// - resolveTagAfterCategoryChange：facets 返回后校正失效标签
// - describeFilters：空态文案的条件描述
// 背景（真实数据）：选定「荤菜」后标签行只显示荤菜里出现过的标签；若用户此前选了「清淡」
// （只在汤里出现），切到荤菜后该标签已从列表中消失——必须自动回退到「全部」，
// 否则会出现「选中的标签看不见、结果却仍然被它过滤」的幽灵状态。
// 无 React、无 IO，便于单测。

// 两个筛选维度的状态：null = 「全部」（该维度不筛选）
export interface DimensionState {
  category: string | null
  tag: string | null
}

export type DimensionAction =
  | { type: 'setCategory'; value: string | null }
  | { type: 'setTag'; value: string | null }
  | { type: 'syncFacetTags'; facetTags: readonly string[] }
  | { type: 'clear' }

export const initialDimensions: DimensionState = { category: null, tag: null }

/**
 * 两个维度的状态变迁。关键不变量（有测试锁定）：
 * - setCategory **绝不改动 tag**：两个维度互相独立、跨行取交集；
 *   切回「全部」时 facets.tags 变成全量，已选标签必然仍有效，没有清它的理由
 * - syncFacetTags 才允许清 tag（且仅当它已不在新 facets 里）
 */
export function reduceDimensions(state: DimensionState, action: DimensionAction): DimensionState {
  switch (action.type) {
    case 'setCategory':
      return { category: action.value, tag: state.tag }
    case 'setTag':
      return { category: state.category, tag: action.value }
    case 'syncFacetTags': {
      const nextTag = resolveTagAfterCategoryChange(action.facetTags, state.tag)
      return nextTag === state.tag ? state : { category: state.category, tag: nextTag }
    }
    case 'clear':
      return initialDimensions
  }
}

/**
 * 切换 category 后，返回应保留的 tag。
 * - 旧 tag 仍在新 facets.tags 里 → 保留
 * - 否则（含旧 tag 为 null）→ 返回 null（= 全部）
 */
export function resolveTagAfterCategoryChange(
  nextFacetTags: readonly string[],
  currentTag: string | null,
): string | null {
  if (currentTag === null) return null
  return nextFacetTags.includes(currentTag) ? currentTag : null
}

/**
 * 当前筛选条件的可读描述，用于空态文案（让用户知道是哪个组合导致空结果）。
 * 顺序固定为 分类 → 标签 → 搜索词；只描述实际生效的条件，全空时返回空数组。
 */
export function describeFilters(input: {
  q?: string
  category?: string | null
  tag?: string | null
}): string[] {
  const parts: string[] = []
  if (input.category) parts.push(`「${input.category}」`)
  if (input.tag) parts.push(`「${input.tag}」`)
  const q = input.q?.trim()
  if (q) parts.push(`「${q}」`)
  return parts
}
