# AI-eat 生产镜像：node:20-alpine 三段构建（deps → builder → runner）
# builder 阶段设 DOCKER_BUILD=1 触发 next.config.ts 的 standalone 输出；
# standalone 产物自带 server.js（无 next start），runner 直接 node server.js

# ---- 阶段 1：仅装生产依赖（package.json/prune 不与源码混合，npm ci 缓存友好）----
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---- 阶段 2：构建 standalone 产物 ----
FROM node:20-alpine AS builder
WORKDIR /app
# 触发 next.config.ts 的 output: 'standalone'（裸机构建不受影响）
ENV DOCKER_BUILD=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ---- 阶段 3：最小运行层（仅 standalone 产物 + 生产依赖）----
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
# 0.0.0.0 才能让容器端口映射出去；容器内固定 3000，由 compose 映射到宿主机 8888
ENV HOSTNAME=0.0.0.0
ENV PORT=3000

# data 目录不 COPY 进镜像：运行时由 volume 挂载（./data:/app/data），保持数据与镜像解耦
COPY --from=builder --chown=node:node /app/.next/standalone ./
# standalone 不含静态资源，需手动补齐（Next 官方标准做法，本机等效验收确认）：
# 页面 JS/CSS chunk 必须放 .next/static（运行时按 /_next/static/* 从该目录读取，
# 放错为根级 static/ 会全量 404 导致页面白屏）；public 按原始相对路径放置
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public

# 非 root 运行：node:20-alpine 只内置 node 用户（uid/gid 1000，无 nextjs 用户）。
# 数据目录不在这里 mkdir/chown——compose 的 bind mount ./data:/app/data 会整体覆盖镜像内该路径，
# 镜像里的属主设置对挂载点无效，实际写权限取决于【宿主机 ./data 的属主】。
# 因此 README 要求先由用户 `mkdir -p ./data`（属主 uid 1000），见 README「数据目录归属」。
USER node

EXPOSE 3000

CMD ["node", "server.js"]
