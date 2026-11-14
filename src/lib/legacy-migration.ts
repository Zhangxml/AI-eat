// 首次建号时「接管旧数据」：把单用户时代的 data/recipes 与 data/settings.json
// 搬进 data/users/<uid>/ 下。
//
// 为什么需要：多用户上线后页面统一要求登录，用户第一次打开会看到「初始化管理员」，
// 文案承诺「将接收现有菜谱库」。若只是建号而不搬数据，用户会看到一个空库，
// 且迁移脚本因 users.json 已存在而幂等跳过——迁移路径被彻底锁死。
//
// 安全做法（与 scripts/migrate-multi-user.mjs 一致）：复制 → 校验 → 再删源。
// 任一步失败都保留源文件；成功后才写 `.legacy-adopted` 标记。
//
// 为什么要标记而不是「目标非空即完成」：复制到一半失败时目标已有残片，
// 若按「非空即完成」判断，剩余文件永远不会补齐（实测：源 3 个、目标 1 个，重试直接返回 0）。
// 这里按文件补齐，并用标记记录「已完整接管」，两者结合才能安全重试。
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { recipesDir } from './recipe-store'
import { dataRoot, userDir, userSettingsPath, usersDirFor } from './user-store'

export interface AdoptResult {
  /** 本次新搬过来的菜谱条数（0 表示没有可搬的、或此前已完整接管） */
  migrated: number
  /** 是否写了默认设置文件 */
  wroteDefaultSettings: boolean
}

/** 完成标记：只在「复制 + 校验 + 删源」全部成功后写，避免半迁移被误判为已完成 */
const MARKER = '.legacy-adopted'
/** 旧全局设置文件（与 data/recipes 同级） */
const LEGACY_SETTINGS = 'settings.json'

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

/**
 * 列出目录里的菜谱 json。
 * **只有 ENOENT（目录不存在）才视为空**；EACCES/EIO 等必须上抛——
 * 否则「源目录不可读」会被当成「没有旧数据」，建号返回成功、用户看到空库。
 */
async function listJsonFiles(dir: string): Promise<string[]> {
  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw e
  }
  return entries.filter(f => f.endsWith('.json') && !f.startsWith('.'))
}

/**
 * 校验 AI_EAT_DATA_DIR 指向的确实是「菜谱库目录」，而不是 data 根或某个用户的私有目录。
 *
 * 为什么不能只判断目录名必须叫 `recipes`：`AI_EAT_DATA_DIR` 的语义是「菜谱库目录」，
 * 允许用户自定义名字（如 `mydishes`）；按名字硬校验会让合法配置在首次建号时直接 500。
 *
 * 改为按**内容 + 路径结构**判定，并用 realpath 解析符号链接：
 * - 误配成 data 根时（`recipes -> .` 的符号链接同理），目录里会有 users.json / users/ / logs；
 *   不挡住的话 users.json 会因后缀是 .json 被当菜谱复制并删除，整站随即 503
 * - 误配成 `users/<uid>/recipes` 时会把别人的库搬走并清空
 */
async function assertSourceIsRecipesDir(sourceDir: string): Promise<void> {
  // realpath：把 `data/recipes -> .` 这类符号链接解析成真实路径后再判断
  const src = await fs.realpath(sourceDir).catch(() => path.resolve(sourceDir))

  let entries: string[]
  try {
    entries = await fs.readdir(src)
  } catch (e) {
    // 目录不存在 = 全新部署、没有旧数据，交给调用方按空源处理
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return
    throw e
  }

  if (entries.includes('users.json') || entries.includes('users') || entries.includes('logs')) {
    throw new Error(
      `AI_EAT_DATA_DIR 配置错误：${sourceDir} 看起来是 data 根目录，应指向其中的菜谱库目录（如 <data>/recipes）`,
    )
  }

  // <data>/users/<uid>/recipes：父目录是用户 id，说明指向了某个用户的私有库
  const parent = path.basename(path.dirname(src))
  if (/^u-[0-9a-f]{8}$/.test(parent)) {
    throw new Error(
      `AI_EAT_DATA_DIR 配置错误：${sourceDir} 位于用户私有目录下，会搬走其他用户的菜谱`,
    )
  }
}

