// 买什么表单的校验与上限：前端（点菜页）与服务端（/api/ai/menu）共用同一份常量与口径，
// 避免「前端允许 7 天、服务端只收 3 天」这类两侧漂移（此前 MAX_PEOPLE 在两处各写一份）。
// 纯函数，无 React / 无 IO，便于单测。

// 人数上限：与服务端一致；过大的人数是提示词放大与 token 成本的放大器
export const MAX_PEOPLE = 50
// 用餐天数上限：一周（硬限制，超出直接拒绝而非静默收敛）
export const MAX_DAYS = 7
// 口味偏好长度上限（字符）
export const MAX_TEXT_CHARS = 500

export interface MenuFormInput {
  peopleInput: string
  daysInput: string
  preference: string
}

export type MenuFormResult =
  | { ok: true; people: number; days: number; preference: string }
  | { ok: false; error: string }

// 校验点菜表单。规则按「人数 → 天数 → 偏好」顺序，命中即返回，避免多条错误同时堆叠。
// 天数留空视为 1 天（「不填就是买一餐」，与改造前行为一致）。
export function validateMenuForm(input: MenuFormInput): MenuFormResult {
  const people = Number(input.peopleInput)
  if (!Number.isInteger(people) || people < 1) {
    return { ok: false, error: '人数须为不小于 1 的整数' }
  }
  if (people > MAX_PEOPLE) {
    return { ok: false, error: `人数最多 ${MAX_PEOPLE} 人` }
  }

  // 天数：空串 → 1；其余必须为 1~MAX_DAYS 的整数
  const daysRaw = input.daysInput.trim()
  const days = daysRaw === '' ? 1 : Number(daysRaw)
  if (!Number.isInteger(days) || days < 1) {
    return { ok: false, error: `天数须为 1~${MAX_DAYS} 的整数` }
  }
  if (days > MAX_DAYS) {
    return { ok: false, error: `天数最多 ${MAX_DAYS} 天` }
  }

  const preference = input.preference.trim()
  if (preference.length > MAX_TEXT_CHARS) {
    return { ok: false, error: `口味偏好最多 ${MAX_TEXT_CHARS} 字` }
  }

  return { ok: true, people, days, preference }
}
