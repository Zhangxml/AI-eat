// 测试专用辅助：把「已启用多用户 + 已登录」的前置状态一次性搭好。
// 当前鉴权开关是 env.PASSWORD（非空=密码模式、空=免密单用户）——
// 因此测试必须先建用户、再签发会话。
import { createUser, type User, type UserRole } from './user-store'
import { issueSession } from './session'

export interface TestSession {
  user: User
  token: string
  /** 可直接放进 { headers: { cookie } } */
  cookie: string
}

/** 建立测试用户并签发会话（首个用户自动为 admin） */
export async function makeSession(
  name = '测试用户',
  role: UserRole = 'admin',
): Promise<TestSession> {
  const user = await createUser({ name, passwordHash: 'scrypt$placeholder', role })
  const token = await issueSession({ uid: user.id, ver: user.sessionVersion })
  return { user, token, cookie: `ai-eat-session=${token}` }
}

/** 仅启用多用户（不关心会话）：建一个用户，返回其 cookie 供「有效会话」用例复用 */
export async function enableMultiUser(name = '管理员'): Promise<TestSession> {
  return makeSession(name, 'admin')
}
