// 用户表存储：data/users.json（与 recipe/settings 同受 data 卷保护）
// 设计要点（见 docs/superpowers/specs/2026-11-14-multi-user-design.md）：
// - 唯一事实来源：账号、角色、密码哈希、sessionVersion
// - 读取宽松：文件损坏/坏条目不应让整个应用崩，坏条目跳过、其余照常
// - 写入严格：原子写（复用 atomicWriteFile），名字唯一（大小写与首尾空白不敏感）
// - 路径安全：用户 id 只允许 u-<8位小写hex>，防「../」注入
import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { atomicWriteFile } from './atomic-write'

export type UserRole = 'admin' | 'member'

export interface User {
  id: string
  name: string
  role: UserRole
  /** scrypt 哈希串（见 password-hash.ts），绝不含明文 */
  passwordHash: string
  /** 会话版本：改密/禁用时 +1，使旧 token 立即失效 */
  sessionVersion: number
  disabled: boolean
  createdAt: string
  updatedAt: string
}

interface UsersFile {
  version: number
  users: User[]
}

const USERS_VERSION = 1
// id 生成：u-<8 位小写 hex>；格式化后便于人工识别，也便于路径安全校验
const USER_ID_RE = /^u-[0-9a-f]{8}$/

/** data 根目录：AI_EAT_DATA_DIR 指 data/recipes，故取其父目录 */
export function dataRoot(): string {
  const dir = process.env.AI_EAT_DATA_DIR
  return dir ? path.dirname(dir) : path.join(process.cwd(), 'data')
}

export function usersFilePath(): string {
  return path.join(dataRoot(), 'users.json')
}

/** 某用户的私有目录（含 recipes 子目录） */
export function userDir(userId: string): string {
  if (!USER_ID_RE.test(userId)) {
    // 防御：id 来自 token 或调用方，绝不允许拼出目录穿越路径
    throw new Error(`非法用户 id：${userId}`)
  }
  return path.join(dataRoot(), 'users', userId)
}

/** 某用户的菜谱目录 */
export function usersDirFor(userId: string): string {
  return path.join(userDir(userId), 'recipes')
}

/** 某用户的设置文件 */
export function userSettingsPath(userId: string): string {
  return path.join(userDir(userId), 'settings.json')
}

/** 逐字段校验：任一条目非法则丢弃（不让坏数据污染整表） */
function isValidUser(x: unknown): x is User {
  if (typeof x !== 'object' || x === null) return false
  const u = x as Record<string, unknown>
  return (
    typeof u.id === 'string' &&
    USER_ID_RE.test(u.id) &&
    typeof u.name === 'string' &&
    u.name.trim() !== '' &&
    (u.role === 'admin' || u.role === 'member') &&
    typeof u.passwordHash === 'string' &&
    u.passwordHash !== '' &&
    typeof u.sessionVersion === 'number' &&
    Number.isInteger(u.sessionVersion) &&
    u.sessionVersion >= 1 &&
    typeof u.disabled === 'boolean' &&
    typeof u.createdAt === 'string' &&
    typeof u.updatedAt === 'string'
  )
}

export type UsersFileState = 'missing' | 'ok' | 'corrupt'

/**
 * 读取用户表并区分三态（安全关键）：
 * - missing：文件不存在（可能是「从未迁移」）
 * - ok：文件存在且结构合法
 * - corrupt：文件存在但解析失败 / users 不是数组（**绝不**当作空表放行）
 * 为什么要区分：把 corrupt 当空表会让「表损坏」退化成「无鉴权 + 任何人可抢建 admin」。
 */
export async function readUsersFile(): Promise<{ state: UsersFileState; users: User[] }> {
  let raw: string
  try {
    raw = await fs.readFile(usersFilePath(), 'utf8')
  } catch (e) {
    // 只有 ENOENT 才算 missing；权限等其他错误按 corrupt（宁可拒服务，也不能放行）
    const code = (e as NodeJS.ErrnoException)?.code
    return { state: code === 'ENOENT' ? 'missing' : 'corrupt', users: [] }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { state: 'corrupt', users: [] }
  }
  const users = (parsed as Partial<UsersFile>)?.users
  if (!Array.isArray(users)) return { state: 'corrupt', users: [] }
  return { state: 'ok', users: users.filter(isValidUser) }
}

/**
 * 是否「已经进入多用户模式」——用 `data/users/` 目录作为迁移标记。
 * 迁移脚本与首次建号都会创建该目录，因此：
 * - 无 users.json 且无 users/ 目录 → 从未迁移（允许旧模式放行 + bootstrap）
 * - 有 users/ 目录但 users.json 缺失/损坏 → **已迁移但表坏了**（必须 fail-closed）
 */
export async function multiUserInitialized(): Promise<boolean> {
  const { state } = await readUsersFile()
  if (state !== 'missing') return true // ok 或 corrupt 都说明曾经写过
  try {
    const st = await fs.stat(path.join(dataRoot(), 'users'))
    return st.isDirectory()
  } catch {
    return false
  }
}

