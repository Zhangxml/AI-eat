# 模块：菜谱库界面（列表/录入/详情）

> 代码位置：`src/app/recipes/page.tsx`（列表）、`src/app/recipes/new/page.tsx`（录入）、
> `src/app/recipes/[id]/page.tsx`（详情/编辑/删除）、`src/components/RecipeForm.tsx`（表单）、
> `src/components/RecipeListItem.tsx`（列表行）、`src/components/RecipeCard.tsx`（菜谱卡片）
> 消费方：导航「菜谱库」；RecipeCard 同时被聊天页/点菜页复用

## 做什么

菜谱库的人机界面，覆盖完整 CRUD：

- **列表页** `/recipes`：全部菜谱（updatedAt 降序）、按名称/食材搜索（300ms 防抖）、**分类 / 标签两行横滑筛选**、非法文件告警条、右下角浮动 + 进入录入
- **录入页** `/recipes/new`：人工表单录入；**AI 生成**——只填名称点按钮，整份菜谱回填表单，核对修改后手动保存
- **详情页** `/recipes/[id]`：四态渲染（加载/详情/404/错误）、编辑（复用表单）、删除（可选密码保护，见 auth 模块文档）

## 怎么做的

### RecipeForm（录入/编辑共用组件）

```ts
RecipeForm({ initial?: Recipe; onSubmit: (draft) => Promise<Response>; submitLabel: string })
```

- 受控表单：食材/步骤为行数组 state（增删行），提交时 `buildDraft()` 组装并做行级校验（整行空白丢弃、半填行拦截、营养四项整体填写/整体置空）
- **AI 整份生成**：名称旁「AI 生成」按钮（名称空则禁用）→ `POST /api/ai/recipes { dish }` → 成功后整份回填所有字段（标签以中文逗号连接匹配回显格式、营养四项转字符串）→ **不自动保存**（source 仍 manual），用户核对后自行提交。回填后 AI 可再改，人工始终兜底
- **AI 估算营养**：营养区独立按钮（需名称+食材）→ 请求携带「食材名+用量」与已填步骤（用量决定营养量级，只发名称会明显失真）→ `POST /api/ai/nutrition`（温度 0.5，只返回四项营养）→ 回填；不再为拿营养生成整份菜谱。营养四项在共享 schema 中带 `.finite().min(0)` 约束，负值与 Infinity/NaN 都会被拒绝（接口重试后仍失败返回 502，不会回填到表单）
- 编辑模式：`initial` 传入即回显，`source` 沿用原值；组件无路由感知（页面注入 onSubmit 决定 POST 还是 PUT）

### 关键契约与坑（实现时踩过的）

| 契约点 | 说明 |
| --- | --- |
| 201 响应是**裸 Recipe** | `/api/recipes` POST 返回裸形状；曾因假定 `{recipe}` 包裹导致「保存成功却报错且不跳转」（fix round 修复，页面逻辑按裸形状解析并有响应形状冒烟证据） |
| `{ recipe }` 包裹是 **AI 生成接口** | `/api/ai/recipes` 返回包裹形状——两个接口形状不同，消费点均有注释警示 |
| toDraft 剥离 | id/createdAt/updatedAt 不进 DraftRecipe（strict schema 多一字段即 400）；source 保留 |
| 守卫顺序 | 详情页四态：notFound/error 终态守卫**必须**排在 loading 之前（失败时 mode 保持 loading，否则被「加载中」永久遮挡——有注释说明因果） |
| 步骤输入框 auto-grow | textarea `rows` 只算显式换行不算自动折行，AI 长步骤被裁剪出内部滚动条（与页面滚动冲突）→ `StepTextarea` 用 ref 实测 scrollHeight 撑高，value 变化（手动/AI 回填）都重算 |
| 删除分派 | `deleteEnabled`（来自 /api/config）为 true 时弹密码小窗（服务端二次校验），为 false 时浏览器 confirm 二次确认（确定删除「菜名」吗？删除后无法恢复），null（开关未返回）期间删除按钮禁用；403 强制弹窗提示重输 |

### 列表页

- 搜索防抖 300ms + `requestIdRef` 竞态防护（快速输入时旧响应丢弃，不覆盖新结果）
- `!res.ok` 与网络异常都有错误条（HTTP 级失败不再静默保旧列表）
- **筛选区两行**：分类一行、标签一行，各自单行横滑（`src/components/FilterRow.tsx`）
  - 两行首项都是「全部」（对应 `null` = 该维度不筛选），默认选中
  - 行内**单选**：点新的替换旧的；点已选中项无反应（取消请点「全部」，防误触清掉筛选）
  - **跨行取交集**：分类 + 标签 + 搜索词三者同时生效
  - **标签行随分类收敛**：`facets.tags` 由后端按当前分类算出，选「荤菜」后只显示荤菜里出现过的标签——避免点出必然为空的组合（用真实数据实测：固定全量时 4 分类 × 32 标签共 128 种组合中有 **88 种（69%）为空**）
  - **切分类后旧标签失效会自动回退「全部」**（`resolveTagAfterCategoryChange`）：否则会出现「选中的标签已从列表消失、结果却仍被它过滤」的幽灵状态
