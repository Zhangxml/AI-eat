# 多用户与按用户隔离的菜谱库（设计）

> 日期：2026-11-14
> 状态：待批准（未动代码）
> 决策已定：方案 B（每人独立账号）；菜谱库隔离；推荐风格每用户；访问记录全局且仅管理员可见；导出「自己 / 管理员全部」；存量 22 道菜归第一个用户。

## 一、目标 / 非目标

**目标**

1. 多个独立账号：用户名 + 密码，登录后只能看到自己的菜谱库
2. 推荐风格（`home`/`creative`）按用户各自保存
3. 访问记录保持**全局**，仅管理员可查看
4. 备份导出：普通用户导自己的库；管理员可导出全部用户
5. 存量数据平滑迁移，第一个用户成为管理员并接管现有 22 道菜

**非目标（明确不做）**

- 不做邮箱/手机号、找回密码、邮箱验证
- 不做 2FA、OAuth/SSO、注册开放（**只有管理员能建号**）
- 不做按用户的 AI 配额/计费（见「九、已知风险」）
- 不做跨用户共享/协作菜谱
- 不做审计日志的按用户过滤（全局视角是审计的前提）

## 二、现状与改造面（已核实）

| 位置 | 现状 | 影响 |
| --- | --- | --- |
| `src/lib/auth.ts:40` | token 载荷 `{ exp }`，**无身份** | 必须加 `uid` |
| `src/lib/auth.ts:42` | HMAC 密钥 = `PASSWORD` 明文 | 多用户后不可用（服务端只存哈希，拿不到明文） |
| `src/lib/auth.ts` `requireAuth` | 返回 `Response \| null`（放行/拒绝） | 10 个路由**都拿不到 userId** |
| `recipe-store.ts:12` `recipesDir()` | 只读 `AI_EAT_DATA_DIR` | 无用户维度 |
| `settings-store.ts:10` | 单文件 `data/settings.json` | 需按用户 |
| `access-log.ts` | 全局 `data/logs/access.jsonl` | 保持全局，但需记录操作者 |
| 4 个 AI 路由 | `listRecipes()` 读全局库 | 必须改成读当前用户的库，否则会推荐别人家的菜 |
| `src/app/api/backup/route.ts` | 无用户概念 | 需按角色分流 |
| 10 个测试文件用 `AI_EAT_DATA_DIR` 注入隔离 | 单目录 | 需改成按 userId 注入 |
| `.env` 的 `PASSWORD` | 「非空即启用鉴权」 | 语义改为「引导口令」，仅用于创建首个管理员 |

## 三、数据模型

### 3.1 目录布局

```
data/
├── users.json                     # 账号表（唯一事实来源）
├── .session-secret                # 会话签名密钥，0600，首次运行自动生成
├── users/
│   ├── u-<8hex>/                  # 每用户独立目录
│   │   ├── recipes/*.json         # 该用户的菜谱库（复用现有 recipe-store）
│   │   └── settings.json          # 该用户的推荐风格
│   └── u-<8hex>/...
└── logs/access.jsonl              # 全局审计日志（不按用户分片）
```

**为什么用 `users/<uid>/` 而不是 `recipes-<uid>/`**：一个用户将来还会有更多私有数据（设置、可能的收藏/历史），按用户分目录更自然；同时 `data/logs` 与 `data/users` 同级，审计天然全局。

### 3.2 `users.json`

```jsonc
{
  "version": 1,
  "users": [
    {
      "id": "u-a1b2c3d4",           // 路径安全：仅 [a-z0-9-]
      "name": "爸爸",                // 显示名，唯一（大小写不敏感去重）
      "role": "admin",              // admin | member
      "passwordHash": "scrypt$16384$8$1$<salt-b64>$<hash-b64>",
      "sessionVersion": 1,          // 改密码/禁用时 +1 → 旧 token 立即失效
      "disabled": false,
      "createdAt": "2026-11-14T00:00:00.000Z",
      "updatedAt": "2026-11-14T00:00:00.000Z"
    }
  ]
}
```

