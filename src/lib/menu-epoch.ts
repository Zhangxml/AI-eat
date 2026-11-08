// 菜单代次守卫（审查修复）：点菜页存在「重置菜单后旧请求写回」的竞态。
// 场景：菜单A 里点某菜「生成菜谱」→ 请求在途 → 用户重新点菜得到菜单B（可能含同名菜）
//       → 旧请求返回后按状态键写回，菜单B 的同一道菜会显示成菜单A 的菜谱内容。
// 解法：每次拿到新菜单就推进代次；请求发起时记录当时的代次，返回时若代次已变则丢弃结果。
// 抽成纯类便于单测（无 React、无网络）。
export class MenuEpoch {
  private current = 0

  /** 推进代次（获取到新菜单/重置菜单时调用），返回新代次 */
  bump(): number {
    this.current += 1
    return this.current
  }

  /** 当前代次（请求发起时记录用） */
  get value(): number {
    return this.current
  }

  /** 请求返回时判断是否已过期（期间菜单被替换过） */
  isStale(requestVersion: number): boolean {
    return requestVersion !== this.current
  }
}
