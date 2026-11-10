// /api/settings 单测：GET 返回默认、PATCH 局部更新、未知键 400、鉴权、写失败 500
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import { promises as fs } from 'node:fs'
import { GET, PATCH } from './route'
import { issueToken } from '@/lib/auth'

const patchReq = (body: unknown) =>
  new Request('http://x/api/settings', {
    method: 'PATCH',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })

describe('/api/settings', () => {
  let dir: string

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-eat-settings-api-'))
    process.env.AI_EAT_DATA_DIR = `${dir}/recipes`
  })

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
    const onDisk = JSON.parse(await fs.readFile(`${dir}/settings.json`, 'utf8'))
    expect(onDisk.style).toBe('creative')
  })

  it('PATCH：未知键 / 非法值 → 400 中文错误，且不写盘', async () => {
    for (const body of [{ stlye: 'creative' }, { style: 'exotic' }, { version: 9 }]) {
      const res = await PATCH(patchReq(body))
      expect(res.status, JSON.stringify(body)).toBe(400)
      expect(((await res.json()) as { error: string }).error).toBeTruthy()
    }
    await expect(fs.access(`${dir}/settings.json`)).rejects.toThrow()
  })

  it('PATCH：空对象 → 200 且保持原值（局部更新语义）', async () => {
    await PATCH(patchReq({ style: 'creative' }))
    const res = await PATCH(patchReq({}))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ version: 1, style: 'creative' })
  })

  it('启用 PASSWORD 后无会话 → GET/PATCH 均 401', async () => {
    process.env.PASSWORD = 'pw'
    try {
      expect((await GET(new Request('http://x/api/settings'))).status).toBe(401)
      expect((await PATCH(patchReq({ style: 'creative' }))).status).toBe(401)
      // 带合法会话可正常访问
      const token = issueToken()
      const ok = await GET(
        new Request('http://x/api/settings', { headers: { cookie: `ai-eat-session=${token}` } }),
      )
      expect(ok.status).toBe(200)
    } finally {
      delete process.env.PASSWORD
    }
  })

  it('写盘失败（目录只读）→ 500 中文错误', async () => {
    await fs.chmod(dir, 0o555)
    try {
      const res = await PATCH(patchReq({ style: 'creative' }))
      expect(res.status).toBe(500)
      expect(((await res.json()) as { error: string }).error).toMatch(/保存失败/)
    } finally {
      await fs.chmod(dir, 0o755)
    }
  })
})