/** 读取全部用户（兼容旧调用点）；文件缺失/损坏 → 空数组。安全判定请用 readUsersFile/multiUserInitialized */
export async function listUsers(): Promise<User[]> {
  return (await readUsersFile()).users
}

/** 是否已启用多用户模式（有合法用户） */
export async function multiUserEnabled(): Promise<boolean> {
  return (await listUsers()).length > 0
}

export async function getUser(id: string): Promise<User | null> {
  if (!USER_ID_RE.test(id)) return null
  return (await listUsers()).find(u => u.id === id) ?? null
}

/** 按名字查找（大小写与首尾空白不敏感） */
export async function findUserByName(name: string): Promise<User | null> {
  const key = name.trim().toLowerCase()
  if (key === '') return null
  return (await listUsers()).find(u => u.name.trim().toLowerCase() === key) ?? null
}

function newUserId(): string {
  return `u-${randomBytes(4).toString('hex')}`
}

// 写盘串行队列：createUser/updateUser/deleteUser 都是「读-改-写」，
// 并发时后写会覆盖前写（实测并发建 8 个用户只落 4 个）。串行化后单实例内不丢更新。
let writeChain: Promise<void> = Promise.resolve()

async function writeAll(users: User[]): Promise<void> {
  const payload: UsersFile = { version: USERS_VERSION, users }
  const run = writeChain.catch(() => {}).then(async () => {
    // 每次写前确保 users/ 目录存在（同时作为「已初始化」标记）
    await fs.mkdir(path.join(dataRoot(), 'users'), { recursive: true })
    await atomicWriteFile(usersFilePath(), JSON.stringify(payload, null, 2) + '\n')
  })
  writeChain = run
  await run
}

// 长度上限：防止超长名字/密码把 users.json 撑大（每个请求都要 parse 它）
export const MAX_NAME_LEN = 32
export const MAX_PASSWORD_LEN = 128

/**
 * 创建用户。首个用户自动成为 admin。
 * 名字唯一（大小写/首尾空白不敏感）；重名抛错。
 */
export async function createUser(input: {
  name: string
  passwordHash: string
  role?: UserRole
}): Promise<User> {
  const name = input.name.trim()
  if (name === '') throw new Error('用户名不能为空')
  if (name.length > MAX_NAME_LEN) throw new Error(`用户名最长 ${MAX_NAME_LEN} 个字符`)
  if (input.passwordHash === '') throw new Error('密码哈希不能为空')

  const existing = await listUsers()
  if (existing.some(u => u.name.trim().toLowerCase() === name.toLowerCase())) {
    throw new Error(`用户名「${name}」已存在`)
  }
  const now = new Date().toISOString()
  const user: User = {
    id: newUserId(),
    name,
    role: input.role ?? (existing.length === 0 ? 'admin' : 'member'),
    passwordHash: input.passwordHash,
    sessionVersion: 1,
    disabled: false,
    createdAt: now,
    updatedAt: now,
  }
  await writeAll([...existing, user])
  return user
}

/** 局部更新；不存在则抛错。updatedAt 自动刷新。 */
export async function updateUser(
  id: string,
  patch: Partial<Pick<User, 'name' | 'passwordHash' | 'role' | 'disabled' | 'sessionVersion'>>,
): Promise<User> {
  const users = await listUsers()
  const idx = users.findIndex(u => u.id === id)
  if (idx === -1) throw new Error(`用户不存在：${id}`)

  // 改名需保持唯一
  if (patch.name !== undefined) {
    const name = patch.name.trim()
    if (name === '') throw new Error('用户名不能为空')
    if (name.length > MAX_NAME_LEN) throw new Error(`用户名最长 ${MAX_NAME_LEN} 个字符`)
    const dup = users.some(
      (u, i) => i !== idx && u.name.trim().toLowerCase() === name.toLowerCase(),
    )
    if (dup) throw new Error(`用户名「${name}」已存在`)
    patch = { ...patch, name }
  }

  const next: User = { ...users[idx], ...patch, updatedAt: new Date().toISOString() }
  users[idx] = next
  await writeAll(users)
  return next
}

/**
 * 删除用户（仅从表里移除；其数据目录由调用方决定是否清理）。
 * 安全约束：**不允许删掉最后一个用户**——表变空会让服务回落到「旧模式放行」，
 * 相当于把鉴权整个关掉。需要清空请直接维护 data/users.json。
 */
export async function deleteUser(id: string): Promise<void> {
  const users = await listUsers()
  if (!users.some(u => u.id === id)) throw new Error(`用户不存在：${id}`)
  const remaining = users.filter(u => u.id !== id)
  if (remaining.length === 0) {
    throw new Error('不能删除最后一个用户（会导致鉴权失效）')
  }
  await writeAll(remaining)
}

/** 当前表中的管理员数量（用于「不能删掉最后一个管理员」这类校验） */
export async function countAdmins(): Promise<number> {
  return (await listUsers()).filter(u => u.role === 'admin').length
}
