import { defineConfig } from 'vitest/config'

// Vitest 配置：
// - 仅收集 src 下的 *.test.ts 单测
// - 与 Next.js 保持一致的 @/* 路径别名（用 import.meta.dirname 避免 CJS 兼容告警）
// - tsconfig 指向 tsconfig.vitest.json（jsx 转译为普通 JS），避免 Next 的 "jsx": "preserve" 影响 vite 转换
export default defineConfig({
  tsconfig: 'tsconfig.vitest.json',
  resolve: {
    alias: {
      '@': new URL('./src', import.meta.url).pathname,
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
  },
})
