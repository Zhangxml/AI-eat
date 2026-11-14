// 与鉴权相关的常量（单独成文件，避免 auth.ts ↔ user-paths.ts 的循环依赖）
/** 旧模式（尚未迁移）下代表唯一使用者的合成 id；数据目录回落到全局 data/recipes */
export const LEGACY_OWNER_ID = 'legacy-owner'
