// 灵感种子：按档位给出「技法 + 风味」方向，注入推荐类提示词。
// - home（默认）：家常技法/风味，用户默认想要的就是好做的家常菜
// - creative：中式地方风味与特色技法，用户想换口味时用（**按需求已移除异国风味**）
// 纯函数 + 可注入随机源（与 makeRecipeId(now)/issueToken(now)/resolveTemperature(env) 的测试惯例一致）。
// 注意：仅用于「推荐/搭配」场景；用户明确指定菜名时必须严格遵照菜名（调用方在提示词措辞上约束）。

// 家常技法：家里灶台常做的
const HOME_TECHNIQUES = ['小炒', '炖煮', '清蒸', '凉拌', '红烧', '焖', '煎', '汆烫'] as const

// 创意技法：中式特色技法（换口味时用）
const CREATIVE_TECHNIQUES = ['干煸', '砂锅', '椒麻', '蒜香', '糖醋', '酱烧', '白灼', '锅塌'] as const

// 家常风味：偏下饭/清淡/快手
const HOME_STYLES = ['下饭', '清淡', '汤水足', '面食', '快手', '家常味'] as const

// 创意风味：中式地方风味（异国风味已按需求移除）
const CREATIVE_STYLES = ['川味', '粤式', '湘味', '江浙', '西北', '东北'] as const

export type InspirationStyle = 'home' | 'creative'

// 按档位取池子（结构化导出便于测试断言词池内容）
export const INSPIRATION_TECHNIQUES: Record<InspirationStyle, readonly string[]> = {
  home: HOME_TECHNIQUES,
  creative: CREATIVE_TECHNIQUES,
}

export const INSPIRATION_STYLES: Record<InspirationStyle, readonly string[]> = {
  home: HOME_STYLES,
  creative: CREATIVE_STYLES,
}

// 抽取下标：rng 返回值理论上 [0,1)，注入的 rng 可能给 1 或负数 → 收敛到合法范围，避免越界
function pickIndex(length: number, rng: () => number): number {
  const v = rng()
  const safe = Number.isFinite(v) ? Math.max(0, v) : 0
  return Math.min(length - 1, Math.floor(safe * length))
}

// 生成指定档位的灵感方向文案（每次调用随机；测试可注入固定 rng 断言）。
// 注意：style 必须显式传第一个参数（不传默认 'home'）；rng 永远是第二个参数
export function pickInspiration(style: InspirationStyle, rng: () => number = Math.random): string {
  const technique = INSPIRATION_TECHNIQUES[style][pickIndex(INSPIRATION_TECHNIQUES[style].length, rng)]
  const flavor = INSPIRATION_STYLES[style][pickIndex(INSPIRATION_STYLES[style].length, rng)]
  return `本次灵感方向：${technique} + ${flavor}`
}