/**
 * 把旧全局目录的数据接管给指定用户。
 * 幂等：已写过完成标记时直接返回；否则按文件补齐（目标已有的跳过、缺的复制）。
 * uid 非法会抛错（userDir 内部校验，防目录穿越）。
 */
export async function adoptLegacyData(userId: string): Promise<AdoptResult> {
  // 先校验 uid（userDir 会抛错）——必须在任何文件操作之前
  const targetRecipes = usersDirFor(userId)
  const targetSettings = userSettingsPath(userId)
  const markerPath = path.join(userDir(userId), MARKER)

  const sourceDir = recipesDir()
  // 源目录校验也在任何写操作之前：配置错了就拒绝，不要先把目标目录建出来
  await assertSourceIsRecipesDir(sourceDir)

  // 确保用户目录与其 recipes 子目录都存在（userDir 同时充当「已初始化」标记）
  await fs.mkdir(targetRecipes, { recursive: true })

  // 已完整接管过：短路（不覆盖、不删源）
  if (await pathExists(markerPath)) {
    return { migrated: 0, wroteDefaultSettings: false }
  }

  const sourceFiles = await listJsonFiles(sourceDir)
  // 按文件补齐：只复制目标缺少的，避免重试时重复复制、也避免覆盖目标已有内容
  const existing = new Set(await listJsonFiles(targetRecipes))
  const toCopy = sourceFiles.filter(f => !existing.has(f))
  for (const f of toCopy) {
    // 先写临时文件再 rename：避免上次进程被杀留下「半截但同名」的 json 被当成已完成，
    // 否则重试会因为「名字都在」而校验通过、随后删掉好数据，留下坏文件
    const dest = path.join(targetRecipes, f)
    const tmp = `${dest}.tmp-${process.pid}-${Date.now()}`
    await fs.copyFile(path.join(sourceDir, f), tmp)
    await fs.rename(tmp, dest)
  }

  // 校验：目标必须包含源里的每一个文件（不只是「条数相等」）
  const after = new Set(await listJsonFiles(targetRecipes))
  const missing = sourceFiles.filter(f => !after.has(f))
  if (missing.length > 0) {
    throw new Error(
      `接管旧数据失败：${missing.length} 个文件未复制成功（${missing.slice(0, 3).join('、')}${
        missing.length > 3 ? ' 等' : ''
      }），源文件未删除`,
    )
  }

  // 设置：只在目标还没有设置文件时处理
  let wroteDefaultSettings = false
  if (!(await pathExists(targetSettings))) {
    const legacySettings = path.join(dataRoot(), LEGACY_SETTINGS)
    if (await pathExists(legacySettings)) {
      // 复制成功即算接管成功；删源失败不影响目标（旧文件残留无害，下次也不会再读它）
      await fs.copyFile(legacySettings, targetSettings)
      await fs.rm(legacySettings, { force: true }).catch(() => {})
    } else {
      await fs.mkdir(path.dirname(targetSettings), { recursive: true })
      await fs.writeFile(
        targetSettings,
        JSON.stringify({ version: 1, style: 'home' }, null, 2) + '\n',
        'utf8',
      )
      wroteDefaultSettings = true
    }
  }

  // 校验通过后才删源
  for (const f of sourceFiles) {
    await fs.rm(path.join(sourceDir, f), { force: true })
  }

  // 最后写完成标记：中途失败不会误标完成，下次仍会按文件补齐
  await fs.writeFile(markerPath, new Date().toISOString() + '\n', 'utf8')

  return { migrated: toCopy.length, wroteDefaultSettings }
}
