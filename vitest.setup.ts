// Vitest 全局前置：默认进入「密码模式」。
//
// 为什么需要：应用现在有两种模式（见 src/lib/auth-mode.ts）——
//   env.PASSWORD 空   → 免密单用户（系统只有一个身份，任何请求都是管理员）
//   env.PASSWORD 非空 → 密码模式（需要登录）
// 绝大多数用例验证的是「鉴权是否生效」，必须在密码模式下才有意义；
// 若不设默认值，所有「无 Cookie → 401」的用例都会因为免密模式变成 200。
//
// 需要验证免密模式的用例，在自己的 beforeEach 里 `delete process.env.PASSWORD` 即可
// （全局 beforeEach 先执行，测试内的 beforeEach 后执行，可以覆盖）。
import { beforeEach } from 'vitest'

beforeEach(() => {
  if (process.env.PASSWORD === undefined) {
    process.env.PASSWORD = 'test-password-default'
  }
})
