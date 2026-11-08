// 全局用户设置：schema + 默认值 + 合并（唯一事实来源）
// 设计要点（评估已确认）：
// - data/settings.json 持久化，带 version 便于未来迁移
// - 未知键一律拒绝（PATCH 传错键要报 400，不静默吞）
// - 缺字段用默认值补齐；损坏文件读取层回落默认
import { z } from 'zod'

export const SETTINGS_VERSION = 1

// 推荐风格：home=经典家常（默认）/ creative=中式创意换口味
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

// 校验任意对象为完整设置（读取文件时用）；失败返回 null
export function validateSettings(input: unknown): Settings | null {
  const parsed = settingsSchema.safeParse(input)
  return parsed.success ? parsed.data : null
}

// 校验 PATCH 体；失败返回 null
export function validateSettingsPatch(input: unknown): SettingsPatch | null {
  const parsed = settingsPatchSchema.safeParse(input)
  return parsed.success ? parsed.data : null
}
