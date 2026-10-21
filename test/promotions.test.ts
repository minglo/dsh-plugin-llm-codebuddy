import { describe, expect, it } from 'vitest'
import { effectiveRate, isPromotionActive, promotionFor, tierFor, windowTextOf } from '../src/promotions.js'

/** 2026-10-20 13:58 +08:00（vitest 把 TZ 钉在 Asia/Shanghai）。 */
const NOW = Date.parse('2026-10-20T13:58:00+08:00')

describe('isPromotionActive（促销当前是否生效）', () => {
  it('enabled=false 的促销永不生效', () => {
    expect(isPromotionActive({ id: 'p', enabled: false }, NOW)).toBe(false)
  })

  it('没有 schedule 的促销恒定生效', () => {
    expect(isPromotionActive({ id: 'p' }, NOW)).toBe(true)
  })

  it('每日窗口按分钟闭区间，23:59 覆盖到当天最后一分钟', () => {
    const promotion = { id: 'p', schedule: { timezone: 'Asia/Shanghai', daily: [{ start: '00:00', end: '23:59' }] } }
    expect(isPromotionActive(promotion, Date.parse('2026-10-20T23:59:30+08:00'))).toBe(true)
    // 注：brief 原文此处断言次日 00:00:30 为 false，但窗口 00:00–23:59 按
    // 「start ≤ t ≤ end（整分钟）」覆盖全天任意时区的每一分钟，不存在返回
    // false 的时刻；改成 true 才能与 brief 自己的判定规则自洽（见任务报告）。
    expect(isPromotionActive(promotion, Date.parse('2026-10-21T00:00:30+08:00'))).toBe(true)
  })

  it('跨零点的窗口拆成两段', () => {
    const promotion = { id: 'p', schedule: { timezone: 'Asia/Shanghai', daily: [{ start: '23:00', end: '07:50' }] } }
    expect(isPromotionActive(promotion, Date.parse('2026-10-20T23:30:00+08:00'))).toBe(true)
    expect(isPromotionActive(promotion, Date.parse('2026-10-21T03:00:00+08:00'))).toBe(true)
    expect(isPromotionActive(promotion, Date.parse('2026-10-21T07:50:00+08:00'))).toBe(true)
    expect(isPromotionActive(promotion, Date.parse('2026-10-21T08:00:00+08:00'))).toBe(false)
  })

  it('daily 缺省不做每日限制，daily 为空数组则永不生效', () => {
    expect(isPromotionActive({ id: 'p', schedule: { timezone: 'Asia/Shanghai' } }, NOW)).toBe(true)
    expect(isPromotionActive({ id: 'p', schedule: { timezone: 'Asia/Shanghai', daily: [] } }, NOW)).toBe(false)
  })

  it('绝对有效期圈住整体', () => {
    const promotion = { id: 'p', schedule: { validFrom: '2026-07-06T00:00:00+08:00', validUntil: '2026-11-01T00:00:00+08:00' } }
    expect(isPromotionActive(promotion, Date.parse('2026-10-20T13:58:00+08:00'))).toBe(true)
    expect(isPromotionActive(promotion, Date.parse('2026-11-02T00:00:00+08:00'))).toBe(false)
  })

  it('边界格式非法的窗口被丢弃，不影响其它窗口', () => {
    const promotion = { id: 'p', schedule: { timezone: 'Asia/Shanghai', daily: [{ start: '99:99', end: 'x' }] } }
    expect(isPromotionActive(promotion, NOW)).toBe(false)
  })
})

