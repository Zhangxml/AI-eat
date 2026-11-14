# 模块：备份与恢复（/api/backup + 设置页）

> 代码位置：`src/app/api/backup/route.ts`（导出/导入接口）、`src/app/settings/page.tsx`（设置页）
> 依赖：recipe-store 的 `listRecipes` / `getRecipe` / `putRecipe`

## 做什么

个人菜谱库的数据安全网，双通道备份：

1. **目录直备**（主通道）：`data/` 目录本身即备份——整目录复制/同步即全量快照（compose volume 指向宿主机目录）
2. **页面导出/导入**（迁移通道）：设置页一键导出全部菜谱为单个 JSON 文件；导入 JSON 恢复或迁移到另一实例

## 怎么做的

### 导出

```
GET /api/backup →
  member → 200 { exportedAt, recipes: Recipe[] }                    # 自己的库
  admin  → 200 { exportedAt, recipes: Recipe[], users: [{ name, recipes }] }
                                                                      # recipes 是管理员自己的库，users 是全部用户（不含凭据）
    + Content-Disposition: attachment; filename=ai-eat-backup-<YYYYMMDD>.json
```

前端设置页接 blob → 创建 `<a download>` 触发浏览器保存（文件名优先取响应头，异常回退本地日期）。

### 导入（三分支语义）

```
POST /api/backup { recipes: Recipe[] }
  ├─ 顶层结构错误（缺 recipes 键 / 非数组 / 非法 JSON）→ 400 { error: 中文 }
  └─ 结构合法 → 逐条处理 → 200
       ├─ 新 id        → putRecipe 按原 id 写入 → imported++
       ├─ 已存在同 id  → 跳过 → skipped++（skippedIds 上报）
       └─ schema 校验失败（strict 拒收：缺字段/多字段/类型错）→ invalid++（invalidIds 上报，
          无 id 的条目以 #<数组序号> 占位标识）
```

**导入保留原 id 与时间戳**（`putRecipe` 语义：备份恢复 ≠ 编辑）——恢复后菜谱在库中的身份与导出前完全一致，round-trip 测试以 `toEqual` 全等断言锁定。

### 测试强断言

- 守恒不变量：`imported + skipped = 总数`、`skipped = skippedIds + invalidIds 长度`
- round-trip：导出 → 清库 → 导入 → 全量恢复且字段零改写
- 顶层 400 与单条跳过的分界有专测

## 为什么这么做

| 决策 | 理由 |
| --- | --- |
| JSON 单文件而非 zip data/ 目录 | 页面内自助操作无需登服务器；格式透明可手改；规模（几百道菜）下单文件体积无压力 |
| 单条失败跳过而非整体 400 | 部分损坏的备份文件（手改/旧版本字段漂移）应尽量多地恢复——「能救多少救多少+如实报告」优于「一票否决」 |
| 已存在 id 跳过而非覆盖 | 导入是**补**不是**盖**：防旧备份覆盖新库中已编辑的菜谱；覆盖语义留给用户手动删后重导 |
| putRecipe 遇非法 id throw → 导入侧捕获计 invalid | 静默跳过会让用户以为导入成功实际丢条目；计入 invalidIds 让报告如实（与路径安全守卫衔接） |
| 目录直备作为主通道 | 页面导出依赖服务可达；目录复制连服务挂了都能救 |

## 优缺点

**优点**

- 双通道互为冗余：日常靠目录快照，跨实例迁移靠页面导入导出
- 三分支导入报告（imported/skipped/invalidIds）让每次导入的结果完全可预期
- 导入是幂等安全的（同 id 跳过），重复导入不会产生重复数据
- 导出文件名带日期，多份备份可区分

**缺点与已知边界**

- `putRecipe` 磁盘级故障（满/权限）会中断导入循环（整体 500，已导入部分无报告）——环境故障级，单人场景低概率，伪装成 invalid 反而误导，故有意不捕获（deferred 裁定）
- 大库（千道+）单 JSON 导出/导入未做分页流式（当前规模无感）
- 导入不做字段迁移：旧版本新增字段的 schema 漂移靠 invalid 上报暴露，需手动处理
- 无自动定时备份（依赖用户手动目录快照或页面导出）

## 架构位置

```
设置页 ──GET /api/backup──► listRecipes ──► JSON blob 下载
设置页 ──POST /api/backup──► 逐条 getRecipe 查重 ──► putRecipe（原 id 原子写）──► data/recipes/
用户 ──目录复制/同步──► data/ 整目录快照（主通道）
```
