import { describe, expect, it } from 'vitest'
import { resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import { resolveConnectionOptions } from '../src/index.js'
import { RATE_LIMIT_WAIT_CAP_MS } from '../src/constants.js'

describe('resolveConnectionOptions', () => {
  it('keeps the harness normal defaults and only raises the accepted provider delay', () => {
    // 省略配置时本插件自持一份默认：别的字段逐项等于宿主 normal 默认，
    // 只把 maxDelayMs 抬高到 429 等待硬上限——providerRetryAfterMs 只在 ≤ 它的
    // 才被重试执行器采纳，而 CodeBuddy 的重置时刻常在几十分钟之后。
    const base = resolveRetryPolicy(undefined, 'test')
    const policy = resolveConnectionOptions().retryPolicy
    expect(policy?.mode).toBe('normal')
    expect(policy).toMatchObject({
      initialDelayMs: base.initialDelayMs,
      jitterRatio: base.jitterRatio,
      maxRetries: base.maxRetries,
    })
    expect(policy?.mode === 'normal' ? [...policy.retryableCodes] : []).toEqual([...base.retryableCodes])
    expect(policy?.maxDelayMs).toBe(RATE_LIMIT_WAIT_CAP_MS)
    expect(RATE_LIMIT_WAIT_CAP_MS).toBe(5 * 60 * 60 * 1000)
    // 本地退避够不到这个上限：5 次、初始 500ms，最后一次也只有 8 秒。
    expect(policy?.maxDelayMs).toBeGreaterThan(base.initialDelayMs * 2 ** (base.maxRetries - 1))
  })

  it('honors a configured normal retry policy', () => {
    const options = resolveConnectionOptions({
      retryPolicy: { mode: 'normal', maxRetries: 7, retryableCodes: ['TRANSPORT'] },
    })
    expect(options.retryPolicy).toMatchObject({ mode: 'normal', maxRetries: 7, retryableCodes: ['TRANSPORT'] })
  })

  it('honors an always retry policy', () => {
    const options = resolveConnectionOptions({ retryPolicy: { mode: 'always' } })
    expect(options.retryPolicy).toMatchObject({ mode: 'always' })
  })

  it('lets an explicit maxDelayMs win over the plugin default', () => {
    const options = resolveConnectionOptions({
      retryPolicy: { mode: 'normal', backoff: { maxDelayMs: 1_000 } },
    })
    expect(options.retryPolicy?.maxDelayMs).toBe(1_000)
  })
})

