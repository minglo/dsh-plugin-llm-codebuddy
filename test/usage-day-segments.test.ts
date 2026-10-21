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
  it('returns only granted days, in day order, with their calendar dates', () => {
    // 空天直接跳过：09-29 / 10-01 / 10-02 / 10-03 没有额度，不成段。
    const segments = daySegments(view([
      pkg('d0', '2026-09-28 12:00:00', 5),
      pkg('d2', '2026-09-30 12:00:00', 7),
      pkg('d6', '2026-10-04 12:00:00', 11),
    ]), NOW)
    expect(segments.map(s => s.day)).toEqual([0, 2, 6])
    // 日期是上海日历的实际到期日（含跨月）：图例「10月4日到期」的数据来源。
    expect(segments.map(s => [s.month, s.dayOfMonth])).toEqual([[9, 28], [9, 30], [10, 4]])
  })

  it('buckets packages by whole calendar day, not by 24-hour distance', () => {
    const segments = daySegments(view([
      pkg('today-late', '2026-09-28 23:59:59', 5),
      pkg('tomorrow-early', '2026-09-29 00:00:01', 7),
      pkg('day6', '2026-10-04 12:00:00', 11),
    ]), NOW)
    const byDay = (day: number): number | undefined =>
      segments.find(s => s.day === day)?.remain
    expect(byDay(0)).toBe(5)
    expect(byDay(1)).toBe(7)
    expect(byDay(6)).toBe(11)
  })

  it('sums remain/size/used per day and derives usedRatio', () => {
    const segments = daySegments(view([
      pkg('a', '2026-09-29 10:00:00', 10, 40),
      pkg('b', '2026-09-29 18:00:00', 30, 60),
    ]), NOW)
    const day1 = segments.find(s => s.day === 1)
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
    expect(segments.map(s => s.day)).toEqual([2])
    expect(segments[0]?.remain).toBe(5)
    expect(segments.reduce((sum, s) => sum + s.remain, 0)).toBe(5)
  })

  it('drops days with no allowance instead of drawing placeholders', () => {
    // 段宽按 size 分配，「有没有额度」也只看 size：当天用完（remain=0，size>0）
    // 照样成段且 usedRatio 为 1；没发额度的天直接不出段。
    const segments = daySegments(view([
      pkg('spent-today', '2026-09-28 12:00:00', 0, 500),
      pkg('not-granted', '2026-09-29 12:00:00', 0, 0),
    ]), NOW)
    expect(segments.map(s => s.day)).toEqual([0])
    expect(segments[0]?.usedRatio).toBe(1)
  })

  it('returns no segments when nothing was granted, without NaNs or throws', () => {
    // 空天跳过到底：7 天全空 = 不成段，而不是 7 个空段。旧 host 无 details 同理
    // （缺字段的旧 view 在这里按空处理，不抛错让整块消失）。
    const stale = { totalBalance: 10, totalSize: 0, totalUsed: 0, totalUsedRatio: 0 } as unknown as UsageView
    for (const v of [view([]), stale]) {
      expect(daySegments(v, NOW)).toEqual([])
    }
  })

  it('still gives a tiny allowance its own visible segment', () => {
    // 最小宽度下限的回归点：极小额度不能被大段挤到 0 宽而"消失"。
    const segments = daySegments(view([
      pkg('huge', '2026-09-28 12:00:00', 10000),
      pkg('tiny', '2026-09-30 12:00:00', 1),
    ]), NOW)
    expect(segments.map(s => s.day)).toEqual([0, 2])
    const tiny = segments.find(s => s.day === 2)!
    expect(tiny.span).toBeGreaterThan(0)
  })

  it('sizes granted days by their own share of the allowance', () => {
    // 三天额度 100/200/100：第 2 天的段应明显宽于第 0、3 天，且 0 与 3 天接近。
    const segments = daySegments(view([
      pkg('d0', '2026-09-28 12:00:00', 100),
      pkg('d1', '2026-09-29 12:00:00', 200),
      pkg('d2', '2026-09-30 12:00:00', 100),
    ]), NOW)
    const spanOf = (day: number): number => segments.find(s => s.day === day)!.span
    expect(spanOf(1)).toBeGreaterThan(spanOf(0))
    expect(spanOf(1)).toBeGreaterThan(spanOf(2))
    expect(spanOf(0)).toBeCloseTo(spanOf(2), 10)
  })

  it('lays the segments out end to end with a gap, inside one turn', () => {
    const segments = daySegments(view([
      pkg('a', '2026-09-28 12:00:00', 100),
      pkg('b', '2026-09-30 12:00:00', 100),
    ]), NOW)
    for (const [index, segment] of segments.entries()) {
      expect(segment.start, `day ${segment.day} 起点`).toBeCloseTo(
        index === 0 ? 0 : (segments[index - 1]!.start + segments[index - 1]!.span + SEGMENT_GAP_RAD), 10,
      )
    }
    // n 段 + n 个间隙铺满整圈（最后一个间隙落在圈外不画，但计入总量）。
    const total = segments.reduce((sum, s) => sum + s.span, 0) + SEGMENT_GAP_RAD * segments.length
    expect(total).toBeCloseTo(2 * Math.PI, 10)
  })

  it('colours each day by its own day index, skipping no granted day', () => {
    const segments = daySegments(view([
      pkg('d0', '2026-09-28 12:00:00', 5),
      pkg('d2', '2026-09-30 12:00:00', 7),
      pkg('d6', '2026-10-04 12:00:00', 11),
    ]), NOW)
    // 跳过的天不影响取色：留下的段仍按各自的天数取色，肉眼可分辨。
    expect(segments.map(s => s.color)).toEqual([EXPIRY_COLORS[0], EXPIRY_COLORS[2], EXPIRY_COLORS[6]])
    for (let i = 1; i < segments.length; i++) {
      expect(segments[i]!.color).not.toBe(segments[i - 1]!.color)
    }
  })
})
