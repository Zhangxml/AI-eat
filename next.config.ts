import type { NextConfig } from "next";

// 仅 Docker 构建时启用 standalone 输出（DOCKER_BUILD 由 Dockerfile builder 阶段注入）；
// 裸机不设该变量，output 保持 undefined，确保 next start 正常工作（standalone 产物没有 next start）
const nextConfig: NextConfig = {
  output: process.env.DOCKER_BUILD === "1" ? "standalone" : undefined,
};

export default nextConfig;
