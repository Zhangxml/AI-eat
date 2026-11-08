// AI 温度分层（创意度控制）：按调用场景给不同 temperature，环境变量可覆盖。
// 依据：审计/对标分析——菜谱 0.7 稳定出结构、营养 0.5 求准确、点菜菜单 0.8 略偏创意；
// 问问AI 聊天固定 0.7（同一端点可能直出菜谱，需保护 JSON 解析成功率），创意主要靠提示词+灵感种子。
// 取值统一 clamp 到 [0,1]：DeepSeek 支持 [0,2]、GLM 支持 [0,1]，收敛到交集后两端都合法。
export type TemperatureKind = 'chat' | 'menu' | 'recipe' | 'nutrition'

export const DEFAULT_TEMPERATURES: Record<TemperatureKind, number> = {
  chat: 0.7,
  menu: 0.8,
  recipe: 0.7,
  nutrition: 0.5,
}

// 每个场景对应的环境变量名（可选覆盖；非法值回落默认，不阻断启动）
const ENV_KEYS: Record<TemperatureKind, string> = {
  chat: 'AI_TEMP_CHAT',
  menu: 'AI_TEMP_MENU',
  recipe: 'AI_TEMP_RECIPE',
  nutrition: 'AI_TEMP_NUTRITION',
}

// 温度收敛到 [0,1]；非有限数返回 0（调用方只在有限数时才会走到这里）
export function clampTemperature(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

// 解析某场景的最终温度：环境变量优先（空串/非数字视为未设置），否则默认值
export function resolveTemperature(kind: TemperatureKind, env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[ENV_KEYS[kind]]
  if (raw !== undefined && raw.trim() !== '') {
    const n = Number(raw)
    if (Number.isFinite(n)) return clampTemperature(n)
  }
  return DEFAULT_TEMPERATURES[kind]
}