- **空态说明具体条件**并给「清除筛选」按钮：「没有同时满足「主食」+「下饭菜」的菜谱」——组合筛选下只说「没有匹配」会让人分不清是搜索词还是筛选的问题
- 横滑的细节：标题 `shrink-0` 固定左侧 / 隐藏滚动条 / `overscroll-behavior-x: contain` / chip 规格 32px 高 + `rounded-md`（轻量档，低于主规格 44px；原 36px + 胶囊圆角显得又高又圆，已按反馈收紧）/ 行标题加粗深色以突出「这是哪一维度」
  - **右侧渐隐按需显示**：仅当「确实可滑且未到右端」才挂 mask（`ResizeObserver` + `onScroll` 同步）——无条件挂会把本来装得下的分类行最后一个 chip 切掉一角
  - **选中项自动滚入视野**：只滚横滑容器本身（`scrollTo`），不用 `scrollIntoView`——后者在元素位于视口外时会把整页纵向滚过去（实测过）
- 「点已选中项」一律无反应（含「全部」）：取消筛选请点「全部」，避免误触清掉筛选
- **键盘焦点环必须显式声明**：UA 默认焦点环取 `currentColor`，而选中 chip 的文字与底色互为反色，
  环会被「同色吃掉」（实测不可见）。统一用 `focus-visible:outline-2 outline-offset-2 outline-neutral-900`
  （dark 用 `neutral-100`）；同时**不能**用 `transition-colors`——它包含 `outline-color`，
  会让焦点环从 `currentColor` 渐变到目标色、聚焦瞬间看不见
- **横滑容器必须留 4px 内边距**：焦点环需要 chip 外侧 4px（offset 2 + 宽 2）空间，
  而 `overflow-x-auto` 会把 `overflow-y` 也算成 `auto`，导致上/左整条环完全消失、下方只剩残片（实测对照）。
  实现用 `p-1 -m-1`：内边距留空间、负外边距抵消，视觉位置与行高不变
- **分类与标签两个维度互不牵连**：切分类绝不清标签。该不变量由 `reduceDimensions`（`src/lib/recipe-filter-state.ts`）保证并有单测；若新分类下旧标签失效，由 facets 校正逻辑回退
- 桌面**不提供左右箭头**（按需确认过）：分类行在 390px 以上通常无需滑动（实测 390px 下内容宽 307px == 容器宽 307px），标签行需要时用 Shift+滚轮 或触控板横滑

### 接口契约变更

`GET /api/recipes?q=&category=&tag=` → `200 { recipes, invalidFiles, facets }`

`facets: { categories: string[]; tags: string[] }`——只增字段不删，旧客户端忽略多余字段即可。
- `categories`：只含**实际存在**的分类，按固定顺序（荤菜→素菜→汤→主食→其他）
- `tags`：指定 `category` 时只返回该分类内的标签（按该分类内频次降序）；未指定时返回全量
- facets 与结果用**同一份 `listRecipes` 快照**计算，不会因并发改库而与列表错位

## 为什么这么做

| 决策 | 理由 |
| --- | --- |
| 表单组件无路由感知 | 编辑/录入两页复用同一组件，行为差异全部由 props 注入（onSubmit/submitLabel/initial） |
| AI 生成只回填不保存 | 用户要求明确；AI 结果可能有误，人工核对是质量关——保存动作语义不变（manual），用户始终掌控 |
| 营养整体填写/置空 | schema 中 nutrition 是原子结构；允许半填会造成「有热量没蛋白质」的脏数据 |
| 详情页客户端组件而非 RSC | 编辑/删除/密码弹窗需要重交互，客户端渲染配合 API 拉取更直接；列表同理（防抖过滤在客户端最自然） |
| 404 不自动跳转 | 打断用户的设计（可能只是 id 输入错）；给返回列表入口由用户决定 |

## 优缺点

**优点**

- 一套表单覆盖录入/编辑两场景，AI 回填让「录入 20 分钟」变成「核对 2 分钟」
- 全站按钮/间距规格统一（四个高度档：44px+ / 36px / 34px / 32px，分别对应主操作与页面级、空态出口、紧凑描边、轻量 chips；详见 [docs/design/README.md](../README.md) 的「按钮高度档位」一节）
- 竞态防护、裸形状解析、剥离逻辑等历史 bug 均有测试或冒烟证据锁定
- 移动端三约束（44px 触摸、16px 输入、无横滚）有样式证据；低于 44px 的三档都是有意识取舍：**36px** 空态出口（清空筛选的主出口）、**34px** 紧凑描边（行内次级操作，详情页/弹窗场景最近可点目标在数百 px 外）、**32px** 轻量 chips（再高会挤压列表可视区，用户确认过）。硬性下限按 WCAG 2.5.8 AA 的 24×24 CSS px

**缺点与已知边界**

- toDraft 在 ChatView 与点菜页各有一份（30 行级重复，第三处消费者出现时应提取——已知 deferred）
- 步骤/食材行 key 用数组索引（无重排场景，删除中间行时焦点不跟随语义行，纯 UX）
- 列表由服务端按 q/category/tag 过滤后返回（仅失效文件告警与排序在前端无关）（规模大后需服务端分页）
- 详情页时间戳（createdAt/updatedAt）未展示（产品口径取舍）

## 架构位置

```
列表页 ──GET /api/recipes?q&category&tag（+ buildFacets）──► recipe-store.filterRecipes
录入页 ──RecipeForm──► POST /api/recipes（manual）──┐
详情页 ──GET/PUT/DELETE /api/recipes/:id ──────────┤
AI 回填 ──POST /api/ai/recipes { dish } ───────────┘（只回填表单）
RecipeCard（纯展示）◄── ChatView / 点菜页 / （详情页自成布局）
```
