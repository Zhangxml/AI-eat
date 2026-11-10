# 模块：菜谱存储（recipe-store）

> 代码位置：`src/lib/recipe-types.ts`（数据模型）、`src/lib/recipe-store.ts`（文件存储）
> 消费方：REST API（`/api/recipes*`）、AI 接口（库摘要注入）、备份（导入导出）

## 做什么

提供个人菜谱库的**持久化存储**：一菜一 JSON 文件，落服务端 `data/recipes/<id>.json`。对外暴露两组能力：

- **数据模型与校验**（recipe-types）：`Recipe`（完整菜谱）、`DraftRecipe`（入库草稿，无 id/时间戳）、`Nutrition`（营养四项+估算标记），zod schema 严格校验，非法输入返回 `null` 而非抛错
- **文件存取**（recipe-store）：`listRecipes / getRecipe / createRecipe / updateRecipe / deleteRecipe / putRecipe / filterRecipes`，外加路径安全守卫 `isSafeId`

## 怎么做的

### 数据流（一次完整的菜谱生命周期）

```
AI 生成/人工录入
      │ validateDraft（zod .strict()）
      ▼
DraftRecipe ──createRecipe──► 补 id(r-<毫秒>-<hex6>)+时间戳 ──原子写──► data/recipes/<id>.json
      │                                                                    │
      │ updateRecipe（保 id/createdAt，刷 updatedAt）                        │ listRecipes 读目录
      ▼                                                                    ▼
用户编辑 ◄── GET /api/recipes/:id ◄── validateRecipe ──► Recipe（前端展示）
```

### 关键实现决策

| 决策 | 实现 | 为什么 |
| --- | --- | --- |
| 一菜一文件 | `<id>.json`，文件名即 id | 用户可手动改/删单个菜谱；备份恢复=按 id 复制文件；避免单文件并发写坏全库 |
| 原子写（写原子性） | 写 `<file>.<uuid>.tmp` → `fs.rename` → 失败时 `finally` 清理自己的 tmp（`src/lib/atomic-write.ts`，菜谱库与设置共用） | 临时名带随机后缀：原实现用固定 `<file>.tmp`，两个并发写会争用同一临时文件——实测 50 轮并发里 41 轮出现「一方 rename 报 ENOENT（表现为 500）、但磁盘上是另一方内容」，失败方的修改被静默吞掉。随机名让每个写手独占临时文件。**注意边界**：这只保证「单次写不撕裂、不互踩」；`settings` PATCH 与 `updateRecipe` 仍是「读→改→写」，两个并发请求都返回 200 但后者覆盖前者（last-writer-wins），属单人自用的已知取舍 |
| 写前建目录 | `atomicWriteFile` 内 `mkdir(recursive)` 一处收敛 | 三个写入函数（create/update/put）自动全覆盖；修复过全新部署首次写入 ENOENT 500 的线上问题 |
| 非法文件容忍 | `listRecipes` 逐文件 parse+校验，失败进 `invalidFiles` 上报，不崩溃 | 用户手改 JSON 是设计预期（规格 5.3），坏文件跳过+告警优于整库不可用 |
| 列表排序 | `updatedAt` ISO 字符串字典序降序 | 本层写入路径时间戳格式自洽；用户手改成非 ISO 只退化排序不致错 |
| 搜索/过滤 | `filterRecipes` 纯函数：q 大小写不敏感匹配名称或食材名 includes，tag 精确 | 无索引、无依赖，几十~几百道菜规模内存过滤毫秒级完成 |
| 路径安全 | `isSafeId`：`/^[A-Za-z0-9_-]+$/` 白名单，四个按 id 读写的入口（get/update/delete/put）在 `path.join` 前守卫 | 防 `..%2F..%2F` 路径穿越读写删 data/ 之外的任意 .json（0.0.0.0 监听+默认无登录鉴权下，局域网信任不延伸到文件系统边界）；putRecipe 遇非法 id throw（备份导入捕获后计入 invalidIds，而非静默丢弃） |
| `.strict()` schema | 多余字段判非法 | AI 幻觉出的额外键被拒收；用户手改文件多出的字段走「跳过并告警」而非静默丢弃——可观测性优先 |

### id 格式与安全

`makeRecipeId()` → `r-<毫秒时间戳>-<6位hex（crypto.randomBytes(3)）>`。该格式与 `isSafeId` 白名单天然兼容；测试夹具中的所有合法 id（含备份导入的旧 id）均满足白名单，零回归。

## 为什么这么做（方案对比）

| 候选方案 | 结论 |
| --- | --- |
| 浏览器 IndexedDB/localStorage | **明确否定**（用户反目标）：清缓存/换设备即丢数据 |
| SQLite | 单人规模下引入原生依赖+迁移成本，文件可读性差；YAGNI |
| 单一大 JSON 文件 | 每次写全量重写，手改困难，坏一处坏全库 |
| **一菜一 JSON 文件（选定）** | 可读可手改、按菜粒度原子写、备份=复制目录 |

存储在**服务端**而非浏览器的核心动机：手机/平板/电脑访问同一服务共享一份库，天然无同步问题；`data/` 目录整目录复制即备份。

## 优缺点

**优点**

- 数据格式透明：任意编辑器可直接查看/修改，无数据库黑盒
- 备份极简：`data/` 目录复制即全量备份；页面导出/导入是同一语义的 JSON 视图
- 原子写保证单文件永不出现半截内容
- 路径守卫+strict 校验双层防御，脏数据与恶意输入都进不了库

**缺点与已知边界**

- 几百道菜以上 `listRecipes` 全量读盘会变慢（当前自用规模无感；上量后可加内存索引）
- 按非 id 字段查询无索引（全量过滤）；不支持多写者并发（单人设计）
- `invalidFiles` 语义偏宽：目录中任何非 `.json` 条目也会被上报（route 层已过滤，仅 .json 计数）
- `.strict()` 对旧版本导出的备份若有新增字段会拒收该条（imported/skipped/invalidIds 三分报告会让用户看到）

## 架构位置

```
前端页面 ──► /api/recipes*（薄封装）──► recipe-store ──► data/recipes/*.json
AI 接口（库摘要）──► listRecipes ─┘
备份接口 ──► putRecipe/getRecipe ─┘
```

store 是唯一触盘层：API 路由不含文件 IO 逻辑，AI 接口只读（生成不落盘，入库由前端显式 POST），备份导入是唯一绕过 createRecipe 直接按原 id 写入的通道（`putRecipe`，保留原 id/时间戳——备份恢复≠编辑）。
