/**
 * 从失败报文里读出「什么时候可以再试」。
 *
 * 为什么需要它：用量被限流时 CodeBuddy 回 429，把重置时刻**插进面向用户的成句
 * 文案**里——`您的使用量已超出频率限制，将在 2026-09-27 17:30:18 UTC+8 重置，…`。
 * 2026-09 实测：成功响应不带任何限流头，429 也没有可用的 `Retry-After`，
 * 能读到的只有这句话（见 test/reset-time.test.ts 里那条逐字照抄的真实报文）。
 *
 * 因为文案按界面语言上报，识别**不能**依赖中文措辞：这里只认时间戳本身的形状，
 * 语言无关。读出的时刻交给 `providerRetryAfterMs`，由宿主的重试执行器按策略裁决
 * ——它只在读数 ≤ 策略的 `maxDelayMs` 时才采纳，于是「等到重置时刻再重试」不是
 * 适配器自己 sleep，而是走宿主那套可持久化、可取消的调度（见 src/index.ts 的默认策略）。
 *
 * @module dsh-plugin-llm-codebuddy/reset-time
 */

/**
 * 认到多远的未来还算「重置时刻」。
 *
 * 超过它的读数不是调度指令而是别的日期（版权年、构建时间、日志行），宁可当没读到：
 * 一个错的读数会变成一次错的重试。它只是**合理性**上界，不表达产品上的等待上限——
 * 等多久由重试策略的 `maxDelayMs` 决定。
 */
export const RESET_LOOKAHEAD_MS = 30 * 24 * 60 * 60 * 1000

/** 服务自己的写法：`2026-09-27 17:30:18 UTC+8`（容忍 `UTC+08:00`、缺秒）。 */
const UTC_LABEL = /(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?\s*UTC([+-])(\d{1,2})(?::?(\d{2}))?/gi

/** ISO 8601 / RFC 3339：`2026-09-27T17:30:18+08:00`、`…Z`（容忍 `+0800`、小数秒）。 */
const ISO_OFFSET = /(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})/gi

/** 报文里出现的一个时刻：本地字段 + 相对 UTC 的偏移（分钟，东八区为 +480）。 */
interface Stamp {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
  offsetMinutes: number
}

/**
 * 本地字段 + 偏移 → UTC 毫秒；字段不可能（`2026-02-31`、`25:00`）时给 undefined。
 *
 * `Date.UTC` 会把越界日期**归一**成下一个合法日期（2 月 31 日变 3 月 3 日），
 * 所以必须做往返比对，而不是信任它算出来的毫秒数。
 */
function instantOf(stamp: Stamp): number | undefined {
  if (stamp.hour > 23 || stamp.minute > 59 || stamp.second > 59) return undefined
  if (stamp.month < 1 || stamp.month > 12 || stamp.day < 1) return undefined
  const utc = Date.UTC(stamp.year, stamp.month - 1, stamp.day, stamp.hour, stamp.minute, stamp.second)
  const back = new Date(utc)
  if (back.getUTCFullYear() !== stamp.year
    || back.getUTCMonth() !== stamp.month - 1
    || back.getUTCDate() !== stamp.day
    || back.getUTCHours() !== stamp.hour) return undefined
  return utc - stamp.offsetMinutes * 60_000
}

function field(value: string | undefined): number {
  return value === undefined ? 0 : Number(value)
}

/** `UTC+8` / `UTC+08:00` / `UTC-5` 这类标记的行内时刻。 */
function utcLabelInstant(match: RegExpMatchArray): number | undefined {
  const sign = match[7] === '-' ? -1 : 1
  return instantOf({
    year: Number(match[1]), month: Number(match[2]), day: Number(match[3]),
    hour: Number(match[4]), minute: Number(match[5]), second: field(match[6]),
    offsetMinutes: sign * (Number(match[8]) * 60 + field(match[9])),
  })
}

/** 自带 `Z` 或 `±hh:mm` 偏移的 ISO 时刻。 */
function isoOffsetInstant(match: RegExpMatchArray): number | undefined {
  const zone = match[7] ?? 'Z'
  let offsetMinutes = 0
  if (zone.toUpperCase() !== 'Z') {
    const sign = zone.startsWith('-') ? -1 : 1
    const digits = zone.slice(1).replace(':', '')
    offsetMinutes = sign * (Number(digits.slice(0, 2)) * 60 + field(digits.slice(2)))
  }
  return instantOf({
    year: Number(match[1]), month: Number(match[2]), day: Number(match[3]),
    hour: Number(match[4]), minute: Number(match[5]), second: field(match[6]),
    offsetMinutes,
  })
}

/**
 * 报文里最早的那个**未来**时刻；没有（或全都太远、全都已过去）时给 undefined。
 *
 * 取最早而不是最晚：一段报文里若同时出现「何时重置」与别的未来日期（下个账期），
 * 能再试的时刻是其中更近的那个。已过去的时刻一律忽略——很多报文会带上事件发生时间，
 * 把它当成重试时间会让每一次失败都变成一次立刻重试。
 * @param text - 失败报文的原始文本（整段 body，未解析）。
 * @param now - 判定「未来」的基准，可注入以便测试。
 * @returns 最早那个合法未来时刻的 UTC 毫秒。
 */
export function resetAtFromText(text: string | undefined, now: number = Date.now()): number | undefined {
  if (text === undefined || text.length === 0) return undefined
  let earliest: number | undefined
  const consider = (at: number | undefined): void => {
    if (at === undefined || at <= now || at - now > RESET_LOOKAHEAD_MS) return
    if (earliest === undefined || at < earliest) earliest = at
  }
  for (const match of text.matchAll(UTC_LABEL)) consider(utcLabelInstant(match))
  for (const match of text.matchAll(ISO_OFFSET)) consider(isoOffsetInstant(match))
  return earliest
}
