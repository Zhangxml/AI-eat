// 逐菜状态键的单测：同名菜必须拿到不同的键
// 背景：dishStates/savedNames/DishAborts 原以「菜名」为键，7 天菜单（最多 21 道）里
// AI 给出两道同名菜（如「米饭」「凉拌黄瓜」）时，点第一道会让两道一起变「已生成」，
// 第二道的菜谱永远看不到。键里带上菜单内下标即可区分。
import { describe, expect, it } from 'vitest'
import { dishKey } from './dish-key'

describe('dishKey 逐菜状态键', () => {
  it('同名菜在不同位置得到不同的键（核心：不再互相串状态）', () => {
    expect(dishKey(0, '米饭')).not.toBe(dishKey(5, '米饭'))
  })

  it('不同菜名在同一位置也不同', () => {
    expect(dishKey(0, '米饭')).not.toBe(dishKey(0, '面条'))
  })

  it('相同输入得到相同的键（可重复计算、可用于相等比较）', () => {
    expect(dishKey(3, '番茄炒蛋')).toBe(dishKey(3, '番茄炒蛋'))
  })

  it('键里保留菜名，便于调试与日志阅读', () => {
    expect(dishKey(2, '番茄炒蛋')).toContain('番茄炒蛋')
  })

  it('菜名里含冒号等字符时仍与其它菜不冲突', () => {
    // 单射性来自「下标是不含冒号的十进制整数，且分隔符取第一个冒号」：
    // (0, '1:x') → "0:1:x"，(1, 'x') → "1:x"，两者不同；
    // 菜名无法伪造出「更小的下标」，故不会与别的 (index, name) 拼出同一个键。
    expect(dishKey(0, '1:x')).not.toBe(dishKey(1, 'x'))
    expect(dishKey(10, 'x')).not.toBe(dishKey(1, '0:x'))
    expect(new Set([dishKey(0, 'a'), dishKey(1, 'a'), dishKey(0, 'b')]).size).toBe(3)
  })
})
