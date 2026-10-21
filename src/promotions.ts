import { normalizeCredits } from './rate.js'
import type { CodeBuddyPromotion, CodeBuddyTier, PromotionWindow } from './types.js'
import type { RateView } from './remote-types.js'

/**
 * 促销当前是否生效（判定层，唯一的「现在有没有促销」入口）。
 *
 * 服务端把「全天」写成 00:00–23:59：若按右开区间解释，每天最后一分钟徽标会
 * 消失，所以窗口按墙钟分钟闭区间判定（23:59:30 仍算 23:59 这一分钟）。
 */
export function isPromotionActive(promotion: CodeBuddyPromotion, now: number = Date.now()): boolean {
  if (promotion.enabled === false) return false
  const schedule = promotion.schedule
  if (schedule === undefined) return true
  if (schedule.validFrom !== undefined) {
    const from = Date.parse(schedule.validFrom)
    if (!Number.isNaN(from) && now < from) return false
  }
  if (schedule.validUntil !== undefined) {
    const until = Date.parse(schedule.validUntil)
    if (!Number.isNaN(until) && now >= until) return false
  }
  // daily 缺省：只受有效期约束；空数组：没有任何窗口能覆盖，直接判否。
  if (schedule.daily === undefined) return true
  if (schedule.daily.length === 0) return false
  const minute = minuteOfDay(now, schedule.timezone)
  return schedule.daily.some((window) => coversMinute(window.start, window.end, minute))
}

/**
 * 算出该模型此刻的展示价。
 *
 * 折扣价优先取 discountedCredits 的归一值；只有 factor 时才按「factor × 目录价」
 * 现算——服务端多数情况下直接给了折后价，少做一次浮点乘法就少一处口径漂移。
 * `strikethrough` 为假（含 replace 与无 displayMode）时现价直接替代原价展示。
 */
export function effectiveRate(credits: string | undefined, promotion: CodeBuddyPromotion | undefined): RateView {
  const base = normalizeCredits(credits)
  let current = base
  const discount = promotion?.discount
  if (discount !== undefined) {
    const explicit = normalizeCredits(discount.discountedCredits)
    if (explicit !== undefined) {
      current = explicit
    } else if (discount.factor !== undefined && base !== undefined) {
      const baseValue = numericOf(base)
      // 二进制浮点乘法会带出 0.16200000000000003 这类尾尘：toPrecision(12) 掐掉
      // 15 位之后的 binary dust，合法小数位不受影响（0.395 不会变成 0.40）。
      // 服务端今天总下发 discountedCredits，这条路生产走不到，保持整洁即可。
      if (baseValue !== undefined) current = `x${Number((discount.factor * baseValue).toPrecision(12))}`
    }
  }
  // strikethrough 只在价格真变了时才置位：促销带 displayMode 却没给折扣值时
  // current === base，置位会让面板把原价划掉、旁边再摆一个相同的现价。
  const strikethrough = discount?.displayMode === 'strikethrough' && current !== base
  return {
    // exactOptionalPropertyTypes 下显式赋 undefined 非法，缺省即省略。
    ...(base === undefined ? {} : { base }),
    ...(current === undefined ? {} : { current }),
    strikethrough,
    free: readsAsZero(current),
  }
}

/**
 * 按 modelIds 挑出该模型此刻生效的一条促销。
 *
 * 昼夜互补的两条记录靠 priority 分高下（night 100 压 day 50），同 priority 取
 * 数组靠前者——服务端用顺序表达同级偏好，判定层保持稳定选择，不随机。
 */
export function promotionFor(
  promotions: readonly CodeBuddyPromotion[],
  modelId: string,
  now: number = Date.now(),
): CodeBuddyPromotion | undefined {
  let best: CodeBuddyPromotion | undefined
  let bestPriority = -Infinity
  for (const promotion of promotions) {
    if (promotion.modelIds?.includes(modelId) !== true) continue
    if (!isPromotionActive(promotion, now)) continue
    const priority = promotion.priority ?? 0
    if (priority > bestPriority) {
      best = promotion
      bestPriority = priority
    }
  }
  return best
}

