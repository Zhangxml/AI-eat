// 测试辅助：从 Set-Cookie 头里取出「名=值」对（只取第一个 ; 前的部分）
export function getCookieValue(setCookie: string | null): string | null {
  if (setCookie === null || setCookie === '') return null
  const first = setCookie.split(';')[0].trim()
  return first === '' ? null : first
}
