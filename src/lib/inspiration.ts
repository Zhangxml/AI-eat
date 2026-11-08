// 灵感种子：每请求随机给出「技法 + 风味」方向，注入推荐类提示词，缓解「同食材总出同几道菜」。
// 纯函数 + 可注入随机源（与 makeRecipeId(now)/issueToken(now)/resolveTemperature(env) 的测试惯例一致）。
// 注意：仅用于「推荐/搭配」场景；用户明确指定菜名时必须严格遵照菜名（调用方在提示词措辞上约束）。
export const INSPIRATION_TECHNIQUES = [
  '干煸',
  '红烧',
  '清蒸',
  '砂锅',
  '椒麻',
  '蒜香',
  '香煎',
  '凉拌',
  '汤羹',
  '炭烤',
] as const

export const INSPIRATION_STYLES = [
  '川味',
  '粤式',
  '湘味',
  '江浙',
  '西北',
  '东南亚',
  '日式',
  '意式',
  '家常',
  '融合',
] as const

// 抽取下标：rng 返回值理论上 [0,1)，注入的 rng 可能给 1 → 收敛到末尾，避免越界
function pickIndex(length: number, rng: () => number): number {
  const v = rng()
  const safe = Number.isFinite(v) ? v : 0
  return Math.min(length - 1, Math.floor(safe * length))
}

// 生成本次灵感方向文案（每次调用随机；测试可注入固定 rng 断言）
export function pickInspiration(rng: () => number = Math.random): string {
  const technique = INSPIRATION_TECHNIQUES[pickIndex(INSPIRATION_TECHNIQUES.length, rng)]
  const style = INSPIRATION_STYLES[pickIndex(INSPIRATION_STYLES.length, rng)]
  return `本次灵感方向：${technique} + ${style}`
}
