/**
 * 用量读数的**唯一**取值口径。
 *
 * 侧栏指示器、输入框胶囊弹层、插件配置卡片三处都渲染同一份额度数据；把
 * 「怎么算」放在这里，「怎么画」留给各自的组件，三处才不会各算一套：
 * 曾经出现过「已用积分」与「7天内到期」共用同一颜色、以及累计口径被当成
 * 互斥口径的坑，都是口径分裂的后果。
 *
 * 所有取值器都按「有则取、无则兜底」消化：host 与 client 是两个独立产物
 * （tsc / tsup 分别产出），只重建其一就会拿到缺字段的旧 view，裸属性读会抛，
 * 让整个面板静默消失。
 */
import type { UsageView } from '../remote-types.js'
import { finiteOr } from './shared.js'
import { SEGMENT_COLORS, EXPIRY_COLORS } from './palette.js'
import { DAY_WINDOW_DAYS, daysFromToday, endTimeOf, shanghaiDayKey } from '../expiry-days.js'

/** 一个互斥到期段：`≤1天` / `1–2天` / `2–7天`。 */
export interface ExpiringSegment {
  /** locale 键（段名）。 */
  key: string
  used: number
  size: number
  /** used / size，clamp [0,1]。 */
  usedRatio: number
  /** 段宽占整条的比例：按该档额度大小分配。 */
  share: number
  color: string
}

/**
 * 把 host 的**累计**窗口（7天 ⊇ 2天 ⊇ 1天）折成**互斥**三段。
 *
 * 累计值直接当三段用会重复计数（同一包在 ≤2天与 ≤7天里各算一次），且三段之和不等于
 * 任何有意义的整体。相邻两档相减即得互斥区间，且因同源同口径，相减不会遗漏或重复。
 */
export function exclusiveSegments(view: UsageView | undefined): ExpiringSegment[] {
  if (view === undefined) return []
  const cumulative = [
    { key: 'expiringWithin1d', bucket: view.tomorrow },
    { key: 'expiring1to2d', bucket: view.dayAfter },
    { key: 'expiring2to7d', bucket: view.week },
  ]
  const raw = cumulative.map(({ key, bucket }, index) => ({
    key,
    index,
    used: finiteOr(bucket?.used, 0),
    size: finiteOr(bucket?.size, 0),
  }))
  // 相邻相减并夹到非负：host 数据异常（后档小于前档）时按 0 处理，不产出负宽段。
  const exclusive = raw.map((segment, position) => {
    const previous = position === 0 ? undefined : raw[position - 1]
    return {
      key: segment.key,
      index: segment.index,
      used: Math.max(segment.used - (previous?.used ?? 0), 0),
      size: Math.max(segment.size - (previous?.size ?? 0), 0),
    }
  })
  const kept = exclusive.filter(segment => segment.size > 0)
  const total = kept.reduce((sum, segment) => sum + segment.size, 0)
  return kept.map(segment => ({
    key: segment.key,
    used: segment.used,
    size: segment.size,
    usedRatio: segment.size > 0 ? Math.min(Math.max(segment.used / segment.size, 0), 1) : 0,
    share: total > 0 ? segment.size / total : 0,
    color: SEGMENT_COLORS[segment.index % SEGMENT_COLORS.length] ?? SEGMENT_COLORS[0],
  }))
}

/** 侧栏读数：总剩余 + 本月到期池 + 派生占比 + 互斥到期段。 */
export interface UsageReading {
  /** 总剩余（未过期包余额合计）。 */
  totalBalance: number
  /** 本月到期池剩余（月底前不用就清零的部分）。 */
  monthRemain: number
  /** 本月已用 / 池 size（月度消耗率）。 */
  monthUsed: number
  monthSize: number
  monthUsedRatio: number
  /** 复合条：本月段占「总剩余」的宽长比例（clamp [0,1]）。 */
  monthShare: number
  /** 第二条复合条的三段（互斥区间，size>0 的才保留）。 */
  expiring: ExpiringSegment[]
}

/**
 * 未来 7 个自然日里有额度的一天：从 `details` 派生，**不经过 host 的累计窗口桶**。
 *
 * 为什么不用 `tomorrow`/`dayAfter`/`week`：那三个是累计窗口（7天 ⊇ 后日 ⊇ 明日），
 * 相减只能折出三段；而这里要的是每一天。`details` 的每个包都带原始
 * `cycleEndTime`，按自然日重新分桶即可，且与 host 同源同口径。
 *
 * 只返回**发过额度**的天（`size > 0`）：没额度的天不出段，环与图例都跳过它。
 * 段的位置因此不固定——认段靠日期文字与当天颜色，不靠位置。
 */
export interface DaySegment {
  /** 距今天的日历日差：0 = 今天，…，6 = 第 6 天。 */
  day: number
  /** 到期日在上海日历中的月、日：图例「10月4日到期」的数据来源。 */
  month: number
  dayOfMonth: number
  /** 当天到期包的剩余积分合计。 */
  remain: number
  /** 当天到期包的发放积分合计（分母；恒大于 0）。 */
  size: number
  /** 当天已用 = size − remain。 */
  used: number
  /** 当天 used / size，clamp [0,1]。 */
  usedRatio: number
  /**
   * 当天在分段环里的角宽（弧度），**已含最小宽度下限**。
   *
   * 宽度只在有额度的天之间按 size 占比分配：极小额度也保一段可见宽度，
   * 不会被大段挤到消失。
   */
  span: number
  /** 该段起始角（弧度，12 点方向为 0，顺时针为正）。 */
  start: number
  color: string
}

