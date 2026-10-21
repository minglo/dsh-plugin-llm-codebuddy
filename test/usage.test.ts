import { describe, expect, it } from 'vitest'
import { parseUsage } from '../src/usage.js'

// 固定基准日期：用真实 Date 会让「本月/明日/后日」边界漂移，测试里用 vi.setSystemTime 固定。
import { vi } from 'vitest'

/** 造一个包；缺省 size = remain（等价于「无 size 字段」的兜底语义：已用 0）。 */
function pkg(name: string, cycleEndTime: string, remain: number, size?: number): Record<string, unknown> {
  return { PackageName: name, CycleEndTime: cycleEndTime, CycleCapacityRemainPrecise: remain, ...size === undefined ? {} : { CycleCapacitySizePrecise: size } }
}

function raw(...accounts: Record<string, unknown>[]): unknown {
  return { data: { Response: { Data: { Accounts: accounts } } } }
}

describe('parseUsage', () => {
  it('sums total balance across all packages', () => {
    vi.setSystemTime(new Date('2026-08-15T04:00:00Z')) // 上海 8/15 12:00（Z 锚定，宿主无关）
    const view = parseUsage(raw(
      pkg('体验版', '2026-08-31 23:59:59', 32),
      pkg('奖励', '2026-08-16 23:59:59', 100),
    ))
    expect(view?.totalBalance).toBe(132)
  })

  it('classifies four expiry buckets as cumulative windows', () => {
    vi.setSystemTime(new Date('2026-08-15T04:00:00Z')) // 上海 8/15 12:00（Z 锚定，宿主无关）
    const view = parseUsage(raw(
      pkg('a', '2026-08-31 23:59:59', 32),  // 8/15+16 → 出 7 天窗口，但在本月 → monthPool
      pkg('b', '2026-08-16 23:59:59', 100), // +1 → 明日（也属后日、7天、monthPool）
      pkg('c', '2026-08-17 23:59:59', 100), // +2 → 后日（也属 7天、monthPool）
      pkg('d', '2026-08-22 23:59:59', 200), // +7 → 7天（也在本月）
    ))
    // 累计窗口：7天 ⊇ 后日 ⊇ 明日，数字单调不减。
    expect(view?.monthPoolExpiring).toBe(432) // 本月全部到期：32+100+100+200
    expect(view?.tomorrowExpiring).toBe(100)
    expect(view?.dayAfterExpiring).toBe(200) // 100(明) + 100(后)
    expect(view?.weekExpiring).toBe(400)     // 100 + 100 + 200
  })

  it('counts today-expiring packages in tomorrow/dayAfter/week windows and monthPool', () => {
    // 今日到期的包也要进明/后/7天窗口（分母不排除更近的档位）。
    vi.setSystemTime(new Date('2026-08-15T04:00:00Z')) // 上海 8/15 12:00
    const view = parseUsage(raw(pkg('today', '2026-08-15 23:59:59', 50)))
    expect(view?.tomorrowExpiring).toBe(50)
    expect(view?.dayAfterExpiring).toBe(50)
    expect(view?.weekExpiring).toBe(50)
    expect(view?.monthPoolExpiring).toBe(50) // 今日也在本月
  })

  it('excludes packages beyond each window', () => {
    vi.setSystemTime(new Date('2026-08-15T04:00:00Z')) // 上海 8/15
    const view = parseUsage(raw(
      pkg('d8', '2026-08-23 23:59:59', 80),   // +8 → 出 7 天窗口（但 8/23 仍在 8 月 → monthPool）
      pkg('d3', '2026-08-18 23:59:59', 30),   // +3 → 在 7 天内（也在本月）
      pkg('sep', '2026-09-30 23:59:59', 40),  // 下月 → 不入本月池与窗口
    ))
    expect(view?.weekExpiring).toBe(30)
    expect(view?.dayAfterExpiring).toBe(0)
    expect(view?.tomorrowExpiring).toBe(0)
    expect(view?.monthPoolExpiring).toBe(110) // 8/23 + 8/18 都属于 8 月
  })

  it('keeps zero-remain packages in the denominator but not in totalBalance', () => {
    // 用完（remain=0）的包：剩余口径为 0，但仍是分母的一部分（已用 100 全落在它身上）。
    vi.setSystemTime(new Date('2026-08-15T04:00:00Z'))
    const view = parseUsage(raw(
      pkg('a', '2026-08-31 23:59:59', 0, 100),
      pkg('b', '2026-08-16 23:59:59', 100, 100),
    ))
    expect(view?.totalBalance).toBe(100)
    expect(view?.totalSize).toBe(200)
    expect(view?.totalUsed).toBe(100)
    expect(view?.totalUsedRatio).toBe(0.5)
  })

  it('sorts details by CycleEndTime ascending', () => {
    vi.setSystemTime(new Date('2026-08-15T04:00:00Z')) // 上海 8/15 12:00（Z 锚定，宿主无关）
    const view = parseUsage(raw(
      pkg('late', '2026-08-31 23:59:59', 10),
      pkg('early', '2026-08-16 23:59:59', 20),
    ))
    expect(view?.details.map(d => d.name)).toEqual(['early', 'late'])
  })

  it('classifies expiry by the Asia/Shanghai calendar, independent of host TZ', () => {
    // 2026-08-15T18:30:00Z = 上海 2026-08-16 02:30（UTC 仍是 8/15）：
    // 若按宿主时区（如 UTC）parse，分档会漂移；固定 +08 口径下所有宿主一致。
    vi.setSystemTime(new Date('2026-08-15T18:30:00Z'))
    const view = parseUsage(raw(
      pkg('today', '2026-08-16 23:59:59', 30),   // 上海 8/16 当天 → days=0 → 进明/后/7天窗口（也在本月）
      pkg('tomorrow', '2026-08-17 23:59:59', 70), // 上海 8/17 → days=1
      pkg('later', '2026-08-31 23:59:59', 10),    // 月末，出 7 天窗口但在本月
    ))
    expect(view?.monthPoolExpiring).toBe(110) // 全部 8 月到期：30+70+10
    expect(view?.tomorrowExpiring).toBe(100) // 30(今日) + 70(明日)
    expect(view?.dayAfterExpiring).toBe(100)
    expect(view?.weekExpiring).toBe(100)
  })

  it('keeps an end-of-month package in the current Shanghai month', () => {
    vi.setSystemTime(new Date('2026-08-15T18:30:00Z')) // 上海 8/16
    const view = parseUsage(raw(pkg('end-month', '2026-08-31 23:59:59', 42)))
    expect(view?.monthPoolExpiring).toBe(42)
  })
})

