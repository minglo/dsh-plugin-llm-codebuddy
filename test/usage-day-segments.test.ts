import { describe, expect, it } from 'vitest'
import type { UsageView } from '../src/remote-types.js'
import { SEGMENT_GAP_RAD, daySegments } from '../src/client/usage-metrics.js'
import { EXPIRY_COLORS } from '../src/client/palette.js'

/** 基准：上海 2026-09-28 12:00（= 04:00Z），故「今天」是 09-28。 */
const NOW = new Date('2026-09-28T04:00:00Z')

/** 造一个包；缺省 size = remain（等价于「无 size 字段」的兜底语义：已用 0）。 */
function pkg(name: string, cycleEndTime: string, remain: number, size?: number) {
  return { name, cycleEndTime, remain, size: size ?? remain, used: (size ?? remain) - remain }
}

function view(details: ReturnType<typeof pkg>[]): UsageView {
  return {
    totalBalance: 0, totalSize: 0, totalUsed: 0, totalUsedRatio: 0,
    monthPool: { expiring: 0, used: 0, size: 0, usedRatio: 0 },
    monthPoolRemain: 0, monthPoolExpiring: 0,
    tomorrowExpiring: 0, dayAfterExpiring: 0, weekExpiring: 0,
    tomorrow: { expiring: 0, used: 0, size: 0, usedRatio: 0 },
    dayAfter: { expiring: 0, used: 0, size: 0, usedRatio: 0 },
    week: { expiring: 0, used: 0, size: 0, usedRatio: 0 },
    details,
  }
}

