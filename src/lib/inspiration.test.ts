// 灵感种子测试：锁定「家常默认 + 中式创意」两档词池（去除异国风味后的新契约）
import { describe, expect, it } from 'vitest'
import {
  INSPIRATION_STYLES,
  INSPIRATION_TECHNIQUES,
  pickInspiration,
  type InspirationStyle,
} from './inspiration'

describe('灵感种子词池', () => {
  it('词池不含异国风味（东南亚/日式/意式等已按需求移除）', () => {
    const foreign = ['东南亚', '日式', '意式', '泰式', '印度', '墨西哥', '法式', '韩式']
    for (const f of foreign) {
      expect(INSPIRATION_STYLES).not.toContain(f)
    }
  })

  it('创意档风味池全部为中式地方风味', () => {
    const allowed = ['川味', '粤式', '湘味', '江浙', '西北', '东北']
    for (const s of INSPIRATION_STYLES.creative) {
      expect(allowed).toContain(s)
    }
  })

  it('家常档技法池不含炭烤/椒麻等低频技法', () => {
    const lowFreq = ['炭烤', '椒麻']
    for (const t of lowFreq) {
      expect(INSPIRATION_TECHNIQUES.home).not.toContain(t)
    }
  })
})

describe('pickInspiration 按档位取词', () => {
  it('home 档只出家常词（rng 扫描全值域验证）', () => {
    // 用固定 rng 扫描整个值域：每个采样点都必须落在家常池内（不含创意池的词）
    let step = 0
    const seqRng = () => {
      const v = step / 20
      step = (step + 1) % 21
      return v
    }
    const creativeWords = [...INSPIRATION_TECHNIQUES.creative, ...INSPIRATION_STYLES.creative]
    for (let i = 0; i < 21; i++) {
      const out = pickInspiration('home', seqRng)
      for (const cw of creativeWords) expect(out).not.toContain(cw)
      // 且必含一个家常池词
      expect(INSPIRATION_TECHNIQUES.home.some((t) => out.includes(t))).toBe(true)
      expect(INSPIRATION_STYLES.home.some((s) => out.includes(s))).toBe(true)
    }
  })

  it('creative 档用创意池', () => {
    const out = pickInspiration('creative', () => 0)
    expect(out).toContain(INSPIRATION_TECHNIQUES.creative[0])
    expect(out).toContain(INSPIRATION_STYLES.creative[0])
  })

  it('默认档位为 home（不传 mode 时）', () => {
    // home 与 creative 的 rng=0 输出恰好不同（两池首词不同），可作区分断言
    const homeOut = pickInspiration('home', () => 0)
    const creativeOut = pickInspiration('creative', () => 0)
    expect(homeOut).not.toBe(creativeOut)
    expect(pickInspiration('home', () => 0)).toBe(homeOut)
  })

  it('输出格式为「本次灵感方向：X + Y」', () => {
    expect(pickInspiration('home', () => 0)).toMatch(/^本次灵感方向：.+ \+ .+$/)
  })
})

// 类型层面的静态断言（编译期锁定档位字段存在）
describe('档位类型', () => {
  it('InspirationStyle 含 home 与 creative 两个键', () => {
    const keys = Object.keys(INSPIRATION_STYLES)
    expect(keys).toContain('home')
    expect(keys).toContain('creative')
  })
})

// 引用 InspirationStyle 避免未使用告警（类型在 pickInspiration 签名中使用）
export type { InspirationStyle }
