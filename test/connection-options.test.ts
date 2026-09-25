import { describe, expect, it } from 'vitest'
import { resolveConnectionOptions } from '../src/index.js'

describe('resolveConnectionOptions', () => {
  it('resolves harness default retry policy on omission', () => {
    const options = resolveConnectionOptions()
    expect(options.retryPolicy).toMatchObject({ mode: 'normal' })
    expect(options.retryPolicy?.maxRetries).toBeGreaterThan(0)
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
})
