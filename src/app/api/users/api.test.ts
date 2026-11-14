// /api/users 单测：仅管理员、绝不含 passwordHash、建号/改密/禁用/删除的约束
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { GET, POST } from './route'
import { PATCH, DELETE } from './[id]/route'
import { enableMultiUser, makeSession } from '@/lib/test-helpers'
import { listUsers } from '@/lib/user-store'

const json = (body: unknown, cookie?: string, method = 'POST') =>
  new Request('http://x/api/users', {
    method,
    body: JSON.stringify(body),
    headers: cookie
      ? { 'content-type': 'application/json', cookie }
      : { 'content-type': 'application/json' },
  })

const ctxOf = (id: string) => ({ params: Promise.resolve({ id }) })

describe('/api/users', () => {
  let root: string
  let prevEnv: Record<string, string | undefined>

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-eat-users-api-'))
    prevEnv = {
      AI_EAT_DATA_DIR: process.env.AI_EAT_DATA_DIR,
      SESSION_SECRET: process.env.SESSION_SECRET,
    }
    process.env.AI_EAT_DATA_DIR = path.join(root, 'recipes')
    process.env.SESSION_SECRET = 'test-secret-users-api-0123456789'
  })

  afterEach(async () => {
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    await fs.rm(root, { recursive: true, force: true })
  })

  it('尚未初始化（旧模式）→ 409，且不能借此抢占管理员', async () => {
    // 未建任何用户：users.json 与 users/ 都不存在
    const res = await POST(json({ name: '陌生人', password: 'hack1234' }))
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: string }).error).toContain('尚未初始化')
    expect((await GET(new Request('http://x/api/users'))).status).toBe(409)
  })

  it('未登录 → 401；member → 403；admin → 200', async () => {
    const admin = await enableMultiUser()
    const member = await makeSession('成员', 'member')
    expect((await GET(new Request('http://x/api/users'))).status).toBe(401)
    expect(
      (await GET(new Request('http://x/api/users', { headers: { cookie: member.cookie } }))).status,
    ).toBe(403)
    expect(
      (await GET(new Request('http://x/api/users', { headers: { cookie: admin.cookie } }))).status,
    ).toBe(200)
  })

  it('GET 列表绝不含 passwordHash（红线）', async () => {
    const admin = await enableMultiUser()
    const res = await GET(new Request('http://x/api/users', { headers: { cookie: admin.cookie } }))
    const body = await res.json()
    expect(JSON.stringify(body)).not.toContain('passwordHash')
    expect(JSON.stringify(body)).not.toContain('scrypt$')
    const users = (body as { users: { id: string; name: string; role: string }[] }).users
    expect(users.map(u => u.name)).toEqual(['管理员'])
    expect(users[0].role).toBe('admin')
  })

  it('POST 建号：默认 member；可指定 admin；重名 400；密码过短 400', async () => {
    const admin = await enableMultiUser()
    const ok = await POST(json({ name: '妈妈', password: 'mama-1234' }, admin.cookie))
    expect(ok.status).toBe(201)
    const created = (await ok.json()) as { user: { name: string; role: string } }
    expect(created.user.role).toBe('member')

    expect((await POST(json({ name: '妈妈', password: 'x12345' }, admin.cookie))).status).toBe(400)
    expect((await POST(json({ name: '小明', password: 'abc' }, admin.cookie))).status).toBe(400)

    const asAdmin = await POST(json({ name: '爸爸2', password: 'papa-1234', role: 'admin' }, admin.cookie))
    expect(asAdmin.status).toBe(201)
    expect(((await asAdmin.json()) as { user: { role: string } }).user.role).toBe('admin')
  })

  it('POST 建号后该用户可登录（哈希正确写入）', async () => {
    const admin = await enableMultiUser()
    await POST(json({ name: '妈妈', password: 'mama-1234' }, admin.cookie))
    // 直接走 /api/auth 登录（同模块内的真实校验路径）
    const { POST: authPost } = await import('@/app/api/auth/route')
    const login = await authPost(
      new Request('http://x/api/auth', {
        method: 'POST',
        body: JSON.stringify({ username: '妈妈', password: 'mama-1234' }),
        headers: { 'content-type': 'application/json' },
      }),
    )
    expect(login.status).toBe(200)
  })

  it('PATCH 改密 → 该用户旧会话失效', async () => {
    const admin = await enableMultiUser()
    const member = await makeSession('成员', 'member')
    const patchRes = await PATCH(json({ password: 'newpass-1234' }, admin.cookie, 'PATCH'), ctxOf(member.user.id))
    expect(patchRes.status).toBe(200)

    // 旧会话已失效：访问受保护接口应 401
    const { GET: settingsGet } = await import('@/app/api/settings/route')
    const r = await settingsGet(
      new Request('http://x/api/settings', { headers: { cookie: member.cookie } }),
    )
    expect(r.status).toBe(401)
  })

  it('PATCH 禁用 → 该用户无法再访问', async () => {
    const admin = await enableMultiUser()
    const member = await makeSession('成员', 'member')
    expect((await PATCH(json({ disabled: true }, admin.cookie, 'PATCH'), ctxOf(member.user.id))).status).toBe(200)
    const { GET: settingsGet } = await import('@/app/api/settings/route')
    expect(
      (await settingsGet(new Request('http://x/api/settings', { headers: { cookie: member.cookie } }))).status,
    ).toBe(401)
  })

  it('管理员账号一律不可禁用/删除（即使还有其他管理员）', async () => {
    const admin = await enableMultiUser()
    const admin2 = await makeSession('管理员乙', 'admin')
    const member = await makeSession('成员', 'member')

    // 有两个管理员时，仍不允许禁用/删除其中任意一个
    expect((await PATCH(json({ disabled: true }, admin.cookie, 'PATCH'), ctxOf(admin2.user.id))).status).toBe(400)
    expect((await PATCH(json({ disabled: true }, admin.cookie, 'PATCH'), ctxOf(admin.user.id))).status).toBe(400)
    // 删除也不行（即便是别人删自己以外的管理员）
    expect((await DELETE(json({ confirm: '管理员乙' }, admin.cookie, 'DELETE'), ctxOf(admin2.user.id))).status).toBe(400)
    expect((await DELETE(json({ confirm: '管理员' }, admin2.cookie, 'DELETE'), ctxOf(admin.user.id))).status).toBe(400)

    // 两个 admin 都还在
    expect((await listUsers()).filter(u => u.role === 'admin')).toHaveLength(2)

    // 普通成员仍可被禁用/删除
    expect((await PATCH(json({ disabled: true }, admin.cookie, 'PATCH'), ctxOf(member.user.id))).status).toBe(200)
    expect((await PATCH(json({ disabled: false }, admin.cookie, 'PATCH'), ctxOf(member.user.id))).status).toBe(200)
    expect((await DELETE(json({ confirm: '成员' }, admin.cookie, 'DELETE'), ctxOf(member.user.id))).status).toBe(204)
  })

  it('不能降级/禁用/删除最后一个管理员', async () => {
    const admin = await enableMultiUser()
    expect((await PATCH(json({ role: 'member' }, admin.cookie, 'PATCH'), ctxOf(admin.user.id))).status).toBe(400)
    expect((await PATCH(json({ disabled: true }, admin.cookie, 'PATCH'), ctxOf(admin.user.id))).status).toBe(400)
    expect((await DELETE(json({ confirm: '管理员' }, admin.cookie, 'DELETE'), ctxOf(admin.user.id))).status).toBe(400)
  })

  it('不能删除自己；删除他人需二次确认并连带删数据目录', async () => {
    const admin = await enableMultiUser()
    const bob = await makeSession('鲍勃', 'member')

    // 删自己
    expect((await DELETE(json({ confirm: '管理员' }, admin.cookie, 'DELETE'), ctxOf(admin.user.id))).status).toBe(400)
    // 未确认
    expect((await DELETE(json({}, admin.cookie, 'DELETE'), ctxOf(bob.user.id))).status).toBe(400)
    // 确认错名字
    expect((await DELETE(json({ confirm: '错名' }, admin.cookie, 'DELETE'), ctxOf(bob.user.id))).status).toBe(400)
    // 正确确认
    expect((await DELETE(json({ confirm: '鲍勃' }, admin.cookie, 'DELETE'), ctxOf(bob.user.id))).status).toBe(204)
    expect((await listUsers()).map(u => u.name)).toEqual(['管理员'])
  })

  it('PATCH/DELETE 不存在的用户 → 404', async () => {
    const admin = await enableMultiUser()
    expect((await PATCH(json({ name: 'x' }, admin.cookie, 'PATCH'), ctxOf('u-deadbeef'))).status).toBe(404)
    expect((await DELETE(json({ confirm: 'x' }, admin.cookie, 'DELETE'), ctxOf('u-deadbeef'))).status).toBe(404)
  })

  it('删除时数据目录删不掉 → 500 且账号保留（不制造数据黑户）', async () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) return // root 不受权限位限制
    const admin = await enableMultiUser()
    const bob = await makeSession('待删', 'member')
    await fs.mkdir(path.join(root, 'users', bob.user.id, 'recipes'), { recursive: true })
    // 让 users/ 不可写：rm(userDir) 会失败
    await fs.chmod(path.join(root, 'users'), 0o500)
    const res = await DELETE(json({ confirm: '待删' }, admin.cookie, 'DELETE'), ctxOf(bob.user.id))
    expect(res.status).toBe(500)
    expect(((await res.json()) as { error: string }).error).toContain('账号未删除')
    await fs.chmod(path.join(root, 'users'), 0o755)
    // 账号仍在，管理员可以重试；不会出现「账号没了、目录还在」
    expect((await listUsers()).some(u => u.id === bob.user.id)).toBe(true)
  })
})