/**
 * 按 modelIds 挑出该模型的分层：分层不带时间表，只做匹配、不做生效判断。
 */
export function tierFor(tiers: readonly CodeBuddyTier[], modelId: string): CodeBuddyTier | undefined {
  return tiers.find((tier) => tier.modelIds?.includes(modelId) === true)
}

/**
 * 时间窗压成无词的一行：客户端只配一个本地化标签（「时间窗」），
 * 不做任何日期运算，所以这里不能出现需要翻译的词。
 */
export function windowTextOf(schedule: PromotionWindow | undefined): string | undefined {
  if (schedule === undefined) return undefined
  const parts: string[] = []
  if (schedule.daily !== undefined && schedule.daily.length > 0) {
    const ranges = schedule.daily.map((window) => `${window.start}–${window.end}`).join(', ')
    parts.push(schedule.timezone === undefined ? ranges : `${ranges} (${schedule.timezone})`)
  }
  const from = datePartOf(schedule.validFrom)
  const until = datePartOf(schedule.validUntil)
  if (from !== undefined || until !== undefined) {
    parts.push(from !== undefined && until !== undefined ? `${from} – ${until}` : (from ?? until) as string)
  }
  if (parts.length === 0) return undefined
  return parts.join(' · ')
}

/**
 * 该 instant 落在 schedule.timezone 的哪一分钟（0–1439），秒直接舍去。
 *
 * 用 Intl 按时区取墙钟而不是宿主机本地时间——宿主机可能是 UTC 的 CI，
 * 而窗口是按北京时间写的。子夜在某些 locale/ICU 下会格式化成 24 点，
 * 它就是第 0 分钟，不能当成非法时间把整扇窗口判否。
 */
function minuteOfDay(now: number, timezone: string | undefined): number {
  if (timezone === undefined) {
    const local = new Date(now)
    return local.getHours() * 60 + local.getMinutes()
  }
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now)
    let hour = 0
    let minute = 0
    for (const part of parts) {
      if (part.type === 'hour') hour = Number(part.value)
      else if (part.type === 'minute') minute = Number(part.value)
    }
    if (hour === 24) hour = 0
    if (Number.isInteger(hour) && Number.isInteger(minute) && hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
      return hour * 60 + minute
    }
  } catch {
    // 非法时区：回落到宿主机本地时间，总比整条促销消失好。
  }
  const local = new Date(now)
  return local.getHours() * 60 + local.getMinutes()
}

/**
 * 单个每日窗口是否覆盖该分钟。
 *
 * start > end 表示跨零点，拆成 [start, 1440) 与 [0, end] 两段；
 * start === end 只覆盖那一分钟；边界解析失败则丢弃该窗口，
 * 不影响同 schedule 下其它窗口的判定。
 */
function coversMinute(start: string, end: string, minute: number): boolean {
  const from = parseEdge(start)
  const to = parseEdge(end)
  if (from === undefined || to === undefined) return false
  if (from === to) return minute === from
  if (from < to) return minute >= from && minute <= to
  return minute >= from || minute <= to
}

/** 解析 `HH:MM` 为当天分钟数，格式或范围非法时返回 undefined。 */
function parseEdge(edge: string): number | undefined {
  const match = /^(\d{1,2}):(\d{2})$/.exec(edge)
  if (match === null) return undefined
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return undefined
  return hour * 60 + minute
}

/** 从归一后的 `xN` 读出数值，读不出返回 undefined。 */
function numericOf(normalized: string): number | undefined {
  const match = /(\d+(?:\.\d+)?)/.exec(normalized)
  if (match === null) return undefined
  const value = Number(match[1])
  return Number.isNaN(value) ? undefined : value
}

/** 归一价读作 0（`x0` / `x0.00`）即免费；undefined 不算零。 */
function readsAsZero(normalized: string | undefined): boolean {
  if (normalized === undefined) return false
  const value = numericOf(normalized)
  return value !== undefined && value === 0
}

/** 取 ISO 时间戳的日期前缀；取不出（或缺省）时返回 undefined。 */
function datePartOf(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(raw)
  return match === null ? undefined : match[1]
}
