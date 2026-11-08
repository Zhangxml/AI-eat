// 买什么：重新点菜时的并发协作（点菜 vs 逐菜生成）
// 背景（无头浏览器实测复现）：旧菜单在「点菜中」仍可点「生成菜谱」，新菜单落地时
// setDishStates({}) 会静默丢掉用户已等出的菜谱；且单槽 abortRef 只能取消最后一个请求，
// 更早的在途请求会跑完并写回（注册表修掉这一漏取消）。本模块提供两块纯逻辑，UI 层只负责调用：
// 1) DishAborts：按菜名登记在途生成请求的 AbortController，支持「全部取消」
// 2) countUnsavedRecipes / buildRegenConfirmMessage：清空前告知用户会丢几道已生成的菜谱
// 无 React、无 IO，便于单测。

/** 在途逐菜生成请求的注册表：键为菜名（同名菜共用一份状态，故天然一对一） */
export class DishAborts {
  private controllers = new Map<string, AbortController>()

  /** 登记某道菜的在途请求（同名菜重复登记时旧引用被覆盖——旧请求已由按钮禁用挡住） */
  set(name: string, controller: AbortController): void {
    this.controllers.set(name, controller)
  }

  /**
   * 请求结束（成功/失败/中止）后移出登记表。
   * 传 controller 时做身份校验：只注销「自己那一次」的登记。
   * 必要性：旧请求的 finally 可能在「新菜单上对同名菜发起的新请求」登记之后才执行，
   * 无条件 delete 会把新请求的引用删掉，导致后续 abortAll / 卸载漏取消它。
   */
  delete(name: string, controller?: AbortController): void {
    if (controller !== undefined && this.controllers.get(name) !== controller) return
    this.controllers.delete(name)
  }

  /** 当前在途的菜名（测试与调试用） */
  names(): string[] {
    return [...this.controllers.keys()]
  }

  /**
   * 取消全部在途生成，返回被取消的菜名列表。
   * 返回列表让 UI 能把对应的「生成中…」复位成可重试，避免永远转圈。
   */
  abortAll(): string[] {
    const names = [...this.controllers.keys()]
    for (const c of this.controllers.values()) {
      c.abort()
    }
    this.controllers.clear()
    return names
  }
}

/**
 * 统计「已生成但还没入库」的菜谱数量。
 * 这些是重新点菜时真正会丢的东西——生成中的不算（中止即可，无成果损失）。
 */
export function countUnsavedRecipes(
  dishStates: Record<string, { phase: 'idle' | 'generating' | 'ready'; recipe?: unknown }>,
  savedNames: Record<string, boolean>,
): number {
  let count = 0
  for (const [name, st] of Object.entries(dishStates)) {
    if (st.phase === 'ready' && st.recipe !== undefined && !savedNames[name]) count += 1
  }
  return count
}

/**
 * 重新点菜前的二次确认文案；无已生成菜谱时返回 null（不值得打扰用户）。
 * 只统计「已生成未入库」——已入库的菜谱在菜谱库里，重新点菜不会丢失。
 */
export function buildRegenConfirmMessage(unsavedCount: number): string | null {
  if (unsavedCount <= 0) return null
  return `重新点菜会清空已生成的 ${unsavedCount} 道菜谱（未入库的会丢失），继续吗？`
}
