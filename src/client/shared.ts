// CodeBuddyTab / UsageIndicator 共享的客户端工具；随 client 单文件 bundle 打进 dist/client.js。
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'

/** 网关 Client face 返回 RemoteResult 包装：统一解包，失败按错误抛出让调用方走错误分支。 */
export async function unwrap<T>(call: Promise<RemoteResult<T>>): Promise<T> {
  const result = await call
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

/** 与 promise 竞速：超时以 reject 让既有 catch 分支兜底（读取方都走 try/catch）。 */
export function withTimeout<T>(call: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error('timeout')), ms)
    call.then(
      value => { window.clearTimeout(timer); resolve(value) },
      error => { window.clearTimeout(timer); reject(error) },
    )
  })
}

/** 有则取、无则兜底：host/client 产物错配时缺字段的旧 view 不抛、不产 NaN。 */
export function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/**
 * 积分显示格式：有小数最多保留两位，整数保持整数（1.50 → '1.5'，1.00 → '1'）。
 * 非法值按 0 兜底，避免 'NaN' 直接上屏。
 */
export function formatCredits(value: number): string {
  if (!Number.isFinite(value)) return '0'
  return value.toFixed(2).replace(/\.?0+$/, '')
}
