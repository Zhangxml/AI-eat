# AI-eat 设计文档索引

> 规格源头：[docs/superpowers/specs/2026-11-07-ai-eat-design.md](../superpowers/specs/2026-11-07-ai-eat-design.md)（产品意图/边界/方案对比）
> 本目录：按功能模块拆分的**实现设计**——每个模块讲清楚做什么、怎么做的、为什么这么做、优缺点、方案描述、架构与数据流。

## AI-eat 是什么

自用 AI 菜谱工具：局域网服务器部署，手机浏览器直连。两个核心场景——
**冰箱剩菜不知道做什么**（问问AI：按食材对话生成菜谱）与
**准备买菜**（买什么：按人数配一桌菜单+采购清单）。
菜谱统一存服务端文件（`data/recipes/*.json`），支持人工录入、AI 回填、备份恢复。

## 模块文档

| 模块 | 文档 | 一句话 |
| --- | --- | --- |
| 菜谱存储 | [storage](./storage/README.md) | 一菜一 JSON 文件，原子写、strict 校验、路径安全守卫，全库唯一触盘层 |
| AI 接入 | [ai](./ai/README.md) | OpenAI 兼容直调三供应商；标签协议+平衡扫描解析+重试；库摘要注入；AI 输出 id/时间戳无条件覆写 |
| AI 对话 | [chat](./chat/README.md) | 首页「问问AI」：SSE 四事件协议流式聊天，菜谱卡片一键入库（所见即所得） |
| 点菜·买什么 | [menu](./menu/README.md) | 两段式：人数+偏好→菜单+采购清单；感兴趣的菜按需生成完整菜谱入库 |
| 菜谱库界面 | [recipes-ui](./recipes-ui/README.md) | 列表/录入（AI 回填）/详情三页 + 共用表单；裸形状契约与历史坑位说明 |
| 鉴权 | [auth](./auth/README.md) | PASSWORD 登录会话（HMAC token）+ 删除保护（DELETE_PASSWORD），环境变量开关，未设即零摩擦 |
| 备份恢复 | [backup](./backup/README.md) | 目录直备主通道 + 页面导出导入（imported/skipped/invalid 三分报告） |
| 部署运行 | [deploy](./deploy/README.md) | run.sh 裸机 / Docker compose 双形态，8888 端口，data 卷持久化，.env 配置不入库 |

## 贯穿全站的横切约定

- **数据只在服务端文件**：浏览器持久化（IndexedDB/localStorage）全库禁止——用户明确否定过的反目标
- **API Key/密码不进浏览器、不进 git**：`.env` 被 .gitignore 排除；`/api/config` 只回显非敏感状态（红线测试锁定）
- **AI 结构化输出必须过 zod**：解析失败重试一次，仍失败报错——脏数据永不入库
- **前端统一 apiFetch**：401 自动跳登录；裸形状（/api/recipes）与包裹形状（/api/ai/recipes）在各消费点有注释警示
- **按钮三档规格**：主操作实心全宽 44px+ / 行内次级描边 34px / 筛选 chips 轻量；移动端三约束（触摸 ≥44px、输入 16px、无横滚）

## 环境变量速查

| 变量 | 作用 | 缺省行为 |
| --- | --- | --- |
| `AI_BASE_URL` / `AI_API_KEY` / `AI_MODEL` | AI 供应商（OpenAI 兼容） | 三项齐备才启用 AI 功能，缺省仅本地功能 |
| `PASSWORD` | 登录口令（非空即启用） | 未设=免登录（局域网信任边界） |
| `DELETE_ENABLED` + `DELETE_PASSWORD` | 删除保护开关+密码 | 未设=删除仅浏览器确认 |
| `PORT` | 裸机监听端口 | 8888 |
| `AI_EAT_DATA_DIR` | 菜谱数据目录 | `<项目>/data/recipes`（Docker 内 `/app/data/recipes`） |