describe('effectiveRate（生效价）', () => {
  it('没有促销时基础价即当前价', () => {
    expect(effectiveRate('x0.29', undefined)).toEqual({ base: 'x0.29', current: 'x0.29', strikethrough: false, free: false })
  })

  it('replace 模式只给折扣价', () => {
    const promotion = { id: 'p', discount: { discountedCredits: '0x', displayMode: 'replace' } }
    expect(effectiveRate('x0.79', promotion)).toEqual({ base: 'x0.79', current: 'x0', strikethrough: false, free: true })
  })

  it('strikethrough 模式标记原价要划线', () => {
    const promotion = { id: 'p', discount: { discountedCredits: '0.50x', displayMode: 'strikethrough' } }
    expect(effectiveRate('x0.79', promotion)).toEqual({ base: 'x0.79', current: 'x0.50', strikethrough: true, free: false })
  })

  it('strikethrough 没有折扣值就不划线', () => {
    // displayMode 光说「划线」但 current === base：面板会把原价划掉、旁边再摆
    // 一个相同的现价，所以实现只在价格真变时才置位。
    const promotion = { id: 'p', discount: { displayMode: 'strikethrough' } }
    expect(effectiveRate('x0.79', promotion))
      .toEqual({ base: 'x0.79', current: 'x0.79', strikethrough: false, free: false })
  })

  it('只有 factor 时按基础价折算', () => {
    const promotion = { id: 'p', discount: { factor: 0.5 } }
    expect(effectiveRate('x0.79', promotion).current).toBe('x0.395')
  })

  it('只有 factor 时折算价不带浮点尾尘', () => {
    // 0.1 × 1.62 的二进制乘法是 0.16200000000000003：标签要读成服务端自己的
    // x0.162 风格，而不是把浮点实现细节亮出来。
    const promotion = { id: 'p', discount: { factor: 0.1 } }
    expect(effectiveRate('x1.62', promotion).current).toBe('x0.162')
  })

  it('基础价解析不出就没有倍率', () => {
    // effectiveRate 在 exactOptionalPropertyTypes 下**省略**缺键，而不是赋
    // undefined：toEqual 会忽略值为 undefined 的键、把两种形状判成相等，所以
    // 这里用 toStrictEqual 把「键不存在」锁死。
    expect(effectiveRate('free', undefined)).toStrictEqual({ strikethrough: false, free: false })
  })
})

describe('promotionFor / tierFor（按 modelIds 挂到模型上）', () => {
  const promotions = [
    { id: 'low', priority: 50, modelIds: ['m1'] },
    { id: 'high', priority: 100, modelIds: ['m1'] },
    { id: 'other', priority: 200, modelIds: ['m2'] },
  ]

  it('取 priority 最大的一条', () => {
    expect(promotionFor(promotions, 'm1')?.id).toBe('high')
    expect(promotionFor(promotions, 'm2')?.id).toBe('other')
    expect(promotionFor(promotions, 'm3')).toBeUndefined()
  })

  it('只考虑当前生效的促销', () => {
    const expired = [{ id: 'x', priority: 100, modelIds: ['m1'], enabled: false }]
    expect(promotionFor(expired, 'm1')).toBeUndefined()
  })

  it('tier 同样按 modelIds 匹配', () => {
    const tiers = [{ id: 't', modelIds: ['m1'], badge: { label: '订阅优先' } }]
    expect(tierFor(tiers, 'm1')?.badge?.label).toBe('订阅优先')
    expect(tierFor(tiers, 'm2')).toBeUndefined()
  })
})

describe('windowTextOf（时间窗压成一行、无词）', () => {
  it('每日窗口给出区间与时区', () => {
    expect(windowTextOf({ timezone: 'Asia/Shanghai', daily: [{ start: '23:00', end: '08:00' }] }))
      .toBe('23:00–08:00 (Asia/Shanghai)')
  })

  it('有效期给出日期区间', () => {
    expect(windowTextOf({ validFrom: '2026-07-06T00:00:00+08:00', validUntil: '2026-11-01T00:00:00+08:00' }))
      .toBe('2026-07-06 – 2026-11-01')
  })

  it('两者都有时用 · 连接', () => {
    const text = windowTextOf({ timezone: 'Asia/Shanghai', daily: [{ start: '00:00', end: '23:59' }], validUntil: '2026-11-01T00:00:00+08:00' })
    expect(text).toContain('·')
  })

  it('没有 schedule 就没有窗口文本', () => {
    expect(windowTextOf(undefined)).toBeUndefined()
  })
})
