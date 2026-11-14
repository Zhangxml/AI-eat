# 多用户与按用户隔离的菜谱库

> 一句话：每个账号有独立的菜谱库与推荐风格；访问记录是全局审计、仅管理员可见。

## 为什么

第一版是单用户：`data/recipes/` 一个目录、所有人共用。多人共用一台车机/家庭服务器时，
「谁都能看到并改别人的菜谱」不可接受。改造为多租户后，隔离由**目录结构**保证，
而不是靠前端隐藏。

## 数据布局

```
data/
├── users.json                  # 账号表（scrypt 哈希，无明文）
├── .session-secret             # 会话签名密钥（0600，首次自动生成；可用 env.SESSION_SECRET 覆盖）
├── users/<uid>/
│   ├── recipes/*.json          # 该用户菜谱库
│   └── settings.json           # 该用户推荐风格
└── logs/access.jsonl           # 全局审计（每条带 user 字段；旧记录没有该字段）
```

用户 id 形如 `u-<8 位小写 hex>`。路径解析统一走 `src/lib/user-paths.ts`：
`recipesDirFor(userId)` / `settingsPathFor(userId)`。**禁止在路由里手拼 `data/users/...`**——
漏掉任何一条路径就是跨用户泄露。

## 鉴权

| 项 | 说明 |
| --- | --- |
| 密码存储 | `scrypt$N$r$p$salt$hash`（N=16384, r=8, p=1，16 字节随机盐），见 `src/lib/password-hash.ts` |
| 会话 token | `base64url({uid, ver, exp}) + '.' + HMAC-SHA256(载荷, SESSION_SECRET)` |
| 密钥 | 独立于用户口令；`env.SESSION_SECRET` 优先，否则自动生成写入 `data/.session-secret`（0600） |
| 失效 | 改密码/禁用时 `sessionVersion += 1` → 该用户所有旧 token 立即失效（无需轮换全局密钥） |
| Cookie | `HttpOnly; Path=/; SameSite=Lax; Max-Age=30d`，HTTPS 时加 `Secure` |
| 守卫 | `requireSession(req)` → `{ok, user}`；`requireAdmin` 额外要求 admin 角色 |

**旧模式兼容**：`data/users.json` 不存在时按「未迁移」处理——放行并返回合成的
`LEGACY_OWNER`（数据仍在 `data/recipes`），保证升级前功能不变。
**安全约束**：不允许删除最后一个用户（否则表变空会回落到旧模式、等于关掉鉴权）。

## 权限矩阵

| 能力 | member | admin |
| --- | --- | --- |
| 自己的菜谱增删改查 | 是 | 是 |
| 他人菜谱 | 404（不暴露存在性） | 404（管理员不越界到内容） |
| 自己的推荐风格 | 是 | 是 |
| 访问记录 | 403 | 是 |
| 用户管理 | 403 | 是 |
| 导出备份 | 自己的库 | 全部用户（`{users:[{name,recipes}]}`，不含凭据） |
| 导入备份 | 自己的库 | 自己的库（不支持灌入他人） |

管理员的能力限定在「账号 + 审计」，这是刻意的：避免管理员误删/误改他人菜谱这类不可逆事故。
**唯一例外**：`GET /api/backup` 管理员可整体导出所有用户的菜谱（用于整机备份/迁移），
但导出是只读的，且响应里不含任何凭据。

## 登录与初始化

- `GET /api/auth` → `{ needsSetup, enabled, currentUser? }`
- `POST /api/auth { username, password }` → 200 + Set-Cookie；失败统一 401「用户名或口令错误」
  （不区分用户名/密码错，防枚举；用户不存在时也跑一次等价 scrypt 校验，防时间侧信道）
- 无任何用户时，同一接口用于**初始化管理员**；若设置了 `env.PASSWORD`，必须先输该口令（防陌生人抢建号）
- 登录失败限流：同 (IP, 用户名) 连续失败 5 次后指数退避（1s→2s→4s…上限 60s，返回 429）
- `POST /api/auth/logout` → 204 清 Cookie

## 迁移

```bash
# 密码从 stdin 读，不进 shell history
read -r -s PW && printf '%s' "$PW" | node scripts/migrate-multi-user.mjs 爸爸
```

脚本行为：幂等（有 `users.json` 即退出）→ 整目录备份 → 建管理员 → 移动 `recipes/` 与 `settings.json`
到 `users/<uid>/` → 校验条数一致（不一致则中止）→ 输出账号与备份路径。

回滚：`rm -rf data && cp -a data.backup-<时间戳> data`（必须整目录替换——`cp -a .../. data/` 不会删除 `users.json`，等于没回滚）

## 已知边界

- AI 调用共用同一份服务端配置（一把 Key），多用户不隔离额度；如需配额需另做
- 管理员也不能读取/修改他人菜谱（见权限矩阵）
- 访问记录全局共享，不按用户过滤（审计的意义就是全局视角）
- 删除用户会连带删除 `data/users/<uid>/`，不可恢复（需输入用户名二次确认）
