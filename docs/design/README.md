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
| AI 对话 | [chat](./chat/README.md) | 首页「问问AI」：SSE 五事件协议流式聊天（message/recipe/menu/error/done），菜谱卡片一键入库（所见即所得） |
| 点菜·买什么 | [menu](./menu/README.md) | 两段式：人数+偏好→菜单+采购清单；感兴趣的菜按需生成完整菜谱入库 |
| 菜谱库界面 | [recipes-ui](./recipes-ui/README.md) | 列表/录入（AI 回填）/详情三页 + 共用表单；裸形状契约与历史坑位说明 |
| 多用户 | [multi-user](./multi-user/README.md) | 每账号独立菜谱库与推荐风格；访问记录全局且仅管理员可见；token 带 uid+sessionVersion |
| 全局设置 | [settings](./settings/README.md) | 用户级可写偏好（推荐风格）存 `data/settings.json`；PATCH 局部更新，AI 路由服务端直接读，前端不传参 |
| 鉴权 | [auth](./auth/README.md) | PASSWORD 登录会话（HMAC token）+ 删除保护（DELETE_PASSWORD），环境变量开关，未设即零摩擦 |
| 备份恢复 | [backup](./backup/README.md) | 目录直备主通道 + 页面导出导入（imported/skipped/invalid 三分报告） |
| 部署运行 | [deploy](./deploy/README.md) | run.sh 裸机 / Docker compose 双形态，8888 端口，data 卷持久化，.env 配置不入库 |

## 贯穿全站的横切约定

- **数据只在服务端文件**：浏览器持久化（IndexedDB/localStorage）全库禁止——用户明确否定过的反目标
- **API Key/密码不进浏览器、不进 git**：`.env` 被 .gitignore 排除；`/api/config` 只回显非敏感状态（红线测试锁定）
- **AI 结构化输出必须过 zod**：解析失败重试一次，仍失败报错——脏数据永不入库
- **前端统一 apiFetch**：401 自动跳登录；裸形状（/api/recipes）与包裹形状（/api/ai/recipes）在各消费点有注释警示
- **按钮高度档位**（实测值，从高到低；统计口径限 `button` 与按钮型链接，不含底部导航 tab / 卡片 / 浮动按钮）：
  - **44px+**（`min-h-[44px]` 起；带 `py-3` 的实心全宽到 48px，带描边的全宽到 50px）：主操作与页面级操作——表单提交、登录、导出备份、「上一页/下一页」、返回链接、「＋ 添加食材/步骤」
  - **36px**（`min-h-[36px]` + `rounded-md`，全仓仅 1 处）：菜谱库空态区的主出口「清除筛选」——一键同时清空分类 + 标签 + 搜索词（chips 此时仍可点，但只能逐维改条件）
  - **34px**（`py-1.5` + 1px 边框撑出，**未设 `min-h`**，`rounded-lg`）：紧凑描边——录入页「AI 生成」「AI 估算营养」、详情页「编辑」「删除」与错误态的「重试」「返回菜谱库」、详情页删除弹窗的「取消」「确认删除」、设置页「开始导入」。规格源头是 `RecipeForm.tsx` 的 `compactBtn`，但**只有 2 处直接引用该常量，其余 7 处是同值副本**（删除系按钮为红色变体），改 padding/字号需逐处同步
  - **32px + `rounded-md`**：轻量控件——分类·标签筛选 chips、设置页「推荐风格」、访问记录页的「刷新」
  - 注：34px 档没有 `min-h`、高度靠 `padding` 撑，行高一变会跟着漂；改它时须连带确认同行控件（如 file input）的对齐
- **移动端三约束**：触摸目标默认 ≥44px；低于它的三档都是有意识取舍——**36px** 空态出口、**34px** 紧凑描边（行内次级操作：录入页/设置页附近有 44px 控件兜底，详情页与弹窗场景最近可点目标在数百 px 外，接受该取舍）、**32px** 轻量 chips（再高会挤压列表可视区）；硬性下限按 WCAG 2.5.8 AA 的 24×24 CSS px。其余为输入 16px、无横滚
- **新按钮的选档**：默认走 44px 档；确需更矮优先用 32px 轻量档（有 `min-h`、高度稳定）；**34px 仅用于需要与既有 34px 行内控件对齐的场合**（如设置页「开始导入」与同行 file input），且要像 `compactBtn` 那样在注释里写明理由与同步范围
- **底部导航不随滚动条抖动**：`html { scrollbar-gutter: stable }` 恒预留竖向滚动条槽位——经典滚动条环境下长短页面切换会改变视口宽度，`fixed inset-x-0` 的导航与页面内容会整体左右位移（四个 tab 一起动）
- **底部导航与内容同宽**：`nav` 保留 `fixed inset-x-0 h-14`（全宽背景与上边框 = 一条通栏分隔线，`h-14` 必须在外层，否则 `border-t` 的 1px 会让导航高过 `pb-14` 的 56px 预留），内层 `mx-auto max-w-3xl h-full` 约束四个 tab 的槽位，与使用 `max-w-3xl` 的各页内容区**外框**左右边缘逐像素对齐（各页 `px-4` 让正文文字列比 tab 命中区各内缩 16px，属不给内层加 `px-4` 换取手机端 parity 的代价）（`/login` 用 `max-w-sm`，不在此列）。不加内层约束时，桌面宽屏（1440px）会出现「768px 居中内容 + 1425px 通栏导航」，四个 tab 被拉到每格 356px，与内容脱节。可用宽度 ≤768px（移动端）时 `max-w-3xl` 不生效，flex-1 等分算法未变，因此 tab 宽度与改动前完全一致；代价是宽屏下两侧各有一段不通向任何 tab 的空白带（视觉上仍像整条可点，实测 `elementFromPoint` 落在 nav 本身而非链接）

## 环境变量速查

| 变量 | 作用 | 缺省行为 |
| --- | --- | --- |
| `AI_BASE_URL` / `AI_API_KEY` / `AI_MODEL` | AI 供应商（OpenAI 兼容） | 三项齐备才启用 AI 功能，缺省仅本地功能 |
| `AI_TEMP_CHAT` / `AI_TEMP_MENU` / `AI_TEMP_RECIPE` / `AI_TEMP_NUTRITION` | AI 温度分层覆盖 | 0.7 / 0.8 / 0.7 / 0.5；非法值回落并 clamp 到 0~1 |
| `PASSWORD` | 登录口令（非空即启用） | 未设=免登录（局域网信任边界） |
| `DELETE_ENABLED` + `DELETE_PASSWORD` | 删除保护开关+密码 | 未设=删除仅浏览器确认 |
| `TRUST_PROXY` | 反代可信时取 XFF 首段（默认取末段=直连真实对端） | 未设=取末段 |
| `PORT` | 裸机监听端口 | 8888 |
| `AI_EAT_DATA_DIR` | 菜谱数据目录 | `<项目>/data/recipes`（Docker 内 `/app/data/recipes`） |
