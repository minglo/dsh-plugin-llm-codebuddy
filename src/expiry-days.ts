/**
 * 到期日期的 +08 日历换算——host 与 client **共用同一份实现**。
 *
 * 为什么必须共用：额度包自带 `CycleEndTime`（上海墙上时间、无时区标记），
 * 「这个包属于哪一天到期」是算出来的，不是字段里读出来的。host 用它分累计窗口
 * （明日/后日/7天），client 用同一套规则分未来 7 个自然日段。两边各写一份，
 * 就会在某次改动后悄悄错开一天，而界面上没人看得出来——数字都还在。
 *
 * 固定 +8、无夏令时：换算与宿主机时区、与浏览器时区都无关，所以同一份读数
 * 在任何机器上落到同一天。
 *
 * @module dsh-plugin-llm-codebuddy/expiry-days
 */

/** 未来窗口的天数：第 0 天（今天）…第 6 天，共 7 段。 */
export const DAY_WINDOW_DAYS = 7

/**
 * 服务返回的 `CycleEndTime` → UTC 时刻。
 *
 * 字段是 **naive 上海墙上时间**（`2026-09-30 23:59:59`，无时区后缀）。
 * 墙上时间 −8h 即得该时刻的 UTC 瞬间；与宿主时区无关。
 * @param cycleEndTime - 服务给的原始字符串。
 * @returns 解析出的时刻；格式不符时 undefined（调用方据此不入任何档）。
 */
export function endTimeOf(cycleEndTime: string): Date | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(cycleEndTime)
  if (m === null) return undefined
  const [, y, mo, d, h, mi, s] = m
  // Asia/Shanghai 固定 UTC+8、无夏令时：墙上时间 −8h 即得该时刻的 UTC 瞬间，与宿主时区无关。
  return new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h) - 8, Number(mi), Number(s)))
}

/** d 在 Asia/Shanghai 日历中的 'YYYY-MM-DD' 键：UTC 时刻 +8h 后取日期段。 */
export function shanghaiDayKey(d: Date): string {
  const wall = new Date(d.getTime() + 8 * 3_600_000)
  return wall.toISOString().slice(0, 10)
}

/**
 * 到期日距今天的日历日差；`end` 缺失（时间格式不符）时返回 undefined，不入任何档。
 *
 * 按**日历日**而不是 24 小时差：「明天 00:00 到期」与「明天 23:59 到期」对使用者
 * 都是「明天」，中间的 24 小时窗口会让同一个包在一天之内换档。
 * @param end - 到期时刻。
 * @param now - 判定「今天」的基准时刻。
 * @returns 0 = 今天，1 = 明天，…；`end` 为 undefined 时 undefined。
 */
export function daysFromToday(end: Date | undefined, now: Date): number | undefined {
  if (end === undefined) return undefined
  const endKey = shanghaiDayKey(end)
  const todayKey = shanghaiDayKey(now)
  // 两键均为 'YYYY-MM-DD'：日历日差按 UTC 零点差折算，与宿主时区无关。
  const diffMs = Date.parse(`${endKey}T00:00:00Z`) - Date.parse(`${todayKey}T00:00:00Z`)
  return Math.round(diffMs / 86_400_000)
}
