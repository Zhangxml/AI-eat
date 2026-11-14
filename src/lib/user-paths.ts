// 按用户解析数据路径的唯一入口（多用户隔离的关键收口）。
// 为什么单独一个模块：**所有**读写都必须经过这里，禁止在路由里手拼 `data/users/...`——
// 漏掉任何一条路径就是跨用户数据泄露，这是本改造最高风险的失效点。
// 该函数有单测锁定「多用户模式下绝不返回旧全局目录」。
import { LEGACY_OWNER_ID } from './auth-constants'
import { recipesDir } from './recipe-store'
import { settingsFilePath } from './settings-store'
import { userSettingsPath, usersDirFor } from './user-store'

/** 该用户的菜谱目录：旧模式用全局 data/recipes，多用户模式用 data/users/<uid>/recipes */
export function recipesDirFor(userId: string): string {
  if (userId === LEGACY_OWNER_ID) return recipesDir()
  return usersDirFor(userId)
}

/** 该用户的设置文件：LEGACY_OWNER 回落到 data/settings.json（历史兼容），其余用 data/users/<uid>/settings.json */
export function settingsPathFor(userId: string): string {
  if (userId === LEGACY_OWNER_ID) return settingsFilePath()
  return userSettingsPath(userId)
}