describe('parseUsage — 到期档使用率的双口径', () => {
  it('例1：两个 100 分同刻到期的包，一个用完 → 该档 50%', () => {
    // 今天 17:00 到期两包各 100：一包剩 0（已用 100），一包剩 100（已用 0）。
    // days=0 → 进明日/后日/7天窗口，也在本月（monthPool 不再剔除近档）。
    vi.setSystemTime(new Date('2026-08-16T04:00:00Z')) // 上海 8/16 12:00
    const view = parseUsage(raw(
      pkg('used-up', '2026-08-16 17:00:00', 0, 100),
      pkg('untouched', '2026-08-16 17:00:00', 100, 100),
    ))
    expect(view?.tomorrow.expiring).toBe(100)
    expect(view?.tomorrow.used).toBe(100)
    expect(view?.tomorrow.size).toBe(200)
    expect(view?.tomorrow.usedRatio).toBe(0.5)
    // monthPool 是本月的真实池：两包都在本月，已用 100/200 = 50%。
    expect(view?.monthPool.expiring).toBe(100)
    expect(view?.monthPool.size).toBe(200)
    expect(view?.monthPool.usedRatio).toBe(0.5)
  })

  it('例2：7天内 10 包共 1000，已用 550 → 55%', () => {
    vi.setSystemTime(new Date('2026-08-15T04:00:00Z')) // 上海 8/15
    const accounts: Record<string, unknown>[] = []
    for (let i = 0; i < 5; i++) accounts.push(pkg(`drained-${i}`, '2026-08-22 23:59:59', 0, 100))   // 5 包用完：已用 500
    for (let i = 0; i < 5; i++) accounts.push(pkg(`half-${i}`, '2026-08-22 23:59:59', 90, 100))      // 5 包各用 10：已用 50
    const view = parseUsage(raw(...accounts))
    expect(view?.week.size).toBe(1000)
    expect(view?.week.used).toBe(550)
    expect(view?.week.expiring).toBe(450)
    expect(view?.week.usedRatio).toBeCloseTo(0.55, 10)
  })

  it('用完的档显示 100% 而非 0%（旧口径会算成 0）', () => {
    vi.setSystemTime(new Date('2026-08-15T04:00:00Z'))
    const view = parseUsage(raw(pkg('drained', '2026-08-22 23:59:59', 0, 100)))
    expect(view?.week.usedRatio).toBe(1)
    expect(view?.weekExpiring).toBe(0) // 紧迫度口径仍为 0 —— 双口径并存
  })

  it('缺 size 字段时回落为 remain，已用记 0 且分母不塌', () => {
    vi.setSystemTime(new Date('2026-08-15T04:00:00Z'))
    const view = parseUsage(raw(pkg('no-size', '2026-08-22 23:59:59', 80)))
    expect(view?.week.size).toBe(80)
    expect(view?.week.used).toBe(0)
    expect(view?.week.usedRatio).toBe(0)
    expect(Number.isNaN(view?.week.usedRatio)).toBe(false)
  })

  it('size < remain（超额发放/退款）时已用 clamp 到 0，不出现负使用率', () => {
    vi.setSystemTime(new Date('2026-08-15T04:00:00Z'))
    const view = parseUsage(raw(pkg('bonus', '2026-08-22 23:59:59', 150, 100)))
    expect(view?.week.used).toBe(0)
    expect(view?.week.usedRatio).toBe(0)
    expect(view?.week.size).toBe(150) // 以 remain 为下限
  })

  it('无任何包时 usedRatio 为 0 而不是 NaN', () => {
    vi.setSystemTime(new Date('2026-08-15T04:00:00Z'))
    const view = parseUsage(raw())
    expect(view?.totalSize).toBe(0)
    expect(view?.totalUsedRatio).toBe(0)
    expect(view?.week.usedRatio).toBe(0)
    expect(view?.monthPool.size).toBe(0)
    expect(view?.monthPool.usedRatio).toBe(0)
  })

  it('已过期的包不计入分母（未过期奖励积分合计）', () => {
    vi.setSystemTime(new Date('2026-08-15T04:00:00Z')) // 上海 8/15 12:00
    const view = parseUsage(raw(
      pkg('stale', '2026-08-15 10:00:00', 0, 500),  // 上海 8/15 10:00 已过期
      pkg('live', '2026-08-22 23:59:59', 60, 100),
    ))
    expect(view?.totalSize).toBe(100) // 过期包的 500 不进分母
    expect(view?.totalUsed).toBe(40)
    expect(view?.totalUsedRatio).toBeCloseTo(0.4, 10)
    expect(view?.details.map(d => d.name)).toEqual(['live'])
  })

  it('到期时间格式不符的包计入总额度但不入任何档', () => {
    vi.setSystemTime(new Date('2026-08-15T04:00:00Z'))
    const view = parseUsage(raw(
      pkg('malformed', 'not-a-date', 70, 100),
      pkg('live', '2026-08-22 23:59:59', 60, 100),
    ))
    expect(view?.totalBalance).toBe(130)
    expect(view?.totalSize).toBe(200)
    expect(view?.week.size).toBe(100) // 仅 live 入 7 天档
    // details 按 cycleEndTime 升序：'2026-…' < 'not-a-date'，故 malformed 排在后面。
    expect(view?.details.map(d => d.name)).toEqual(['live', 'malformed'])
  })

  it('整体使用率与分档使用率各自独立（不跨档共用分母）', () => {
    vi.setSystemTime(new Date('2026-08-15T04:00:00Z')) // 上海 8/15
    const view = parseUsage(raw(
      pkg('next-week', '2026-08-22 23:59:59', 0, 100),      // 7天档：100%（本月）
      pkg('next-month', '2026-09-30 23:59:59', 100, 100),   // 非本月，不进 monthPool，但进整体分母
    ))
    expect(view?.week.usedRatio).toBe(1)        // 分档：1/1
    expect(view?.totalUsedRatio).toBe(0.5)      // 整体：100/200
    expect(view?.monthPool.size).toBe(100)      // 仅 8/22 属本月
    expect(view?.monthPool.usedRatio).toBe(1)
  })
})

