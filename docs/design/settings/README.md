# 全局用户设置（/api/settings）

> 一句话：用户级**可写**偏好（目前是推荐风格），存服务器 `data/settings.json`，服务端直接消费（前端不传参）。

## 为什么有这一层

推荐风格（湖北家常 / 换换口味）最初是页面内 `state`，随请求以 `?style=` / body 字段传给 AI 路由。这带来三个问题：

| 问题 | 后果 |
| --- | --- |
| 页面 state 不持久 | 刷新即回默认，用户每次都要重选 |
| 多设备各存各的 | 手机设为湖北家常、平板仍是换口味 |
| 同一概念两种传法 | chat 用 query、menu/recipes 用 body，契约不一致 |

既然是**全局**偏好，服务端本来就知道答案，不该反过来等前端告诉它。改造后：

```
data/settings.json        ← 持久层（与 data/recipes 同级，同受 data 卷保护）
        ↑
src/lib/settings.ts       ← zod schema + 默认值 + 合并（唯一事实来源）
        ↑
src/lib/settings-store.ts ← 读（容错回落默认）/ 原子写
        ↑
GET/PATCH /api/settings   ← 鉴权 + 体积闸门 + strict 校验 + 访问日志
        ↑
设置页（可编辑）  /  AI 路由（readSettings 直接读）
```

**前端不再传 style**：`/api/ai/chat`、`/api/ai/menu`、`/api/ai/recipes` 各自 `readSettings()`。即使有人绕过 UI 直接调接口，行为也与设置页一致。

## 数据结构

```json
{ "version": 1, "style": "home" }
```

- `version`：当前恒为 1，为未来字段改名/结构迁移留口；**读取时恒由服务端覆写为当前版本**（不采信文件里的值）
- `style`：`home`（**湖北家常**，默认）| `creative`（外省中式创意换口味）

### 读取宽松、写入严格（Postel 原则）

这是为「后续还会加设置项」预留的关键设计。若读取时要求文件**完全合法**（字段齐全、无多余键），
那么以后一旦新增字段，老用户的文件必然缺字段 → 整体校验失败 → **已调好的设置被静默重置为默认**。

因此两侧口径不同：

| 环节 | 口径 | 行为 |
| --- | --- | --- |
| 读取文件 `parseSettingsFile` | **宽松** | 缺字段 / 未知键 / 未来版本多写的字段 → 忽略，**认得的值全部保留**；字段值非法 → 该字段回落默认；非对象/数组 → 全默认 |
| PATCH 请求体 `validateSettingsPatch` | **严格**（strict） | 未知键 400（防拼写错误被静默吞掉）、非法值 400 |
| 写入前 `writeSettings` | **严格**（schema.parse） | 兜住「未来代码传非法值」的内部 bug，坏数据不落盘 |

实测（`parseSettingsFile` 输入 → 结果）：

```
{version:1, style:'creative'}                → style=creative   正常
{style:'creative'}                           → style=creative   缺 version 仍保留
{version:2, style:'creative', servings:4}    → style=creative   未来版本多字段仍保留
{version:1, style:'creative', foo:'bar'}     → style=creative   垃圾键忽略
{version:1, style:'exotic'}                  → style=home       非法值才回落
null / [1,2] / 'oops'                        → style=home       非对象全默认
```

文件损坏（JSON 解析失败）或不存在 → 默认 `{ version: 1, style: 'home' }`，**绝不崩**（设置坏了不能把整个应用带下去）。

## API 契约

| 方法 | 路径 | 成功 | 失败 |
| --- | --- | --- | --- |
| GET | `/api/settings` | `200 Settings` | `401`（启用 PASSWORD 且无会话） |
| PATCH | `/api/settings` | `200 Settings`（合并后的完整设置） | `400 { error }`（未知键/非法值/非 JSON）、`401`、`500 { error }`（写盘失败） |

**为什么 PATCH 而不是 PUT**：局部更新语义——以后加字段时，老客户端只传自己知道的键，不会把新字段覆盖成空。

**strict 校验**：`{ stlye: 'creative' }`（拼错）→ 400 明确报错，不静默吞掉。否则用户以为改了，实际没改。

## 与 /api/config 的边界

