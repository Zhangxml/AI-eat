// /api/settings 单测：GET 返回默认、PATCH 局部更新、未知键 400、鉴权、写失败 500
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import { promises as fs } from 'node:fs'
import { GET, PATCH } from './route'
import { enableMultiUser, makeSession } from '@/lib/test-helpers'
import { createUser, userSettingsPath, type User } from '@/lib/user-store'

const patchReq = (body: unknown, cookie?: string) =>
  new Request('http://x/api/settings', {
    method: 'PATCH',
    body: JSON.stringify(body),
    headers: cookie
      ? { 'content-type': 'application/json', cookie }
      : { 'content-type': 'application/json' },
  })

const getReq = (cookie?: string) =>
  new Request('http://x/api/settings', { headers: cookie ? { cookie } : {} })

describe('/api/settings', () => {
  let dir: string
  // 免密模式下身份是「最早的管理员」；预建出来，便于断言用户私有的 settings 文件
  let admin: User

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-eat-settings-api-'))
    process.env.AI_EAT_DATA_DIR = `${dir}/recipes`
    delete process.env.PASSWORD // 本文件默认免密模式；鉴权用例自己切回密码模式
    admin = await createUser({ name: '管理员', passwordHash: 'h' })
  })

  /** 当前用户（免密模式下即最早的管理员）的设置文件路径 */
  const settingsFile = () => userSettingsPath(admin.id)

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
    delete process.env.AI_EAT_DATA_DIR
    delete process.env.PASSWORD
  })

  it('GET：文件不存在时返回默认设置', async () => {
    const res = await GET(new Request('http://x/api/settings'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ version: 1, style: 'home' })
  })

  it('PATCH：改 style 后 GET 能读到，且落盘', async () => {
    const res = await PATCH(patchReq({ style: 'creative' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ version: 1, style: 'creative' })
    expect(await (await GET(new Request('http://x/api/settings'))).json()).toEqual({
      version: 1,
      style: 'creative',
    })
    const onDisk = JSON.parse(await fs.readFile(settingsFile(), 'utf8'))
    expect(onDisk.style).toBe('creative')
  })

  it('PATCH：未知键 / 非法值 → 400 中文错误，且不写盘', async () => {
    for (const body of [{ stlye: 'creative' }, { style: 'exotic' }, { version: 9 }]) {
      const res = await PATCH(patchReq(body))
      expect(res.status, JSON.stringify(body)).toBe(400)
      expect(((await res.json()) as { error: string }).error).toBeTruthy()
    }
    // 免密模式首次请求会写一份默认设置（home），所以这里断言「仍是默认值」而不是「文件不存在」
    const onDisk = JSON.parse(await fs.readFile(settingsFile(), 'utf8'))
    expect(onDisk).toEqual({ version: 1, style: 'home' })
  })

  it('PATCH：空对象 → 200 且保持原值（局部更新语义）', async () => {
    await PATCH(patchReq({ style: 'creative' }))
    const res = await PATCH(patchReq({}))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ version: 1, style: 'creative' })
  })

  it('启用多用户后无会话 → GET/PATCH 均 401；带会话正常', async () => {
    process.env.PASSWORD = 'test-password-default' // 切回密码模式
    const session = await enableMultiUser('管理员2')
    expect((await GET(getReq())).status).toBe(401)
    expect((await PATCH(patchReq({ style: 'creative' }))).status).toBe(401)
    expect((await GET(getReq(session.cookie))).status).toBe(200)
    expect((await PATCH(patchReq({ style: 'creative' }, session.cookie))).status).toBe(200)
  })

  it('推荐风格按用户隔离：A 改 creative 不影响 B', async () => {
    process.env.PASSWORD = 'test-password-default' // 切回密码模式
    await enableMultiUser('管理员2')
    const a = await makeSession('甲', 'member')
    const b = await makeSession('乙', 'member')
    expect((await PATCH(patchReq({ style: 'creative' }, a.cookie))).status).toBe(200)
    const aBody = await (await GET(getReq(a.cookie))).json()
    const bBody = await (await GET(getReq(b.cookie))).json()
    expect(aBody).toEqual({ version: 1, style: 'creative' })
    expect(bBody).toEqual({ version: 1, style: 'home' })
  })

  it('写盘失败（用户目录只读）→ 500 中文错误', async () => {
    // 设置写在 users/<uid>/settings.json，因此要让该用户目录不可写
    const userDir = path.dirname(settingsFile())
    await fs.mkdir(userDir, { recursive: true })
    await fs.chmod(userDir, 0o555)
    try {
      const res = await PATCH(patchReq({ style: 'creative' }))
      expect(res.status).toBe(500)
      expect(((await res.json()) as { error: string }).error).toMatch(/保存失败/)
    } finally {
      await fs.chmod(userDir, 0o755)
    }
  })
})
