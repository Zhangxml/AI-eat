// 首次建号时「接管旧数据」：把单用户时代的 data/recipes 与 data/settings.json
// 搬进 data/users/<uid>/ 下。
//
// 为什么需要：多用户上线后页面统一要求登录，用户第一次打开会看到「初始化管理员」，
// 文案承诺「将接收现有菜谱库」。若只是建号而不搬数据，用户会看到一个空库，
// 且迁移脚本因 users.json 已存在而幂等跳过——迁移路径被彻底锁死。
//
// 安全做法（与 scripts/migrate-multi-user.mjs 一致）：复制 → 校验条数 → 再删源。
// 任一步失败都保留源文件，不产生「一半在新位置、一半在旧位置」的分裂。
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { recipesDir } from './recipe-store'
import { dataRoot, userSettingsPath, usersDirFor } from './user-store'

export interface AdoptResult {
  /** 搬过来的菜谱条数（0 表示没有可搬的旧数据，或目标已有数据） */
  migrated: number
  /** 是否写了默认设置文件 */
  wroteDefaultSettings: boolean
}

async function listJsonFiles(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir)
    return entries.filter(f => f.endsWith('.json'))
  } catch {
    return []
  }
}

/**
 * 把旧全局目录的数据接管给指定用户。
 * 幂等：目标目录已有 .json 文件时直接返回（不覆盖、不删源）。
 * uid 非法会抛错（userDir 内部校验，防目录穿越）。
 */
export async function adoptLegacyData(userId: string): Promise<AdoptResult> {
  // 先校验 uid（userDir 会抛错）——必须在任何文件操作之前
  const targetRecipes = usersDirFor(userId)
  const targetSettings = userSettingsPath(userId)
  // 确保用户目录与其 recipes 子目录都存在（userDir 同时充当「已初始化」标记）
  await fs.mkdir(targetRecipes, { recursive: true })

  // 目标已有数据：视为已接管过，什么都不做（幂等，且绝不覆盖用户现有数据）
  const existingTarget = await listJsonFiles(targetRecipes)
  if (existingTarget.length > 0) {
    return { migrated: 0, wroteDefaultSettings: false }
  }

  const sourceDir = recipesDir()
  // 源与目标可能是同一个目录（旧模式下 LEGACY_OWNER 就用 data/recipes，但那里 uid 是 u-xxx，不会相同）
  const sourceFiles = sourceDir === targetRecipes ? [] : await listJsonFiles(sourceDir)

  if (sourceFiles.length === 0) {
    // 没有旧菜谱：至少给该用户写一份默认设置，保证后续读取稳定
    let wroteDefaultSettings = false
    try {
      await fs.access(targetSettings)
    } catch {
      await fs.mkdir(path.dirname(targetSettings), { recursive: true })
      await fs.writeFile(targetSettings, JSON.stringify({ version: 1, style: 'home' }, null, 2) + '\n', 'utf8')
      wroteDefaultSettings = true
    }
    return { migrated: 0, wroteDefaultSettings }
  }

  // 1) 复制
  for (const f of sourceFiles) {
    await fs.copyFile(path.join(sourceDir, f), path.join(targetRecipes, f))
  }
  // 2) 校验条数（不一致就中止，不清源）
  const copied = await listJsonFiles(targetRecipes)
  if (copied.length !== sourceFiles.length) {
    throw new Error(
      `接管旧数据失败：源 ${sourceFiles.length} 条，复制后 ${copied.length} 条（源文件未删除）`,
    )
  }

  // 3) 迁移设置（存在则搬，不存在则写默认）
  let wroteDefaultSettings = false
  const legacySettings = path.join(dataRoot(), 'settings.json')
  try {
    await fs.copyFile(legacySettings, targetSettings)
    await fs.rm(legacySettings, { force: true })
  } catch {
    await fs.writeFile(targetSettings, JSON.stringify({ version: 1, style: 'home' }, null, 2) + '\n', 'utf8')
    wroteDefaultSettings = true
  }

  // 4) 校验通过后才删源
  for (const f of sourceFiles) {
    await fs.rm(path.join(sourceDir, f), { force: true })
  }

  return { migrated: copied.length, wroteDefaultSettings }
}