| 接口 | 性质 | 来源 | 内容 |
| --- | --- | --- | --- |
| `/api/config` | 部署级、**只读** | 环境变量 | AI 是否配置、baseUrl/model、鉴权/删除保护开关 |
| `/api/settings` | 用户级、**可写** | `data/settings.json` | 推荐风格等偏好 |

两者不重叠：env 决定「能不能用」，settings 决定「怎么用」。**优先级约定：用户设置 > 环境变量 > 代码默认**（本次 style 无 env，只实现「文件 > 默认」）。

## 容错与边界

| 场景 | 行为 |
| --- | --- |
| 设置文件不存在 | 默认 home |
| 文件是坏 JSON / 字段非法 | 默认 home（读取层 `try/catch` + zod 校验） |
| 目录不存在（首次写） | `mkdir -p` 自动创建 |
| 写盘中途失败 | 临时文件 + rename 原子替换，残留 tmp 清理；API 映射 500 中文提示 |
| 两台设备同时改 | 后写覆盖（单人自用可接受） |
| 未启用 PASSWORD | 守卫放行，零摩擦 |
| Docker 部署 | `data/` 已挂卷，无额外配置 |
| 备份 | 目录直备天然包含 `settings.json`；页面导出/导入仍**只导菜谱**（不扩大备份契约，换机时设置需重设） |

## 加一项新设置要改哪里

1. `src/lib/settings.ts`：schema 加字段 + 默认值 + `mergeSettings` 合流 + **`parseSettingsFile` 补该字段的宽松解析**（漏了这步，老文件里的新字段永远读不到）
2. `src/lib/settings-store.ts`：通常不用改（整对象读写）
3. `src/app/api/settings/route.ts`：错误文案里的字段清单
4. 设置页：加一组 UI（`changeStyle` 同款乐观更新 + 失败回滚）
5. 消费点：需要的地方 `readSettings()`

后续候选：默认份量、忌口/过敏原、是否显示营养、温度覆盖、模型切换。**注意**：API Key 永远只能来自 env，**绝不下发/不落盘明文**。

## 页面：隐藏的「访问记录」入口

设置页底部的「访问记录」入口**默认隐藏**，在「访问鉴权」卡片上**连点 5 次**才出现；刷新页面或离开后重进一律回到隐藏。

### 为什么用内存态，不用任何持久化

需求里的「刷新后隐藏」直接排除了所有持久化方案：

| 方案 | 刷新后隐藏 | 结论 |
| --- | --- | --- |
| 组件内存态（选定） | ✅ | 唯一满足 |
| `sessionStorage` | ❌ 同标签页刷新仍在 | 不满足 |
| URL 参数 `?logs=1` | ❌ 刷新保留 | 不满足 |
| 写进 `data/settings.json` | ❌ 反而永久保留 + 多设备同步 | 反向 |

### 「连续」的定义

相邻两次点击间隔 **≤ 1.5 秒**才算连续；一旦超过就从这一下重新计数（防「昨天点 3 次、今天点 2 次」误触发）。达到 5 次后保持显示，无需继续点击。逻辑抽在 `src/lib/tap-reveal.ts`（`createTapReveal`，可注入时间源），有 9 条单测锁定边界（含「恰好等于窗口算连续」「超 1 毫秒即重置」「达阈值后不回落」「非法时间戳按 0 处理」）。

设置页本身是纯 UI 页、项目无组件测试，所以把计数逻辑抽成纯对象是唯一能测的做法。

### 交互细节

- **整张「访问鉴权」卡片可点**（`role="button"` + `tabIndex=0` + Enter/Space），手机上更容易连点
- **刻意不做任何进度提示**——否则点到第 3 次就被旁人看出端倪，隐藏失去意义；只保留 `active:bg-neutral-50` 按压反馈
- **圆角联动**：「访问鉴权 / 删除保护 / 访问记录」是连体分组（首卡顶部圆角、尾卡底部圆角）。入口隐藏时「删除保护」成为组尾，需切换为 `rounded-b-xl` + 有下边框，否则页面底部会缺圆角、多一条断边
- 直接访问 `/access-logs` 网址**仍可打开**——入口隐藏不等于访问控制（见下）

### 这不是权限控制

隐藏入口只是「不让它一眼被看到」。真正的访问控制在 `PASSWORD`：启用后 `/api/access-logs` 会返回 401。未启用密码时，知道局域网地址的人直接访问 `/access-logs` 就能看到全部记录。若要防人查看，请启用 `PASSWORD`。
