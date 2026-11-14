// 运行模式判定：由 env.PASSWORD 唯一决定。
//
// - `PASSWORD` 空 → 免密单用户（版本一兼容）：系统只有一个身份（最早的管理员），
//   其他账号不可登录但数据保留；
// - `PASSWORD` 非空 → 密码模式：管理员用 PASSWORD，其他用户用各自账号密码。
//
// 为什么单独成模块：middleware / API 守卫 / 登录页 / 配置接口 / 用户管理都要判同一个条件。
// 散落成 `process.env.PASSWORD` 一定会漏判，典型故障是「界面隐藏了用户管理，但 API 仍可调用」。
//
// 注意：PASSWORD 是启动时读取的 env，改动必须重启进程才生效（与 AI_MODEL 同理）。
export function isPasswordlessMode(): boolean {
  return (process.env.PASSWORD ?? '') === ''
}
