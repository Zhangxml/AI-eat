// 全局设置的持久化：data/settings.json（与菜谱库 data/recipes 同级，同受 data 卷保护）
// - 读：文件缺失/损坏/字段非法 → 回落默认设置，绝不抛错（设置坏了不能把整个应用带崩）
// - 写：临时文件 + rename 原子替换，自动创建父目录
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { defaultSettings, validateSettings, type Settings } from './settings'

// 设置文件路径：AI_EAT_DATA_DIR 指向 data/recipes，故取其父目录下的 settings.json
export function settingsFilePath(): string {
  const dataDir = process.env.AI_EAT_DATA_DIR
    ? path.dirname(process.env.AI_EAT_DATA_DIR)
    : path.join(process.cwd(), 'data')
  return path.join(dataDir, 'settings.json')
}

// 读取设置：任何异常都回落默认值（返回新对象，调用方可安全修改）
export async function readSettings(): Promise<Settings> {
  try {
    const raw = await fs.readFile(settingsFilePath(), 'utf8')
    return validateSettings(JSON.parse(raw)) ?? defaultSettings()
  } catch {
    return defaultSettings()
  }
}

// 写入设置：原子替换，写失败向上抛（由 API 层映射 500）
export async function writeSettings(settings: Settings): Promise<void> {
  const file = settingsFilePath()
  const tmp = `${file}.tmp`
  try {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(tmp, JSON.stringify(settings, null, 2) + '\n', 'utf8')
    await fs.rename(tmp, file)
  } finally {
    // 成功时 tmp 已被 rename，rm 为 no-op；失败时清理残留
    await fs.rm(tmp, { force: true }).catch(() => {})
  }
}
