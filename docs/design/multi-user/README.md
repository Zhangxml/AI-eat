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

## 运行模式（由 `env.PASSWORD` 决定）

`PASSWORD` 是进程环境变量：生产环境只能在**启动时**设置（改 `.env` 后必须重启）。
代码每次请求都读 `process.env.PASSWORD`——所以测试里改 env 会立即生效，`next dev` 热重载 `.env` 也会切换模式；
生产上不存在这种热切换。

| `PASSWORD` | 模式 | 谁可以进 |
| --- | --- | --- |
| 空 | **免密单用户**（版本一兼容） | 管理员，唯一身份，无需密码 |
| 非空 | **密码模式** | 管理员用 `PASSWORD`；其他用户用各自账号密码 |

### 免密单用户（`PASSWORD` 空）

- 首次运行（无 `users.json` 且无 `users/`）自动创建用户名为 **`管理员`** 的账号，
  并接管旧数据（复制 → 逐个校验 → 删源 → 写 `.legacy-adopted` 标记）；
- 所有请求都以**最早创建的管理员**身份处理，不需要 Cookie；
- **其他账号不可登录，但数据完整保留**（不改 `disabled`、不删目录、不删表条目）；
  这是运行时判定，不是把账号标记为禁用——所以设置 `PASSWORD` 后它们会直接恢复；
- 用户管理**界面与 API 全部关闭**（`/api/users*` → 409），界面保持版本一的样子；
- `/login` 直接跳回首页；「访问鉴权」显示「未启用（免密单用户）」；
- `users.json` 损坏 / 没有任何管理员 → 503（fail-closed）。

### 密码模式（`PASSWORD` 非空）

- 管理员：登录页用户名预填**第一个管理员的名字**（禁止改名，所以稳定），密码就是 `PASSWORD`；
  `users.json` 里管理员的 `passwordHash` **不参与校验**（env 唯一）；
- 管理员**不能改名、不能改密**（密码由 env 控制）、不能禁用/删除；
- 其他用户：走各自 `users.json` 里的 scrypt 密码，`disabled` 照常拒绝；
- 未初始化 → 页面 303 到 `/login`，用 `PASSWORD` 作为初始化密码建号。

### 模式切换

| 切换 | 行为 |
| --- | --- |
| 空 → 非空（设置并重启） | 管理员开始需要 `PASSWORD`；被冻结的成员恢复可登录，数据原样 |
| 非空 → 空（清空并重启） | 回到免密；成员再次冻结，数据保留 |

### 鉴权基础

| 项 | 说明 |
| --- | --- |
| 密码存储 | `scrypt$N$r$p$salt$hash`（N=16384, r=8, p=1，16 字节随机盐），见 `src/lib/password-hash.ts` |
| 会话 token | `base64url({uid, ver, exp}) + '.' + HMAC-SHA256(载荷, SESSION_SECRET)` |
| 密钥 | 独立于用户口令；`env.SESSION_SECRET` 优先，否则自动生成写入 `data/.session-secret`（0600） |
| 失效 | 改密码/禁用时 `sessionVersion += 1` → 该用户所有旧 token 立即失效（无需轮换全局密钥） |
| Cookie | `HttpOnly; Path=/; SameSite=Lax; Max-Age=30d`，HTTPS 时加 `Secure` |
| 守卫 | `requireSession(req)` → `{ok, user}`；`requireAdmin` 额外要求 admin 角色 |

**安全约束**：不允许删除最后一个用户；管理员账号一律不可禁用/删除。

> 免密模式意味着**同一台设备/局域网内的任何人都以管理员身份操作**（可看全部菜谱、删用户、读审计）。
> 这与第一版单用户行为一致；需要区分家人时，设置 `PASSWORD` 并重启。

## 权限矩阵

| 能力 | member | admin |
| --- | --- | --- |
| 自己的菜谱增删改查 | 是 | 是 |
| 他人菜谱 | 404（不暴露存在性） | 404（管理员不越界到内容） |
| 自己的推荐风格 | 是 | 是 |
| 访问记录 | 403 | 是 |
| 用户管理 | 403 | 是 |
| 管理员账号被禁用/删除 | — | **一律禁止**（UI 按钮置灰，服务端 400） |
| 导出备份 | 自己的库 | 全部用户（`{users:[{name,recipes}]}`，不含凭据） |
| 导入备份 | 自己的库 | 自己的库（不支持灌入他人） |

