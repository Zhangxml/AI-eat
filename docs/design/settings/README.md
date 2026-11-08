# 全局用户设置（/api/settings）

> 一句话：用户级**可写**偏好（目前是推荐风格），存服务器 `data/settings.json`，服务端直接消费（前端不传参）。

## 为什么有这一层

推荐风格（家常 / 换换口味）最初是页面内 `state`，随请求以 `?style=` / body 字段传给 AI 路由。这带来三个问题：

| 问题 | 后果 |
| --- | --- |
| 页面 state 不持久 | 刷新即回默认，用户每次都要重选 |
| 多设备各存各的 | 手机设为家常、平板仍是换口味 |
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

- `version`：当前恒为 1，为未来字段改名/结构迁移留口
- `style`：`home`（经典家常，默认）| `creative`（中式创意换口味）
- 缺字段/非法值/文件损坏/文件不存在 → 一律回落默认 `{ version: 1, style: 'home' }`，**绝不崩**（设置坏了不能把整个应用带下去）

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
| 备份 | 目录直备天然包含；页面导出/导入仍只导菜谱（不扩大备份契约） |

## 加一项新设置要改哪里

1. `src/lib/settings.ts`：schema 加字段 + 默认值 + `mergeSettings` 合流
2. `src/lib/settings-store.ts`：通常不用改（整对象读写）
3. `src/app/api/settings/route.ts`：错误文案里的字段清单
4. 设置页：加一组 UI（`changeStyle` 同款乐观更新 + 失败回滚）
5. 消费点：需要的地方 `readSettings()`

后续候选：默认份量、忌口/过敏原、是否显示营养、温度覆盖、模型切换。**注意**：API Key 永远只能来自 env，**绝不下发/不落盘明文**。