describe('parseUsage — monthPool（本月到期池）', () => {
  it('聚合上海自然月内到期的全部未过期账户（含 7 天内到期、含已用光）', () => {
    vi.setSystemTime(new Date('2026-09-09T04:00:00Z')) // 上海 9/9 12:00
    const view = parseUsage(raw(
      pkg('month-end', '2026-09-30 23:59:59', 500),   // 月末体验版
      pkg('soon', '2026-09-12 23:59:59', 0, 100),     // +3 → 7 天内 & 已用光（用光包计入分母）
      pkg('expired-today', '2026-09-09 10:00:00', 0, 100), // 上海 9/9 10:00 已过期 → 不入池
      pkg('oct', '2026-10-09 13:06:25', 100, 100),    // 10 月 → 不入本月池
    ))
    expect(view?.monthPool.size).toBe(600)          // 500 + 100
    expect(view?.monthPool.used).toBe(100)          // 只有 soon 用光
    expect(view?.monthPool.usedRatio).toBeCloseTo(100 / 600, 10)
    expect(view?.monthPoolRemain).toBe(500)
    expect(view?.monthPool.expiring).toBe(500)      // 同 remain
  })

  it('本月池内 7 天内到期与月末包并行不互斥', () => {
    vi.setSystemTime(new Date('2026-09-09T04:00:00Z')) // 上海 9/9
    const view = parseUsage(raw(
      pkg('daily', '2026-09-16 23:59:59', 100, 100), // +7 → monthPool + week
      pkg('month-end', '2026-09-30 23:59:59', 50, 50),
    ))
    expect(view?.monthPoolRemain).toBe(150) // 100 + 50 全部算本月
    expect(view?.weekExpiring).toBe(100)
  })
})
