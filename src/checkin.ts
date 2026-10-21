/**
 * CodeBuddy 签到（网页控制台里的「Buddy 加油站」）的宿主侧客户端。
 *
 * 三个端点，都在 www.codebuddy.cn 上，与额度查询（usage.ts）同一台网关：
 *   · 状态     POST /v2/billing/meter/checkin-activity-status
 *   · 状态回退 POST /v2/billing/meter/checkin-status
 *   · 签到     POST /v2/billing/meter/daily-checkin
 *
 * 三条硬约定（每一条都有代价，所以写在这里而不是散在代码里）：
 *
 * 1. **仅 `code === 0` 算成功。** 业务错误——「今日已签到」「活动未开启」——
 *    都是 `code !== 0` + `msg`/`message` 说明原因。HTTP 200 不代表成功。
 * 2. **字段名下划线与驼峰两种写法都要认。** 服务端两种都在用（`today_checked_in`
 *    与 `todayCheckedIn`），少认一种就整条读数丢失。
 * 3. **UA 用浏览器形态**，与本插件其它外呼不同（那些发 VSCode 形态的 IDE UA）。
 *    签到是 codebuddy.cn **网页控制台**的功能，网关会拒绝非浏览器 UA
 *    （403 / code=10085）。这里发一支通用的桌面 Chrome UA。
 */
import { CODEBUDDY_USAGE_ENDPOINT, withIdentityHeaders } from './constants.js'
import type { CodeBuddyIdentity } from './codebuddy.js'

/**
 * 签到端点用的浏览器 UA。
 *
 * **实测（2026-10-22）**：浏览器 UA 与插件自己的 IDE UA（VSCode 形态）在
 * `/v2/billing/meter/checkin-activity-status` 上都返回 HTTP 200 + code 0，网关
 * 没有拦。第三方签到实现坚持发浏览器 UA，故这里沿用同一支——它是**更保守**的
 * 那一支，而写端点（daily-checkin）没有实测过，不冒险换。
 */
const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/** 单次外呼硬超时。签到是写操作，不能让它挂住界面。 */
const CHECKIN_TIMEOUT_MS = 10_000

/** 状态端点：先试这个（活动口径），失败再试下一个（回退口径）。 */
const STATUS_PATHS = [
  '/v2/billing/meter/checkin-activity-status',
  '/v2/billing/meter/checkin-status',
] as const

/** 签到端点。 */
const CHECKIN_PATH = '/v2/billing/meter/daily-checkin'

/** 今日签到态（宿主与客户端共享的 wire 类型）。 */
export interface CheckinStatus {
  /** 活动是否开启。关掉时账号不参与签到，客户端据此不给出签到入口。 */
  active: boolean
  /** 今日是否已签到。 */
  checkedIn: boolean
  /** 连签天数（0 = 无从得知）。 */
  streakDays: number
  /** 今日签到可得积分。 */
  dailyCredit: number
  /** 今日已得积分。 */
  todayCredit: number
}

/** 一次签到的结果。 */
export interface CheckinOutcome {
  /** 是否签到成功。 */
  success: boolean
  /** 失败原因（服务端文案，成功时缺省）。 */
  message?: string
  /** 本次签到得到的积分。 */
  credit: number
  /** 签到后的连签天数。 */
  streakDays: number
}

type Json = Record<string, unknown>

/** 取一个布尔字段，认下划线与驼峰两种写法；认不出就用缺省。 */
function pickBool(data: Json, snake: string, camel: string, fallback: boolean): boolean {
  const raw = data[snake] ?? data[camel]
  if (typeof raw === 'boolean') return raw
  if (typeof raw === 'number') return raw !== 0
  if (typeof raw === 'string') {
    const lowered = raw.trim().toLowerCase()
    if (lowered === 'true' || lowered === '1') return true
    if (lowered === 'false' || lowered === '0') return false
  }
  return fallback
}

/** 取一个整数字段，认下划线与驼峰两种写法；认不出返回 undefined。 */
function pickInt(data: Json, snake: string, camel: string): number | undefined {
  const raw = data[snake] ?? data[camel]
  if (typeof raw === 'boolean') return undefined
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  if (typeof raw === 'string' && /^-?\d+$/.test(raw.trim())) return Number(raw.trim())
  return undefined
}

