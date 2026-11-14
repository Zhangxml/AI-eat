// 全局用户设置：schema + 默认值 + 合并（唯一事实来源）
// 设计要点（评估已确认）：
// - 持久化在 data/users/<uid>/settings.json（旧模式回落到 data/settings.json），带 version 便于迁移
// - 未知键一律拒绝（PATCH 传错键要报 400，不静默吞）
// - 缺字段用默认值补齐；损坏文件读取层回落默认
import { z } from 'zod'

export const SETTINGS_VERSION = 1

// 推荐风格：home=湖北家常（默认）/ creative=外省中式创意换口味
export const STYLE_VALUES = ['home', 'creative'] as const
export type RecommendationStyle = (typeof STYLE_VALUES)[number]

// 完整设置 schema（strict：未知键报错）
export const settingsSchema = z
  .object({
    version: z.number().int().positive(),
    style: z.enum(STYLE_VALUES),
  })
  .strict()

export type Settings = z.infer<typeof settingsSchema>

// PATCH 用的局部 schema：只允许改用户可写字段，version 由服务端维护
export const settingsPatchSchema = z
  .object({
    style: z.enum(STYLE_VALUES).optional(),
  })
  .strict()

export type SettingsPatch = z.infer<typeof settingsPatchSchema>

// 默认设置（文件缺失/损坏时的回落值）
export function defaultSettings(): Settings {
  return { version: SETTINGS_VERSION, style: 'home' }
}

// 合并：默认值 ← 文件值 ← PATCH 值；version 恒为当前版本
export function mergeSettings(base: Settings, patch: SettingsPatch): Settings {
  const next: Settings = { ...base }
  if (patch.style !== undefined) next.style = patch.style
  next.version = SETTINGS_VERSION
  return next
}

// 解析设置文件（宽松：Postel 原则——写入严格、读取宽容）
// 为什么不全有或全无：以后加设置项时，老文件必然缺新字段；若整体校验失败就回落默认，
// 用户已调好的项会被静默重置。这里逐字段容错——
// - 缺字段 / 多余的未知键 / 未来版本多写的字段 → 忽略，认得的值全部保留
// - 字段值非法 / 非对象 / 数组 / null → 该字段回落默认
// - version 恒由服务端维护，不采信文件里的值（手工改坏也不会影响迁移判断）
export function parseSettingsFile(input: unknown): Settings {
  const base = defaultSettings()
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return base
  const b = input as Record<string, unknown>
  const style =
    typeof b.style === 'string' && (STYLE_VALUES as readonly string[]).includes(b.style)
      ? (b.style as RecommendationStyle)
      : base.style
  return { version: SETTINGS_VERSION, style }
}

// 校验 PATCH 体；失败返回 null
export function validateSettingsPatch(input: unknown): SettingsPatch | null {
  const parsed = settingsPatchSchema.safeParse(input)
  return parsed.success ? parsed.data : null
}
