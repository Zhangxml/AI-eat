# 模块：部署与运行（run.sh / Dockerfile / docker-compose）

> 代码位置：`run.sh`（裸机脚本）、`Dockerfile`（镜像）、`docker-compose.yml`（编排）、
> `.env.example`（配置模板）、`next.config.ts`（条件 standalone）
> 验收形态：局域网服务器启动，手机浏览器 `http://服务器IP:8888` 直连，零配置

## 做什么

把应用跑在局域网服务器上，手机/平板/电脑免安装直连使用；数据落服务端 `data/` 目录持久化；配置经 `.env` 注入且不入 git。

## 怎么做的

### 双部署形态

**裸机（run.sh）**——推荐日常使用：

```bash
./run.sh          # 无 .next/BUILD_ID 才构建（重启快），PORT 默认 8888，nohup 后台
./run.sh status   # 查看状态与局域网地址
./run.sh restart  # 停止 + 删 .next 强制重建（改代码后用）
./run.sh stop     # 停止（setsid 进程组 + PID 文件，收割 npm/sh/next-server 整组）
```

进程管理弃用 `pkill -f`：next-server 进程名与命令行不符（`pgrep -f "next start"` 只能杀到中间 sh 包装进程），cwd 匹配会误杀同目录 dev 进程——setsid 让服务成为独立进程组，`kill -- -PID` 组收割，start/stop/status 由 PID 文件串起。

**Docker（compose）**：

```bash
cp .env.example .env && vim .env
docker compose up -d --build    # 宿主机 8888 → 容器 3000，./data 挂载，env_file 注入
```

- 三段构建（deps → builder → runner，node:20-alpine）；builder 阶段 `ENV DOCKER_BUILD=1` 触发 `next.config.ts` 的条件 standalone 输出（裸机 `next start` 不受影响）
- runner 用镜像内置 `node` 用户（uid 1000）；**不用 `nextjs` 用户**（node:20-alpine 不存在该用户，曾是构建必败的 Critical）
- **数据目录归属（部署必读）**：`data/` 在 `.gitignore` 里，新克隆不存在。若不先 `mkdir -p ./data` 就 `docker compose up`，
  docker daemon 会以 `root:root` 创建该目录，容器内 uid 1000 写不进去——表现为「保存菜谱/改设置全 500」，
  且 `appendAccessLog` 会静默吞掉日志写失败，问题更隐蔽。**镜像内 `mkdir/chown /app/data` 无效**：
  bind mount `./data:/app/data` 会整体覆盖该路径，写权限只取决于宿主机目录属主。README 已在 compose 步骤前加 `mkdir -p ./data`。
  排查：`stat -c %u ./data` 必须等于 **1000**（容器内 `node` 的 uid）——即使 `ls -ld` 显示的是「你自己的用户」，只要你的 uid 不是 1000（部分发行版/企业镜像首用户是 1001）容器照样写不进。修正：`sudo chown -R 1000:1000 ./data`，或在 compose 的 service 下加 `user: "1000:1000"`（不依赖宿主机 chown，更稳）
- standalone 产物手动 COPY 三件套：server.js、`.next/static`（放错根级会 404 白屏——等效验收抓到的真实 bug）、public；`data/` 不进镜像
- `.dockerignore` 排除 data/.env：密钥与数据永不进镜像层

### 配置注入

`.env`（gitignore 排除）→ 裸机由 shell 读，Docker 由 compose `env_file + environment 透传`。变量清单见 `.env.example`（AI 三项/PASSWORD/DELETE_ENABLED/DELETE_PASSWORD）。

`AI_EAT_DATA_DIR` 语义说明（审计修复 #9）：该变量**特指菜谱库目录**（data/recipes 的位置），不影响其他文件落点——访问日志固定写在其父目录的 `logs/` 子目录（`data/logs/access.jsonl`），与菜谱库同级、同受数据卷保护；行为不变，仅文档化。

### 端口约定

裸机 `PORT` 默认 **8888**（可用环境变量覆盖）；Docker 容器内固定 3000、宿主机映射 8888。`HOSTNAME=0.0.0.0` 监听所有网卡是局域网设备可达的前提。

## 为什么这么做

| 决策 | 理由 |
| --- | --- |
| 条件 standalone 而非全局 | standalone 下没有 `next start`，全局开启会破坏裸机形态；`DOCKER_BUILD=1` 旗标让两种形态共存一个 config |
| 无产物跳过构建 | 每次 start 都全量 build 拖慢重启；BUILD_ID 探测 + restart 显式删产物，兼顾快与新鲜度 |
| 容器内 3000、映射 8888 | 容器内固定非特权端口（node 用户绑不上 <1024 也没关系）；宿主机端口集中在一处（compose）好改 |
| node 用户而非自建用户 | uid 1000 与宿主机 bind mount 权限天然匹配；自建 uid 1001 会导致容器写 `./data` EACCES |
| `.env` 不入库 + `.env.example` 入库 | Key 等秘密与配置结构的分离；新部署 `cp .env.example .env` 即有完整清单 |
| volume 挂 `./data` | 与 `recipesDir()` 默认 `<cwd>/data/recipes`（cwd=/app）路径推演一致；宿主机直接可见菜谱文件 |

## 优缺点

**优点**

- 一台裸机一条命令起服务；Docker 一条命令起服务——形态互补（裸机调试方便、Docker 隔离干净）
- 数据、配置、代码三者分离（data 卷 / .env / 镜像），升级镜像不丢数据
- run.sh 的 PID 文件方案对重复 start、无 PID stop、启动失败清理均有处理且实测闭环
- 已知限制在 README 如实披露（AI 内容未核实/营养估算/Docker 待真机补验）

**缺点与已知边界**

- Docker 真实 `compose up --build` 与 volume 双向可见性尚未在真机验收（开发机无 Docker 运行时，standalone 等效验收已过；**部署后需补验一次**）
- run.sh PID 复用边界：组长死后 PID 被无关进程复用时 stop 可能误判（单人场景概率低；端口预检兜底）
- 容器内 node 直作 PID 1 无 init 进程（standalone server 不派生子进程，无僵尸风险；`docker stop` 依赖进程自身处理 SIGTERM）
- 宿主机 uid≠1000 时 `./data` 需手动 chown

## 架构位置

```
手机/平板 ──http://服务器IP:8888──► [宿主机端口]
                                     ├─ 裸机：next start (PORT=8888) ──┐
                                     └─ Docker: 8888→3000 映射 ────────┤
                                                                        ▼
                                              Next.js 单进程（页面 + API 路由）──► /app/data（volume）
配置：.env ──shell / env_file──► 进程环境变量（AI 三项/PASSWORD/DELETE_*）
```
