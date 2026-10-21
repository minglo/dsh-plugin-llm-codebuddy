/**
 * 倍率串归一化（宿主与客户端共用，**零依赖**）。
 *
 * 服务端有两种写法：目录 `credits` 是 `x0.29`（x 在前），促销
 * `discountedCredits` 是 `0.50x` / `0x`（x 在后）。两者都表示「积分倍率」，
 * 统一成 `xN` 才好在同一处比较与着色。
 *
 * 取第一个数字（连同它的小数位）并在前面加 `x`——保留服务端的小数位
 * （`x0.50` 不写成 `x0.5`），因为那是服务端自己的口径。
 */
export function normalizeCredits(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  const match = /(\d+(?:\.\d+)?)/.exec(raw)
  if (match === null) return undefined
  return `x${match[1]}`
}