管理员的能力限定在「账号 + 审计」，这是刻意的：避免管理员误删/误改他人菜谱这类不可逆事故。

**管理员账号本身不可禁用、不可删除**（不只是「最后一个管理员」）：管理员掌握账号与审计权限，
一旦禁用或删除且无人可恢复，等于把整站锁死。确需移除某个管理员，只能先把它降级为普通成员
（角色降级仍受「不能降级最后一个管理员」约束）。
**唯一例外**：`GET /api/backup` 管理员可整体导出所有用户的菜谱（用于整机备份/迁移），
但导出是只读的，且响应里不含任何凭据。

## 页面守卫（middleware）

未登录、或会话已失效时，由 `src/middleware.ts` 在**服务端**直接 303 到 `/login?next=<原路径>`，
页面根本不会下发。

为什么不用客户端跳转：页面是客户端组件，`Link` 软导航会先把整页骨架渲染出来，
数据请求拿到 401 后才整页跳走——实测会闪完整骨架（注入 300ms 延迟时约 600ms）。
服务端拦截后为 0 帧。

**跑在 Node runtime**（`export const config = { runtime: 'nodejs' }`，Next 15.5 起稳定）：
判定「会话是否还有效」必须读 `data/users.json`，Edge runtime 没有文件系统。
早期版本跑在 Edge、只能验签，于是「被禁用/改密/删除」的人旧 token 签名依然合法 →
middleware 放行 → 骨架渲染 → API 401 才跳（实测复现）。
也考虑过 Edge + 回调自身 `/api/auth/session`，但 `req.nextUrl.origin` 的协议取自
`X-Forwarded-Proto`，TLS 反代下会变成 `https://…` 导致自调用失败、静默退化为放行——故弃用。

判定直接复用 `requireSession`，与各 API 路由**同一份代码**，不可能分叉：

| 情况 | 行为 |
| --- | --- |
| 未登录（无 Cookie / 签名不对 / 已过期） | 303 到 `/login?next=<原路径>` |
| 用户被禁用 / 已删除 / 改密后 `sessionVersion` 不符 | 同样 303（这是「禁用后还会闪」的根因，Node runtime 才判得了） |
| 用户表损坏或为空（503） | **放行**，让页面把「请从备份恢复」的错误显示出来；跳登录页只会更困惑 |
| 旧模式（从未初始化） | 放行（内置管理员 + 全局 `data/`），需要多用户时去 `/login` 建号 |

口径与边界：

| 项 | 说明 |
| --- | --- |
| 客户端路由缓存 | `next.config.ts` 里 `experimental.staleTimes = { static: 0, dynamic: 0 }`。静态页的预取 payload 默认缓存 5 分钟，禁用后用**禁用前**的缓存仍会画出骨架（注入 300ms 时实测 37 帧）；设为 0 后每次导航都向服务端确认，实测 0 帧。代价是每次 tab 切换多一个 RTT（局域网约 10ms） |
| `/login` | 永远放行，否则重定向循环 |
| matcher | 排除 `api/`、`_next/`、`__nextjs`、静态后缀（含 json/webmanifest/字体），避免误拦 RSC 与开发工具 |
| `runtime` 写法 | 必须写成字面量 `{ runtime: 'nodejs' }`；加 `as const` 会让 Next 的静态解析取不到 runtime，退回 Edge 并在构建时报 `node:fs` 无法打包 |
| 回跳 | 登录页用 `safeNextPath` 校验：反斜杠/协议相对/绝对 URL/`javascript:` 一律回落首页（防开放重定向） |
| 登录成功 | 用 `window.location.replace` 而非 `router.replace`——后者会复用「未登录→307」的客户端路由缓存，又被弹回登录页（已实测） |
| 单测 | `src/middleware.test.ts` 覆盖：无 Cookie / 有效 / 伪造 / 过期 / 禁用 / 改密 / 用户表损坏 / 旧模式 / `next` 参数 |
| 硬约束 1：不要加 `loading.tsx` | 当前 0 帧成立的前提是页面在导航期间**保持旧内容**、等 303 到达后整页跳走。若给 `/recipes`、`/settings` 等加 `loading.tsx`，客户端会在 303 之前先渲染 loading 骨架 → 被吊销用户重新看到闪一下 |
| 硬约束 2：反代不要缓存页面壳 | 预渲染页带 `Cache-Control: s-maxage=31536000` 且无 `Vary: Cookie`。浏览器不吃它，但若在 Nginx/CDN 开了共享缓存，命中缓存的请求根本不进 Next、middleware 不执行 → 又会看到壳。要么直连，要么反代对页面路由设 `proxy_no_cache` / 加 `Vary: Cookie` |
| 部署冒烟 | `./run.sh status` 只看端口。部署后请实际验证「无 Cookie 访问 `/recipes` 必须 303」——`functions-config-manifest.json` 缺失时 Next 15.5.6 会启动失败且报错难懂（`Cannot read properties of undefined (reading '/_middleware')`） |

