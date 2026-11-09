// 灵感种子：按档位给出「技法 + 风味」方向，注入推荐类提示词。
// - home（默认）：**湖北家常**——粉蒸/煨汤/腊味/藕与鱼鲜，咸鲜微辣（用户人在湖北，本地食材可购）
// - creative：外省中式地方风味与特色技法（川/粤/湘/江浙/西北/东北），用户想换口味时用
//   （**按需求已移除异国风味**）
// 纯函数 + 可注入随机源（与 makeRecipeId(now)/issueToken(now)/resolveTemperature(env) 的测试惯例一致）。
// 注意：仅用于「推荐/搭配」场景；用户明确指定菜名时必须严格遵照菜名（调用方在提示词措辞上约束）。
import type { RecommendationStyle } from './settings'

// 湖北家常技法：湖北灶台上真正高频的——粉蒸（沔阳三蒸一路）、煨汤（排骨藕汤/瓦罐鸡汤）、
// 腊味（腊肉炒菜薹）、干炕（干炕土豆/炕豆腐/炕豆丝）、蒸菜（天门蒸菜）。
// 刻意剔除「炖煮/焖/煎/汆烫」这类过于中性的词：实测它们不产生地域倾向，
// 换不掉「番茄炒蛋/青椒肉丝」的默认输出（基线测得的湖北特征命中率只有 9%）。
const HOME_TECHNIQUES = ['粉蒸', '煨汤', '腊味', '干炕', '蒸菜', '红烧', '小炒', '凉拌'] as const

// 创意技法：外省中式特色技法（换口味时用）
const CREATIVE_TECHNIQUES = ['干煸', '砂锅', '椒麻', '蒜香', '糖醋', '酱烧', '白灼', '锅塌'] as const

// 湖北家常风味：咸鲜、微辣（湖北是微辣不是重辣）、腊香、湖鲜（千湖之省）、汤水足、酱香。
// 与创意池零重叠，保证**注入的灵感方向**不混入外省风味词（模型自由生成的正文不受词池约束）。
const HOME_STYLES = ['咸鲜', '微辣', '腊香', '湖鲜', '汤水足', '酱香'] as const

// 创意风味：中式地方风味（异国风味已按需求移除）
const CREATIVE_STYLES = ['川味', '粤式', '湘味', '江浙', '西北', '东北'] as const

// 档位类型唯一事实来源在 settings.ts（STYLE_VALUES）；用 import type 零运行时依赖，
// 避免此处与设置层各写一份枚举、加档位时只改一处漏改另一处
export type InspirationStyle = RecommendationStyle

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
// 注意：style 是必填的第一个参数（调用方必须显式传 'home' | 'creative'，不传会因取不到词池而报错）；
// rng 永远是第二个参数
export function pickInspiration(style: InspirationStyle, rng: () => number = Math.random): string {
  const technique = INSPIRATION_TECHNIQUES[style][pickIndex(INSPIRATION_TECHNIQUES[style].length, rng)]
  const flavor = INSPIRATION_STYLES[style][pickIndex(INSPIRATION_STYLES[style].length, rng)]
  return `本次灵感方向：${technique} + ${flavor}`
}