- **密码哈希用 `scrypt`**（Node 内置 `crypto.scrypt`，零依赖）：`N=16384, r=8, p=1, keylen=64`，16 字节随机盐
- 写入前用 `atomicWriteFile`（已有，随机临时名）
- 读取用「逐字段容错」策略（与 settings 一致）：坏条目跳过并记日志，不让整表失效
- **不存任何明文密码**

## 四、鉴权协议变更

### 4.1 会话 token

```
payload = base64url({ uid, ver, exp })      // ver = 用户的 sessionVersion
token   = payload + "." + hex(HMAC-SHA256(payload, SESSION_SECRET))
```

- **密钥来源**：优先 `env.SESSION_SECRET`；未设置则首次运行生成 32 字节随机值写入 `data/.session-secret`（0600）。**不再用密码当密钥**
- 校验顺序：验签 → 过期 → 用户存在 → `disabled === false` → `ver === user.sessionVersion`
  - 改密码 / 禁用账号 → `sessionVersion += 1` → **该用户所有旧会话立即失效**，无需轮换全局密钥
- Cookie 属性不变（`HttpOnly; Path=/; SameSite=Lax; Max-Age=30d`，HTTPS 时加 `Secure`）

### 4.2 守卫改造（影响 10 个路由）

`requireAuth` 从「返回 Response | null」改为：

```ts
// 返回 { ok: true, user } 或 { ok: false, res }
export function requireSession(req: Request): SessionResult
```

路由首行从：

```ts
const denied = requireAuth(req); if (denied) return denied
```

改为：

```ts
const auth = requireSession(req); if (!auth.ok) return auth.res
const { user } = auth            // 后续所有数据访问都带 user.id
```

> 保留 `requireAuth` 作为薄包装（内部调用 `requireSession`）以减少一次性大改的风险；但**新代码一律用 `requireSession`**。

### 4.3 登录接口

| 接口 | 变更 |
| --- | --- |
| `POST /api/auth` | body 由 `{ password }` → `{ username, password }`；失败统一 `401 { error: '用户名或口令错误' }`（不区分哪一项错） |
| `GET /api/auth` | 返回 `{ needsSetup: boolean, enabled: boolean, currentUser?: { name, role } }` |
| `POST /api/auth/logout`（新增） | 清 Cookie |

### 4.4 首次启动引导（bootstrap）

无 `users.json` 时，`/login` 显示「初始化管理员」表单（用户名 + 密码 + 确认密码）。

**防抢占**：若 `env.PASSWORD` 非空，创建首个管理员时必须先输入该口令（沿用现有配置，无需新变量）；若未设置，则允许直接创建并打一条警告日志（等同当前「无鉴权」状态，不引入新风险）。

创建成功后 `PASSWORD` 即无用途，可从 `.env` 删除（文档注明）。

## 五、权限矩阵

| 能力 | member | admin |
| --- | --- | --- |
| 增删改查自己的菜谱 | ✅ | ✅ |
| 查看别人的菜谱 | ❌ 404（不暴露存在性） | ❌ **也不给**（管理员也不该顺手改别人菜谱） |
| 自己的推荐风格 | ✅ | ✅ |
| 访问记录 `/access-logs` | ❌ 403 | ✅ |
| 用户管理（建号/改密/禁用/删除） | ❌ | ✅ |
| 导出备份 | 自己的库 | 全部用户（按用户分组） |
| 导入备份 | 自己的库 | 自己的库（v1 不支持导入到他人，见「待确认」） |
| 删除菜单（`DELETE_PASSWORD`） | 全局同一口令 | 同 |

**为什么管理员也看不到别人菜谱**：避免「管理员误删/误改他人数据」这类不可逆事故；管理员的能力限定在「账号与审计」，不越界到内容。

## 六、API 契约变更清单

