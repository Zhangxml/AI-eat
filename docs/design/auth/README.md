# 模块：鉴权（PASSWORD 登录 + 删除保护）+ 访问记录

> 代码位置：`src/lib/auth.ts`（会话与口令）、`src/lib/access-log.ts`（访问日志）、
> `src/app/api/auth/route.ts`（登录接口）、`src/app/login/page.tsx`（登录页）、
> `src/app/api/config/route.ts`（开关状态）、`src/lib/api-fetch.ts`（前端 401 处理）、
> `src/app/api/access-logs/route.ts`（日志读取）、`src/app/access-logs/page.tsx`（访问记录列表页）
> 守卫范围：/api/recipes*、/api/ai/*、/api/backup、/api/config、/api/access-logs

## 做什么

两层可选的访问控制，全部通过环境变量启用，**不设即关闭**（局域网信任边界，自用默认推荐）：

| 层 | 环境变量 | 保护什么 |
| --- | --- | --- |
| **访问鉴权** | `PASSWORD` | 整站读写：未登录访问任何受保护接口 → 401，前端跳登录页 |
| **删除保护** | `DELETE_ENABLED=true` + `DELETE_PASSWORD` | 仅删除操作：删菜谱必须携带正确密码 → 403 拒绝 |

另有 `TRUST_PROXY=true`（可选）：仅在前置反向代理可信时设置。默认（直连部署）取 `x-forwarded-for` **末段**（Next 注入的真实对端，链首可能是客户端伪造值）；设为 `true` 时取**首段**（代理写入的真实客户端 IP）。详见「访问记录」一节。

## 怎么做的

### 登录会话（PASSWORD 层）

```
登录：POST /api/auth { password } ──verifyPassword 恒时比较──►
  ✓ 200 + Set-Cookie: ai-eat-session=<token>; HttpOnly; Path=/; SameSite=Lax; Max-Age=2592000
  ✗ 401 { error: '口令错误' }

token = base64url({exp: now+30天}) + '.' + hex(HMAC-SHA256(payload, key=PASSWORD))
```

- **守卫**：每个受保护 handler 首行 `const denied = requireAuth(req); if (denied) return denied`——未启用 PASSWORD 时返回 null 放行（零摩擦）；启用且 Cookie 无效返回 401 `{error:'请先登录'}`
- **Secure 标记按 `x-forwarded-proto` 首段推导**（http→无 Secure、https→有），**绝不从 req.url 判断**——纯 HTTP 局域网直连登录不被 Secure 卡死（借鉴 LibreTV 验证过的关键坑；缺失该头→无 Secure，有回归测试锁定）
- 时序安全：`verifyPassword` 与 `isValidToken` 均在长度不等时先短路（timingSafeEqual 对不等长输入 throw），各有「不 throw」测试；签名侧期望值恒为 64 位 hex，长度比较不泄漏秘密
- 验签：单 `.` 结构校验→恒时验签→通过才解 payload；签名覆盖 encoded 串，payload 篡改必然失配
- 前端 `apiFetch` 统一封装：任何响应 401 → `location.href='/login'`；登录页自身用原生 fetch（避免 401 触发跳转死循环）

### 删除保护（DELETE_PASSWORD 层）

```
DELETE /api/recipes/:id（启用时要求 body { deletePassword }）
  ── timingSafeEqual 恒时比较 ──►
  ✓ 204 删除成功
  ✗ 403 { error: '删除密码校验失败' }   ← 无 body/格式错/密码错 全部同文案（不区分原因，防探测）
```

- 开关判定：`DELETE_ENABLED === 'true' && DELETE_PASSWORD 非空`（两项缺一视为未启用，防半配半失效）
- 前端交互：`/api/config` 的 `deleteEnabled` 字段分派——启用时详情页弹密码小窗（Enter 确认/Esc 关闭，403 强制弹窗提示重输，含小窗未打开的兜底）；未启用时浏览器 confirm 二次确认后才发起 DELETE；开关未返回（null）期间删除按钮禁用
- **服务端校验是强制点**：前端弹窗只收集输入，绕过 UI 直接调 API 同样 403

### 状态可见性

`GET /api/config` 回显 `{ authEnabled, deleteEnabled }` → 设置页状态分组卡片（iOS 分组列表样式）：「访问鉴权」（组首，顶部圆角）→「删除保护」→「访问记录」入口（默认隐藏，显示时作为组尾、底部圆角，点击进入 `/access-logs` 列表页）。卡片贴合无间隔，一眼确认安全状态；**绝不回显任何密码/key**（红线测试锁定字段名与注入值双断言）。

**「访问记录」入口默认隐藏**（避免审计记录被一眼看到）：在「访问鉴权」卡片上连续点击 5 次（相邻间隔 ≤1.5 秒）才出现，刷新或离开页面后重新隐藏——用组件内存态实现，不做任何持久化。入口隐藏时「删除保护」成为组尾（`rounded-b-xl` + 有下边框），显示时恢复为中间卡（直角 + 无下边框），两态圆角都正确。

入口隐藏**不等于访问控制**：真正的控制仍是 `PASSWORD`（启用后 `/api/access-logs` 返回 401）；未启用时直接访问 `/access-logs` 网址仍可查看。详见 [settings 文档](../settings/README.md#页面隐藏的访问记录入口)。

### 访问记录（方案 A：敏感操作审计）

设置页「访问记录」入口 → `/access-logs` 列表页（时间/IP/方法/路径/状态码，最新在前）。

- **记录范围**：只记写操作与敏感操作——菜谱 POST/PUT/DELETE（含删除保护 403）、AI 生成/点菜/聊天（含失败）、备份导入（附 imported 计数）、登录尝试（含 401——连续 401 是「有人乱试口令」的审计线索，同 IP 60 秒节流只记首条防枚举刷满窗口）；普通读请求（列表/详情浏览）不记
- **存储**：`data/logs/access.jsonl`（JSON Lines），与菜谱库同受 data 卷保护；正常路径 `fs.appendFile`（O_APPEND 单行原子追加），达上限 200 条时「读→截断→tmp→rename」压缩且经模块级 Promise 队列串行，滚动丢弃最旧（4 页即看完全部），文件永不无限增长
- **展示分页**：列表页前端分页（50 条/页，「上一页/下一页」+「第 N / M 页 · 共 X 条」指示）——数据一次拉全量（上限 200 条传输极小），切片渲染避免长列表；刷新重置回第一页
- **隐私红线**：不含任何密码/Key/查询参数（搜索词不记录）；删除保护 403 的路径不带 id（密码未验过，id 不可信）；日志写失败静默吞掉，绝不打断主业务响应
- **IP 提取**：Next App Router 不暴露 socket，真实对端地址由 Next 写入 `x-forwarded-for`。默认取**末段**（客户端自造值会排在链首，末段是直连写入的真实对端）；`TRUST_PROXY=true`（前置反代可信）时取**首段**。取不到记 `unknown`。安全定位：直连场景下伪造整个 XFF 头仍可行，审计 IP 是「尽力而为」而非强身份凭证
- 读接口 `GET /api/access-logs` 受 PASSWORD 守卫保护，且自身不写日志

## 为什么这么做

| 决策 | 理由 |
| --- | --- |
| 环境变量开关而非用户系统 | 单人自用，注册/用户管理是过度设计；开关+口令是摩擦与安全的平衡点 |
| HMAC token 而非服务端 session 表 | 无状态会话（重启不失效、不占存储）；密钥即 PASSWORD，自用场景无需 KDF（账本已裁定） |
| 守卫在 handler 首行而非 middleware | Next middleware 需要额外配置文件且对 standalone 构建有边界；handler 级守卫显式、可测（直接 import 调用）。代价：新增路由须手动加守卫（当前共 10 个 route，除 /api/auth 本身豁免外，其余 9 个均有 requireAuth 守卫——含访问记录与营养接口） |
| 删除保护独立于登录口令 | 场景不同：PASSWORD 防陌生人访问，DELETE_PASSWORD 防自己/家人手滑误删（AI 一键生成的菜谱删除成本远低于手工录入，需要一道刹车） |
| config 暴露开关布尔值而非密码本身 | 状态可见与秘密保密解耦；api-key/delete-password 泄漏有专项红线测试 |

## 优缺点

**优点**

- 零依赖实现（node:crypto 三个原语），无 session 存储、无第三方鉴权服务
- 未启用时全站零摩擦（自用默认），启用时全站覆盖（一个函数守所有写入口）
- 恒时比较+长度短路、验签结构校验、401/403 零信息泄漏——安全实现经安全视角专项审查
- Cookie Secure 按协议推导，HTTP 局域网直连与 HTTPS 反代两种部署形态都开箱即用

**缺点与已知边界**

- handler 级守卫靠纪律：新增 API 忘加守卫不会报错（审计靠整分支审查/人工）
- 单口令无用户概念：无法区分「谁」在操作、无法单独吊销某设备（换 PASSWORD 全设备重登）
- token 无服务端吊销：30 天内泄漏的 token 无法单独作废（换 PASSWORD 即全部作废，自用可接受）
- 长度不等先短路理论上有口令长度侧信道（威胁模型内不可利用，注释已明示取舍）

## 架构位置

```
login 页 ──原生 fetch──► POST /api/auth ──► verifyPassword ──► Set-Cookie
   ▲ 401 自动跳转（apiFetch）
所有页面 ──apiFetch──► 受保护 handler ──requireAuth（首行）──► 放行/401
详情页 删除 ──DELETE + {deletePassword}──► DELETE handler ──恒时比较──► 204/403
设置页 ◄──GET /api/config── { authEnabled, deleteEnabled }（不含任何秘密）
```
