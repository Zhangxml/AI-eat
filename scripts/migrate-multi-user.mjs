#!/usr/bin/env node
// 一次性迁移脚本：单用户 → 多用户（见 docs/superpowers/specs/2026-11-14-multi-user-design.md）
//
// 用法（在项目根目录）：
//   node scripts/migrate-multi-user.mjs <管理员用户名>
//   密码从 stdin 读入（不回显、不进日志、不进 shell history）：
//     read -r -s PW && printf '%s' "$PW" | node scripts/migrate-multi-user.mjs 爸爸
//
// 行为：
// 1. 幂等：data/users.json 已存在 → 直接退出（不重复迁移）
// 2. 先整目录备份 data → data.backup-<时间戳>
// 3. 建管理员（scrypt 哈希）→ 把 data/recipes/*.json 与 data/settings.json 移入 data/users/<uid>/
// 4. 校验迁移前后菜谱条数一致，不一致则中止并提示从备份恢复
// 5. 可回滚：cp -a data.backup-<ts>/. data/
//
// 不触碰 data/ 之外的任何文件。
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomBytes, scrypt } from 'node:crypto'
import { createInterface } from 'node:readline'

const ROOT = process.cwd()
const DATA = path.join(ROOT, 'data')
const RECIPES = path.join(DATA, 'recipes')
const SETTINGS = path.join(DATA, 'settings.json')
const USERS_FILE = path.join(DATA, 'users.json')

function die(msg, code = 1) {
  console.error(`\n❌ ${msg}\n`)
  process.exit(code)
}

function log(msg) {
  console.log(msg)
}

// 与 src/lib/password-hash.ts 保持一致的参数与格式
const SCRYPT_N = 16384
const SCRYPT_R = 8
const SCRYPT_P = 1
const KEY_LEN = 64
const SALT_LEN = 16
const MAX_MEM = 64 * 1024 * 1024

function deriveKey(password, salt) {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      KEY_LEN,
      { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: MAX_MEM },
      (err, key) => (err ? reject(err) : resolve(key)),
    )
  })
}

async function hashPassword(password) {
  const salt = randomBytes(SALT_LEN)
  const key = await deriveKey(password, salt)
  return ['scrypt', SCRYPT_N, SCRYPT_R, SCRYPT_P, salt.toString('base64'), key.toString('base64')].join('$')
}