| 路由 | 变更 |
| --- | --- |
| `/api/auth` | 见 4.3 |
| `/api/recipes`（GET/POST） | 用 `user.id` 定位目录 |
| `/api/recipes/[id]`（GET/PUT/DELETE） | 同上；**跨用户访问返回 404**（不返回 403，避免探测他人 id 是否存在） |
| `/api/settings`（GET/PATCH） | 读写 `users/<uid>/settings.json` |
| `/api/config` | 不变（部署级只读）；admin 额外暴露 `userCount` |
| `/api/backup` GET | member：自己；admin：`{ users: [{ name, recipes }] }` 全部 |
| `/api/backup` POST | 只导入到自己的库 |
| `/api/access-logs` | **仅 admin**，member 403；日志条目新增可选 `user` 字段 |
| `/api/ai/{chat,menu,recipes,nutrition}` | 库摘要改为读**当前用户**的库 |
| `/api/users`（新增，仅 admin） | `GET` 列表 / `POST` 建号 / `PATCH :id` 改密·改名·禁用 / `DELETE :id` 删号（连带删数据，二次确认） |

**日志格式兼容**：`AccessLogEntry` 新增 `user?: string`（可选）。旧记录没有该字段，读取端必须容忍（现有解析已按可选对象处理，需补一条单测）。

## 七、前端变更

| 页面 | 变更 |
| --- | --- |
| `/login` | 加用户名输入；无用户时切换为「初始化管理员」模式 |
| `/settings` | 顶部显示当前账号（名字 + 角色）；**admin 才显示**「用户管理」与「访问记录」入口；「推荐风格」读写自己的 |
| `/access-logs` | 仅 admin 可进；列表新增「操作者」列 |
| `/recipes`、`/dishes`、`/` | 无需改动（数据来自接口，天然隔离） |
| 退出登录 | 设置页底部（或账号卡片内）加「退出登录」 |

## 八、数据迁移

### 8.1 迁移步骤（一次性脚本 `scripts/migrate-multi-user.mjs`）

```
1. 预检：data/users.json 已存在？→ 已是新结构，直接退出（幂等）
2. 备份：cp -a data data.backup-<时间戳>     ← 失败即中止
3. 生成 admin：从 argv 取用户名，密码从 stdin 读（不回显、不进日志）
4. mkdir -p data/users/<uid>/recipes
5. mv data/recipes/*.json → data/users/<uid>/recipes/     （保留原 id）
6. mv data/settings.json → data/users/<uid>/settings.json  （不存在则用默认）
7. 写 users.json（role=admin，sessionVersion=1）
8. 校验：迁移后菜谱数 == 迁移前菜谱数（不等则中止并提示从备份恢复）
9. 输出：账号名、uid、迁移条数、备份路径
```

**回滚**：`cp -a data.backup-<ts> data`（文档写明，脚本不改任何非 `data/` 内容，回滚只需还原目录）。

### 8.2 兼容期策略

- 若 `data/users.json` 不存在 → 服务以**旧模式**运行（单用户、无鉴权），但设置页显示醒目提示「尚未创建账号，数据未隔离」
- 一旦创建首个管理员 → 立即进入多用户模式，旧的 `data/recipes/` 若仍存在则**不再读取**（避免双份数据源）

## 九、已知风险与缓解

| 风险 | 严重度 | 缓解 |
| --- | --- | --- |
| **跨用户数据泄露**（漏改某条读写路径） | **高** | 所有数据访问统一走 `recipesDirFor(userId)`，**禁止**在路由里手拼路径；加一条「跨用户访问必须 404」的端到端测试 |
| 密码哈希被离线爆破 | 中 | scrypt（内存硬）+ 每用户独立盐 |
| 无登录失败限流（现存问题） | 中 | **建议一并做**：同 IP + 同用户名连续失败 5 次后指数退避（本次范围内可选，见待确认） |
| AI 共用一把 Key，多用户放大成本 | 中 | 本次不做配额；文档写明「多用户共用同一 AI 配置」 |
| `SESSION_SECRET` 丢失/误删 | 低 | 丢失 = 所有人需重新登录（不丢数据）；`.session-secret` 与 `data/` 同卷持久化 |
| 迁移中途失败 | 中 | 先整目录备份 + 步骤 8 校验；失败可从备份整目录还原 |
| 升级后行为变化（PASSWORD 失效） | 中 | 文档 + 迁移脚本输出明确说明；`PASSWORD` 仅作引导口令 |
| 删号误操作 | 中 | 默认「禁用」优先；「删除」需输入该用户名二次确认，并提示数据将一并删除 |