## 登录与初始化

- `GET /api/auth` → `{ needsSetup, enabled, passwordless?, defaultUsername?, currentUser? }`
- `POST /api/auth { username, password }` → 200 + Set-Cookie
  - 凭据错误：401「用户名或口令错误」（不区分用户名/密码错，防枚举；用户不存在时也跑一次等价 scrypt 校验，防时间侧信道）
  - 并发/重复初始化：409「已初始化：请直接登录」（只有一个请求能建出管理员）
  - 用户表损坏或为空：503「请从备份恢复 data/users.json 后重试」（不要报成密码错）
  - 触发限流：429（带需等待秒数）
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

> 与「建号自动接管」的关系：两者都能完成迁移。**若已通过网页建号**，旧数据已被自动接管，
> 此时再跑脚本会幂等退出（正常）；**若想先备份再迁移**，则先跑脚本、再启动服务。

**建号自动接管的可重试语义**（`src/lib/legacy-migration.ts`）：

| 场景 | 行为 |
| --- | --- |
| 源目录不存在 | 视为无旧数据，只给该用户写默认 `settings.json` |
| 目标已有部分文件（上次复制中途失败） | **按文件补齐**：目标已有的跳过、缺的复制；不会因为“目标非空”而锁死 |
| 复制后逐个校验 | 缺任何一个文件就抛错、不删源、不写完成标记 |
| 全部成功 | 删源 → 写 `.legacy-adopted` 完成标记（下次调用短路） |
| 源目录不可读（EACCES 等） | 抛错（建号返回 500），不会被当成“没有旧数据”静默成功 |
| `AI_EAT_DATA_DIR` 指向 `data/` 根或 `users/<uid>/` | 直接拒绝（防止把 `users.json` 当菜谱搬走、或搬空别人的库） |

回滚：`rm -rf data && cp -a data.backup-<时间戳> data`（必须整目录替换——`cp -a .../. data/` 不会删除 `users.json`，等于没回滚）

## 已知边界

- AI 调用共用同一份服务端配置（一把 Key），多用户不隔离额度；如需配额需另做
- 管理员也不能读取/修改他人菜谱（见权限矩阵）
- 访问记录全局共享，不按用户过滤（审计的意义就是全局视角）
- 删除用户会连带删除 `data/users/<uid>/`，不可恢复（需输入用户名二次确认）
- 删除顺序是 **rename 数据目录 → 删账号 → 删目录**：目录挪不动时返回 500、账号保留（可重试）；
  账号删除失败会把目录改名回来，不会出现「数据没了、账号还在」
- 登出只清 Cookie，**不吊销 token**：被窃取的 token 在 30 天有效期内仍可用（应急请改密或禁用该账号）
- 用户表的写串行化是**进程内** Promise 队列（`user-store.ts`）。当前部署是单容器单进程，足够；
  若将来多副本/多 worker 共享同一个 data 卷，需要换成文件锁或数据库，否则仍会丢更新