/** 从 stdin 读密码（不回显）；非 TTY（管道）时直接读一行 */
function readPassword() {
  return new Promise(resolve => {
    if (!process.stdin.isTTY) {
      let buf = ''
      process.stdin.setEncoding('utf8')
      process.stdin.on('data', c => {
        buf += c
      })
      process.stdin.on('end', () => resolve(buf.replace(/\r?\n$/, '')))
      return
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    // 遮罩输入：拦截内部写入，只保留提示与回车
    const onWrite = rl._writeToOutput?.bind(rl)
    rl._writeToOutput = function (str) {
      if (str.includes('\n') || str.includes('\r')) onWrite?.(str)
    }
    process.stdout.write('管理员密码（输入不回显）：')
    rl.question('', answer => {
      rl.close()
      process.stdout.write('\n')
      resolve(answer)
    })
  })
}

async function exists(p) {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

async function countRecipes(dir) {
  try {
    const entries = await fs.readdir(dir)
    return entries.filter(f => f.endsWith('.json')).length
  } catch {
    return 0
  }
}

async function main() {
  const name = (process.argv[2] ?? '').trim()
  if (name === '') {
    die('用法：node scripts/migrate-multi-user.mjs <管理员用户名>\n密码从 stdin 读入')
  }

  // 1. 幂等检查
  if (await exists(USERS_FILE)) {
    log('✅ data/users.json 已存在，已经是多用户结构，无需迁移。')
    return
  }
  if (!(await exists(DATA))) {
    die('找不到 data/ 目录。请在项目根目录执行，或先启动一次服务让它生成 data/。')
  }
  // 预检：data/users/ 已存在 → 上一次迁移可能中途失败。此时若继续，
  // 会把「上一轮已移走的菜谱」当成孤儿永久漏掉（校验也发现不了）。
  const usersDir = path.join(DATA, 'users')
  if (await exists(usersDir)) {
    const left = await fs.readdir(usersDir).catch(() => [])
    if (left.length > 0) {
      die(
        '检测到 data/users/ 已存在且非空——可能上次迁移中断。\n' +
          '请先人工确认并处理（例如从备份恢复后重试）：\n' +
          '  rm -rf data && cp -a data.backup-<时间戳> data',
      )
    }
  }

  // 2. 统计并备份
  const beforeCount = await countRecipes(RECIPES)
  const stamp = new Date()
    .toISOString()
    .replace(/[-:T]/g, '')
    .slice(0, 14)
  const backup = path.join(ROOT, `data.backup-${stamp}`)
  await fs.cp(DATA, backup, { recursive: true })
  log(`📦 已备份：${path.relative(ROOT, backup)}（迁移前菜谱 ${beforeCount} 条）`)

  // 3. 读密码
  const password = await readPassword()
  if (password.length < 4) {
    die('密码至少 4 位。已备份，未做任何修改。')
  }

  // 4. 建管理员
  const uid = `u-${randomBytes(4).toString('hex')}`
  const now = new Date().toISOString()
  const user = {
    id: uid,
    name,
    role: 'admin',
    passwordHash: await hashPassword(password),
    sessionVersion: 1,
    disabled: false,
    createdAt: now,
    updatedAt: now,
  }

  const userDir = path.join(DATA, 'users', uid)
  const userRecipes = path.join(userDir, 'recipes')
  const userSettings = path.join(userDir, 'settings.json')
  await fs.mkdir(userRecipes, { recursive: true })

  // 5. 迁移菜谱：**复制 → 校验 → 再删源**
  // 为什么不用 rename：rename 中途失败会留下「一半在新位置、一半在旧位置」的分裂状态，
  // 且重跑时校验规则（只看 data/recipes 残留）会误判通过。
  let moved = 0
  const sourceFiles = (await exists(RECIPES))
    ? (await fs.readdir(RECIPES)).filter(f => f.endsWith('.json'))
    : []
  for (const f of sourceFiles) {
    await fs.copyFile(path.join(RECIPES, f), path.join(userRecipes, f))
    moved++
  }
  // 复制后先验条数，再删源
  const copiedCount = await countRecipes(userRecipes)
  if (copiedCount !== sourceFiles.length) {
    die(
      `复制校验失败：源 ${sourceFiles.length} 条，复制后 ${copiedCount} 条。\n` +
        '未删除任何源文件。请检查磁盘空间后重试。',
    )
  }
  for (const f of sourceFiles) {
    await fs.rm(path.join(RECIPES, f), { force: true })
  }
  // 6. 迁移设置（不存在则写默认，保证该用户有稳定默认）
  if (await exists(SETTINGS)) {
    await fs.rename(SETTINGS, userSettings)
  } else {
    await fs.writeFile(userSettings, JSON.stringify({ version: 1, style: 'home' }, null, 2) + '\n', 'utf8')
  }

  // 7. 写 users.json（原子：先写 tmp 再 rename）
  const payload = { version: 1, users: [user] }
  const tmp = `${USERS_FILE}.tmp`
  await fs.writeFile(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf8')
  await fs.rename(tmp, USERS_FILE)

  // 8. 校验三方一致：备份条数 == 新目录条数，且旧目录已清空
  const backupCount = await countRecipes(path.join(backup, 'recipes'))
  const afterCount = await countRecipes(userRecipes)
  const leftover = await countRecipes(RECIPES)
  if (afterCount !== backupCount || leftover !== 0) {
    // 失败时删除刚写的 users.json，避免幂等分支把现场锁死
    await fs.rm(USERS_FILE, { force: true })
    die(
      `校验失败：备份 ${backupCount} 条 / 迁移后 ${afterCount} 条 / 旧目录残留 ${leftover} 条。\n` +
        `已删除 users.json 以便重试。\n` +
        `完整回滚：rm -rf data && cp -a ${path.relative(ROOT, backup)} data`,
    )
  }

  log('')
  log('✅ 迁移完成')
  log(`   管理员：${name}`)
  log(`   用户 id：${uid}`)
  log(`   迁移菜谱：${moved} 条（校验通过：${afterCount}/${beforeCount}）`)
  log(`   备份目录：${path.relative(ROOT, backup)}`)
  log('')
  log('下一步：')
  log('   1. 重启服务（./run.sh restart）')
  log('   2. 用该用户名 + 密码登录（.env 里的 PASSWORD 已不再用于日常登录，可删除）')
  log(`   3. 回滚：rm -rf data && cp -a ${path.relative(ROOT, backup)} data`)
}

main().catch(e => die(e instanceof Error ? e.message : String(e)))