/** 取一个字符串字段。 */
function pickString(data: Json, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const raw = data[key]
    if (typeof raw === 'string' && raw.length > 0) return raw
  }
  return undefined
}

/**
 * 发一次 POST 并解出统一信封。
 *
 * @returns 成功时是 `data`，失败时是 undefined（原因由调用方决定要不要报）。
 */
async function postJson(
  identity: CodeBuddyIdentity,
  path: string,
  signal?: AbortSignal,
): Promise<{ ok: true; data: Json } | { ok: false; message: string }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), CHECKIN_TIMEOUT_MS)
  const combined = signal === undefined ? controller.signal : AbortSignal.any([signal, controller.signal])
  const headers = withIdentityHeaders({
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': BROWSER_USER_AGENT,
  }, identity)
  try {
    const response = await fetch(`${CODEBUDDY_USAGE_ENDPOINT}${path}`, {
      method: 'POST',
      headers,
      body: '{}',
      signal: combined,
    })
    if (response.status === 401 || response.status === 403) {
      // 401 是 token 失效；403 多半是网关的 UA 校验没过。两者都不是「活动没开」。
      return { ok: false, message: `HTTP ${response.status}` }
    }
    if (!response.ok) return { ok: false, message: `HTTP ${response.status}` }
    let body: unknown
    try {
      body = await response.json()
    } catch {
      return { ok: false, message: 'invalid json' }
    }
    if (typeof body !== 'object' || body === null) return { ok: false, message: 'invalid body' }
    const envelope = body as Json
    const code = envelope['code']
    if (code !== 0) {
      const message = pickString(envelope, 'message', 'msg') ?? 'unknown error'
      return { ok: false, message }
    }
    const data = envelope['data']
    if (typeof data !== 'object' || data === null) return { ok: true, data: {} }
    return { ok: true, data: data as Json }
  } catch {
    return { ok: false, message: 'network error' }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 读今日签到态。
 *
 * 两个状态端点依次试：先试活动口径（`checkin-activity-status`），它挂了再试
 * 回退口径（`checkin-status`）。两个都读不到时返回 undefined——**读不到**与
 * **读到了但活动没开**是两回事：前者是接口不可用，后者是账号不参与签到。
 */
export async function fetchCheckinStatus(
  identity: CodeBuddyIdentity,
  signal?: AbortSignal,
): Promise<CheckinStatus | undefined> {
  for (const path of STATUS_PATHS) {
    const result = await postJson(identity, path, signal)
    if (!result.ok) continue
    const data = result.data
    return {
      // 缺省按「已开启」处理：接口给了 data 就说明活动存在，显式 false 才算关掉。
      active: pickBool(data, 'active', 'Active', true),
      checkedIn: pickBool(data, 'today_checked_in', 'todayCheckedIn', false),
      streakDays: pickInt(data, 'streak_days', 'streakDays') ?? 0,
      dailyCredit: pickInt(data, 'daily_credit', 'dailyCredit') ?? 0,
      todayCredit: pickInt(data, 'today_credit', 'todayCredit') ?? 0,
    }
  }
  return undefined
}

/**
 * 执行今日签到。
 *
 * @returns 成功与否。失败时 `message` 是服务端给的原文（可能是「今日已签到」）。
 */
export async function performCheckin(
  identity: CodeBuddyIdentity,
  signal?: AbortSignal,
): Promise<CheckinOutcome> {
  const result = await postJson(identity, CHECKIN_PATH, signal)
  if (!result.ok) return { success: false, message: result.message, credit: 0, streakDays: 0 }
  const data = result.data
  // 服务端成功时不总带 success 字段；缺省按成功算（code 已经是 0 了）。
  const success = pickBool(data, 'success', 'Success', true)
  const credit = pickInt(data, 'credit', 'Credit')
    ?? pickInt(data, 'today_credit', 'todayCredit')
    ?? 0
  const message = pickString(data, 'message', 'msg')
  return {
    success,
    // exactOptionalPropertyTypes 下不能写 `message: undefined`——那与「没有这个
    // 字段」不是一回事，故按有没有值分别构造。
    ...(message === undefined ? {} : { message }),
    credit,
    streakDays: pickInt(data, 'streak_days', 'streakDays') ?? 0,
  }
}