## 十、测试计划

**新增单测**

1. `password-hash`：哈希/校验、错误密码、盐随机性、格式非法时返回 false
2. `user-store`：CRUD、名字唯一（大小写不敏感）、坏条目容错、原子写、路径安全（id 非法拒绝）
3. `session`：token 含 uid 与 ver；改密码后旧 token 失效；禁用后失效；过期；篡改签名
4. `权限`：member 访问 `/api/access-logs` → 403；member 访问他人菜谱 → 404；非 admin 调 `/api/users` → 403
5. `迁移`：给定旧目录结构，迁移后数量一致、幂等（重复执行不重复迁移）

**改造既有测试**

- 10 个用 `AI_EAT_DATA_DIR` 注入的文件 → 改成注入「临时 data 根 + 预置 users.json」的辅助函数
- `auth.test.ts` / `auth/api.test.ts` 重写（契约已变）
- backup 测试补「member 只导自己」「admin 导全部」

**端到端（浏览器实测）**

- 两个账号交叉验证：A 建菜谱 → B 看不到（列表 + 直接访问 id）
- B 的推荐风格改成 creative → A 仍是 home
- member 登录后设置页无「用户管理」「访问记录」入口
- admin 看得到访问记录，member 看不到
- 改密码后另一台设备的旧会话立刻失效

## 十一、工作量

| 模块 | 预估 |
| --- | --- |
| `password-hash.ts` + `user-store.ts` | ~180 行 |
| `auth.ts` 重构（session/守卫） | ~120 行 |
| `/api/users` 路由 + 用户管理 UI | ~180 行 |
| 10 个路由改用 `requireSession` + 按用户取目录 | ~120 行 |
| 登录页 / 设置页 / 访问记录页改造 | ~150 行 |
| 迁移脚本 | ~80 行 |
| 测试（新增 + 改造 10 文件） | ~300 行 |
| **合计** | **约 1100 行** |

## 十二、实施顺序（分 4 个可独立验收的批次）

1. **地基**：`password-hash` + `user-store` + `session`（含单测，不影响现有功能）
2. **鉴权切换**：`requireSession` + 10 路由改按用户取目录 + 登录页（此时功能等价单用户，但已按 uid 分区）
3. **隔离与权限**：跨用户 404、`/api/users`、访问记录限 admin、备份按角色分流、设置页用户管理
4. **迁移与收尾**：迁移脚本 + 文档 + 端到端验收

每批都跑 `tsc` / 全量测试 / build / eslint，且批次 2、3 前后各做一次浏览器端交叉验证。

## 十三、需要你确认的 4 点

1. **`DELETE_PASSWORD` 保持全局，还是也改成每用户？**（我建议保持全局——它是「防误删」的第二道闸，多用户后逐人配置反而更难记）
2. **登录失败限流是否纳入本次？**（我建议纳入：现在完全没有，多用户后每个账号都是独立攻击面）
3. **管理员是否需要「导出全部用户」时能看到每个用户的名字？**（我建议：导出结构形如 `{ exportedAt, users: [{ name, recipes }] }`，仅名字不含任何凭据）
4. **删除用户时默认策略**：`禁用`（保留数据，可随时恢复）优先，`删除`（连同 `users/<uid>/` 一并删）需二次确认——认可吗？
