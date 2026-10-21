import { describe, expect, it } from 'vitest'
import { normalizeCredits } from '../src/rate.js'

describe('normalizeCredits（倍率串归一化）', () => {
  it('把目录格式 xN 原样保留', () => {
    expect(normalizeCredits('x0.29')).toBe('x0.29')
    expect(normalizeCredits('x5.00')).toBe('x5.00')
  })

  it('把带后缀的目录格式归一化', () => {
    expect(normalizeCredits('x0.34 credits')).toBe('x0.34')
  })

  it('把促销格式（数字在前、x 在后）翻成同一形式', () => {
    expect(normalizeCredits('0.50x')).toBe('x0.50')
    expect(normalizeCredits('0x')).toBe('x0')
  })

  it('没有数字就当作没有倍率', () => {
    expect(normalizeCredits('free')).toBeUndefined()
    expect(normalizeCredits('')).toBeUndefined()
    expect(normalizeCredits(undefined)).toBeUndefined()
  })
})