describe('daySegments', () => {
  it('always returns 7 segments, one per calendar day, in order', () => {
    const segments = daySegments(view([]), NOW)
    expect(segments).toHaveLength(7)
    expect(segments.map(s => s.day)).toEqual([0, 1, 2, 3, 4, 5, 6])
    // 天标签沿用侧栏「错位一天」口径：第 0 天 = 今天 = 「1天内到期」。
    expect(segments.map(s => s.key)).toEqual([
      'expiringDay0', 'expiringDay1', 'expiringDay2', 'expiringDay3',
      'expiringDay4', 'expiringDay5', 'expiringDay6',
    ])
  })

  it('buckets packages by whole calendar day, not by 24-hour distance', () => {
    const segments = daySegments(view([
      pkg('today-late', '2026-09-28 23:59:59', 5),
      pkg('tomorrow-early', '2026-09-29 00:00:01', 7),
      pkg('day6', '2026-10-04 12:00:00', 11),
    ]), NOW)
    expect(segments[0]?.remain).toBe(5)
    expect(segments[1]?.remain).toBe(7)
    expect(segments[6]?.remain).toBe(11)
  })

  it('sums remain/size/used per day and derives usedRatio', () => {
    const segments = daySegments(view([
      pkg('a', '2026-09-29 10:00:00', 10, 40),
      pkg('b', '2026-09-29 18:00:00', 30, 60),
    ]), NOW)
    const day1 = segments[1]
    expect(day1?.present).toBe(true)
    expect(day1?.remain).toBe(40)
    expect(day1?.size).toBe(100)
    expect(day1?.used).toBe(60)
    expect(day1?.usedRatio).toBeCloseTo(0.6, 10)
  })

  it('ignores expired packages and anything past day 6', () => {
    const segments = daySegments(view([
      pkg('yesterday', '2026-09-27 12:00:00', 99),
      pkg('day7', '2026-10-05 12:00:00', 88),
      pkg('far', '2027-02-25 11:01:50', 50),
      pkg('malformed', 'not-a-date', 77),
      pkg('inside', '2026-09-30 12:00:00', 5),
    ]), NOW)
    // 只有 day2 有额度；越界的都不占段。
    expect(segments.filter(s => s.present).map(s => s.day)).toEqual([2])
    expect(segments[2]?.remain).toBe(5)
    expect(segments.reduce((sum, s) => sum + s.remain, 0)).toBe(5)
  })

  it('treats a day with no allowance as the special case, keyed on size not remain', () => {
    // 段宽按 size 分配，所以「这天有没有额度」也必须看 size：
    // 一个当天刚好用完额度的日子（remain=0，size>0）不是空段——它占着最宽的位置。
    const segments = daySegments(view([
      pkg('spent-today', '2026-09-28 12:00:00', 0, 500),
      pkg('not-granted', '2026-09-29 12:00:00', 0, 0),
    ]), NOW)
    expect(segments[0]?.present).toBe(true)
    expect(segments[0]?.usedRatio).toBe(1)
    expect(segments[1]?.present).toBe(false)
    // 用完的那天明显比没发额度的那天宽。
    expect(segments[0]!.span).toBeGreaterThan(segments[1]!.span)
  })

  it('gives every day a minimum width even when nothing is granted', () => {
    const segments = daySegments(view([pkg('a', '2026-09-30 12:00:00', 100)]), NOW)
    let cursor = 0
    for (const segment of segments) {
      expect(segment.span, `day ${segment.day} 应有最小宽度`).toBeGreaterThan(0)
      expect(segment.span).toBeGreaterThanOrEqual(0)
      cursor = segment.start + segment.span
    }
    // 7 段 + 间隙正好铺满一圈（不重叠、不留大片空白）。
    const last = segments[6]!
    expect(last.start + last.span).toBeLessThanOrEqual(2 * Math.PI + 1e-9)
    expect(cursor).toBeGreaterThan(2 * Math.PI * 0.9)
  })

  it('sizes real days by their own share of the granted allowance', () => {
    // 三天额度 100/200/100：第 2 天的段应明显宽于第 0、3 天，且 0 与 3 天接近。
    const segments = daySegments(view([
      pkg('d0', '2026-09-28 12:00:00', 100),
      pkg('d1', '2026-09-29 12:00:00', 200),
      pkg('d2', '2026-09-30 12:00:00', 100),
    ]), NOW)
    expect(segments[1]!.span).toBeGreaterThan(segments[0]!.span)
    expect(segments[1]!.span).toBeGreaterThan(segments[2]!.span)
    expect(segments[0]!.span).toBeCloseTo(segments[2]!.span, 10)
  })

  it('lays the segments out end to end with a gap, inside one turn', () => {
    const segments = daySegments(view([pkg('a', '2026-09-30 12:00:00', 100)]), NOW)
    for (const [index, segment] of segments.entries()) {
      expect(segment.start, `day ${segment.day} 起点`).toBeCloseTo(
        index === 0 ? 0 : (segments[index - 1]!.start + segments[index - 1]!.span + SEGMENT_GAP_RAD), 10,
      )
    }
    const last = segments[6]!
    // 7 段 + 7 个间隙不超过整圈（起点从 0 起算，最后一个间隙落在圈外不画）。
    expect(last.start + last.span).toBeLessThanOrEqual(2 * Math.PI + 1e-9)
  })

  it('uses the day colour scale and never repeats a neighbouring colour', () => {
    const segments = daySegments(view([]), NOW)
    expect(segments.map(s => s.color)).toEqual([...EXPIRY_COLORS])
    // 相邻两档必须不同色，否则「连续色阶」读成一整块。
    for (let i = 1; i < segments.length; i++) {
      expect(segments[i]!.color).not.toBe(segments[i - 1]!.color)
    }
  })

  it('tolerates a stale view without a details array', () => {
    // 旧 host 的 view 可能没有 details：退化为 7 个空段，而不是抛错让整块消失。
    const stale = { totalBalance: 10, totalSize: 0, totalUsed: 0, totalUsedRatio: 0 } as unknown as UsageView
    const segments = daySegments(stale, NOW)
    expect(segments).toHaveLength(7)
    expect(segments.every(s => !s.present && s.remain === 0)).toBe(true)
  })

  it('does not produce NaN when every day is empty', () => {
    for (const segment of daySegments(view([]), NOW)) {
      expect(Number.isFinite(segment.span)).toBe(true)
      expect(Number.isFinite(segment.start)).toBe(true)
      expect(Number.isFinite(segment.usedRatio)).toBe(true)
    }
  })
})