/**
 * 有额度的天分段后的最小角宽（弧度，约 3°）。
 *
 * 取值权衡：小到不挤压真实段的比例（7 天全在的最坏情况 3° × 7 = 21°，
 * 占满环 360° 的 6%），又大到肉眼能看见、能点中（外环半径 96 时约 5px 弧长）。
 */
const MIN_SPAN_RAD = 0.052

/**
 * 段与段之间的间隙（弧度，约 3.4°），让「分段」这件事本身可见。
 *
 * 外圈半径 96 上约 5.8px。分段两端走 `stroke-linecap: round`，圆头各向外扩半个 stroke
 * （6.5px），但 `Arc` 把绘制长度内缩了一个 stroke，圆头整个收在段内——所以这里
 * **不需要**留出「大于圆头半径」的宽度，段与段之间剩下的正好是这个间隙。
 */
export const SEGMENT_GAP_RAD = 0.06

/**
 * 把 `details` 折成未来 7 个自然日里**有额度的天**的分段。
 *
 * 角宽分配：段宽只在有额度的天之间**严格按当天额度（size）占比**，再归一化到
 * 整圈。这样「宽度按当天积分数量划分」成立；没额度的天直接不出段。
 *
 * 「有没有额度」看 size 而不是 remain：一个当天刚好用完额度的日子（remain=0，
 * size>0）照样成段，明明它占着最宽的位置；反过来 remain 必须由 size 兜底才有
 * 意义，没发过额度的天没有「未用」可言。
 *
 * @param view - host 返回的读数（旧 host 无 details 时退化为空数组，不抛错）。
 * @param now - 判定「今天」的基准，可注入以便测试。
 * @returns 有额度的天，按天数升序；7 天全空时 []。
 */
export function daySegments(view: UsageView | undefined, now: Date = new Date()): DaySegment[] {
  const buckets = Array.from({ length: DAY_WINDOW_DAYS }, (_, day) => ({
    day, remain: 0, size: 0, used: 0,
  }))
  for (const item of view?.details ?? []) {
    const days = daysFromToday(endTimeOf(item.cycleEndTime), now)
    // 已过期（差 <0）或超出 7 天窗口的包不占段：它们要么马上不计入余额，
    // 要么已被「已用 / 总剩余」两个环覆盖。
    if (days === undefined || days < 0 || days >= DAY_WINDOW_DAYS) continue
    const bucket = buckets[days]
    if (bucket === undefined) continue
    const size = finiteOr(item.size, 0)
    bucket.remain += finiteOr(item.remain, 0)
    bucket.size += size
    bucket.used += finiteOr(item.used, size - finiteOr(item.remain, 0))
  }

  const granted = buckets.filter(bucket => bucket.size > 0)
  if (granted.length === 0) return []
  const totalSize = granted.reduce((sum, bucket) => sum + bucket.size, 0)
  const spans = granted.map(bucket => Math.max(bucket.size / totalSize, MIN_SPAN_RAD))
  const available = Math.max(2 * Math.PI - SEGMENT_GAP_RAD * granted.length, MIN_SPAN_RAD)
  const scale = available / spans.reduce((sum, span) => sum + span, 0)

  // 段的日期是上海日历的「今天 + 天数偏移」：UTC 零点加天数即得目标日的上海日期，
  // 跨月、跨年都不用特判（toISOString 取的是 UTC 日期段，与偏移基准同一套）。
  const todayKey = shanghaiDayKey(now)
  let cursor = 0
  return granted.map((bucket, index) => {
    const span = (spans[index] ?? MIN_SPAN_RAD) * scale
    const start = cursor
    cursor += span + SEGMENT_GAP_RAD
    const dayMs = Date.parse(`${todayKey}T00:00:00Z`) + bucket.day * 86_400_000
    const [, month, dayOfMonth] = new Date(dayMs).toISOString().slice(0, 10).split('-').map(Number)
    return {
      day: bucket.day,
      month: month ?? 1,
      dayOfMonth: dayOfMonth ?? 1,
      remain: bucket.remain,
      size: bucket.size,
      used: bucket.used,
      usedRatio: Math.min(Math.max(bucket.used / bucket.size, 0), 1),
      span,
      start,
      color: EXPIRY_COLORS[bucket.day] ?? EXPIRY_COLORS[0],
    }
  })
}

/**
 * 归一化 host 返回的 view：host 与 client 是两个独立产物，只重建其一就会拿到缺字段的
 * 旧结构（如无 totalUsed / monthPool）。旧 host（无 monthPool）退化为「仅总剩余」，
 * 复合段与月度消耗率按 0 兜底、不抛。
 */
export function toReading(view: UsageView | undefined): UsageReading | undefined {
  if (view === undefined) return undefined
  const totalBalance = view.totalBalance !== undefined ? finiteOr(view.totalBalance, 0) : finiteOr(view.totalSize, 0)
  const pool = view.monthPool
  const monthSize = pool !== undefined ? finiteOr(pool.size, 0) : 0
  const monthUsed = pool !== undefined ? finiteOr(pool.used, 0) : 0
  const monthRemain = view.monthPoolRemain !== undefined
    ? finiteOr(view.monthPoolRemain, 0)
    : pool !== undefined ? finiteOr(pool.expiring, 0) : 0
  const monthUsedRatio = monthSize > 0 ? Math.min(Math.max(monthUsed / monthSize, 0), 1) : 0
  const monthShare = totalBalance > 0 ? Math.min(Math.max(monthRemain / totalBalance, 0), 1) : 0
  return { totalBalance, monthRemain, monthUsed, monthSize, monthUsedRatio, monthShare, expiring: exclusiveSegments(view) }
}
