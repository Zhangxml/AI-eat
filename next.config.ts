import type { NextConfig } from "next";

// 仅 Docker 构建时启用 standalone 输出（DOCKER_BUILD 由 Dockerfile builder 阶段注入）；
// 裸机不设该变量，output 保持 undefined，确保 next start 正常工作（standalone 产物没有 next start）
const nextConfig: NextConfig = {
  output: process.env.DOCKER_BUILD === "1" ? "standalone" : undefined,
  experimental: {
    // 客户端路由缓存的有效期：设为 0 表示「一次都不复用」。
    //
    // 为什么必须关掉：页面是静态预渲染的壳，Next 会在 `Link` 进视口时预取 RSC payload 并缓存 5 分钟。
    // 于是「管理员刚禁用某人 → 那人点底部 tab」时，浏览器直接拿**禁用前**缓存的 payload 渲染出
    // 整页骨架，服务端这次请求虽然已返回 303，但骨架已经画出来了——实测注入 300ms 延迟时闪 37 帧（约 600ms）。
    // 设为 0 后每次导航都向服务端确认，303 在骨架之前到达。
    //
    // 代价：每次 tab 切换多一次 RSC 请求（局域网约 10ms），换来「权限变更立即生效、不闪」。
    staleTimes: { static: 0, dynamic: 0 },
  },
};

export default nextConfig;
