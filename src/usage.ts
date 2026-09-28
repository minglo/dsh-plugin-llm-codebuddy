import { CODEBUDDY_IDE_USER_AGENT, CODEBUDDY_USAGE_ENDPOINT, codeBuddyIdentityHeaders } from './constants.js'
import type { CodeBuddyIdentity } from './codebuddy.js'
// 到期日的 +08 日历换算与 client 共用同一份实现（见 expiry-days.ts 的说明）：
// host 用它分累计窗口桶，client 用同一套规则分未来 7 个自然日段。
import { daysFromToday, endTimeOf, shanghaiDayKey } from './expiry-days.js'

/** usage 端点 401/403：token 失效，需触发刷新。与「拉取失败」区分。 */
export class UsageAuthExpiredError extends Error {
  constructor() { super('CodeBuddy usage auth expired'); this.name = 'UsageAuthExpiredError' }
}

export interface UsagePackage {
  name: string
  cycleEndTime: string
  /** 剩余积分（CycleCapacityRemainPrecise）。 */
  remain: number
  /** 该包发放的奖励积分合计（CycleCapacitySizePrecise）；缺失或 < remain 时以 remain 为下限。 */
  size: number
  /** 已用积分 = size − remain（因 size ≥ remain，恒 ≥ 0）。 */
  used: number
}

/**
 * 一个到期档位的双口径读数：
 * - `expiring`：该档内到期包的剩余积分合计 —— 「紧迫度」口径（同档 `remain`）。
 * - `used` / `size` / `usedRatio`：该档内未过期包的已用 / 发放 / 已用率 —— 「消耗度」口径。
 * 分母是该档内未过期包的 size 合计：用完（remain=0）的包照旧计入分母，
 * 否则「已用」会被系统性低估（全用完的档会显示 0%）。
 * 「7天 ⊇ 后日 ⊇ 明日」是累计窗口；`monthPool` 以自然月聚合，与 7 天窗口互不排斥。
 */
export interface UsageBucket {
  expiring: number
  used: number
  size: number
  /** used / size，clamp 到 [0,1]；size ≤ 0 时为 0（不是 NaN）。 */
  usedRatio: number
}

export interface UsageView {
  /** 未过期包的剩余积分合计。 */
  totalBalance: number
  /** 未过期包的奖励积分合计 —— 整体口径的分母。 */
  totalSize: number
  totalUsed: number
  /** totalUsed / totalSize，clamp 到 [0,1]。 */
  totalUsedRatio: number
  /**
   * 本月到期池（CycleEnd 落在上海自然月的全部未过期账户，含 7 天内到期、
   * 含已用光）：remain = 月底前不消费即清零的部分，usedRatio 才是本月真实消耗度。
   * size 0 = 本月无账户（如月初/非自然月套餐），不是错误。
   */
  monthPool: UsageBucket
  monthPoolRemain: number
  monthPoolExpiring: number
  tomorrowExpiring: number
  dayAfterExpiring: number
  weekExpiring: number
  tomorrow: UsageBucket
  dayAfter: UsageBucket
  week: UsageBucket
  details: UsagePackage[]
}

/** 取 wire 对象的字段原值；非对象输入或字段缺失返回 undefined。 */
function field(value: unknown, key: string): unknown {
  if (value === null || typeof value !== 'object') return undefined
  return (value as Record<string, unknown>)[key]
}

function number(value: unknown, key: string): number {
  const raw = field(value, key)
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : 0
  if (typeof raw === 'string') { const p = Number(raw); return Number.isFinite(p) ? p : 0 }
  return 0
}

/** 硬超时：接口异常慢时不能让设置页无限挂「加载中」（fetch 自身无默认超时）。 */
const USAGE_FETCH_TIMEOUT_MS = 10_000

function string(value: unknown, key: string): string {
  const raw = field(value, key)
  return typeof raw === 'string' ? raw : ''
}

function pointer(value: unknown, path: readonly string[]): unknown {
  let cur = value
  for (const key of path) cur = field(cur, key)
  return cur
}

/**
 * 'YYYY-MM-DD HH:mm:ss' 是 CodeBuddy 返回的 naive Asia/Shanghai 墙上时间。
 * 解析失败返回 undefined（区别于「有确定到期时刻」），调用方据此既不判过期也不入档，
 * 但仍计入总额度 —— 避免脏数据被静默丢弃。
 */
/** Asia/Shanghai 当前墙上时间 'YYYY-MM-DD HH:mm:ss'（API 期望的 naive +08 时间）。 */
function shanghaiWallNow(): string {
  const now = new Date()
  // UTC 时刻 +8h 后再按 UTC 读字段，等价于上海墙钟读数。
  const wall = new Date(now.getTime() + 8 * 3_600_000)
  return wall.toISOString().slice(0, 19).replace('T', ' ')
}

/** used / size，clamp 到 [0,1]：size ≤ 0（无包或字段缺失）时为 0，不产 NaN。 */
function ratio(used: number, size: number): number {
  if (size <= 0) return 0
  return Math.min(Math.max(used / size, 0), 1)
}

function bucket(expiring: number, used: number, size: number): UsageBucket {
  return { expiring, used, size, usedRatio: ratio(used, size) }
}

export function parseUsage(raw: unknown): UsageView | undefined {
  const accounts = pointer(raw, ['data', 'Response', 'Data', 'Accounts'])
  if (!Array.isArray(accounts)) return undefined
  const now = new Date()
  const nowKey = shanghaiDayKey(now)
  const details: UsagePackage[] = []
  const acc = {
    monthPool: { expiring: 0, used: 0, size: 0 },
    tomorrow: { expiring: 0, used: 0, size: 0 },
    dayAfter: { expiring: 0, used: 0, size: 0 },
    week: { expiring: 0, used: 0, size: 0 },
  }
  let totalBalance = 0
  let totalSize = 0
  let totalUsed = 0
  for (const rawPkg of accounts) {
    const remain = number(rawPkg, 'CycleCapacityRemainPrecise')
    const name = string(rawPkg, 'PackageName') || string(rawPkg, 'PackageCode') || 'package'
    const cycleEndTime = string(rawPkg, 'CycleEndTime')
    const end = endTimeOf(cycleEndTime)
    // 双保险：请求体已用 PackageEndTimeRangeBegin=now 过滤，此处再拦一次确已过期的包
    // （时钟偏差 / 分页期间跨过到期点），避免其进入「未过期」分母。
    // end 为 undefined（时间格式不符）时无法判定，保留该包计入总额度。
    if (end !== undefined && end.getTime() <= now.getTime()) continue
    // size 缺失或异常（≤0 / < remain）时以 remain 为下限：包不丢弃、已用按 0 计，分母不塌。
    const size = Math.max(number(rawPkg, 'CycleCapacitySizePrecise'), remain, 0)
    const used = size - remain
    totalBalance += remain
    totalSize += size
    totalUsed += used
    // 到期档是「累计窗口」而非互斥分档：每档各自汇总「≤N 天内到期」的有效包，
    // 不剔除已被更近档位吃掉的（7天 ⊇ 后日 ⊇ 明日），与「N 天内到期」的直觉一致。
    const accumulate = (slot: keyof typeof acc): void => {
      acc[slot].expiring += remain
      acc[slot].used += used
      acc[slot].size += size
    }
    const days = daysFromToday(end, now)
    // 本月内到期（自然月）即入池 —— 与 7 天内窗口并行，互不排斥：
    // 7 天内到期只是「更近的日历日」，不改变它仍是本月到期池的一员。
    const monthKey = end === undefined ? undefined : shanghaiDayKey(end).slice(0, 7)
    if (monthKey !== undefined && monthKey === nowKey.slice(0, 7)) {
      accumulate('monthPool')
    }
    if (days !== undefined && days >= 0 && days <= 1) accumulate('tomorrow')
    if (days !== undefined && days >= 0 && days <= 2) accumulate('dayAfter')
    if (days !== undefined && days >= 0 && days <= 7) accumulate('week')
    details.push({ name, cycleEndTime, remain, size, used })
  }
  details.sort((a, b) => a.cycleEndTime.localeCompare(b.cycleEndTime))
  return {
    totalBalance,
    totalSize,
    totalUsed,
    totalUsedRatio: ratio(totalUsed, totalSize),
    monthPool: bucket(acc.monthPool.expiring, acc.monthPool.used, acc.monthPool.size),
    monthPoolRemain: acc.monthPool.expiring,
    monthPoolExpiring: acc.monthPool.expiring,
    tomorrowExpiring: acc.tomorrow.expiring,
    dayAfterExpiring: acc.dayAfter.expiring,
    weekExpiring: acc.week.expiring,
    tomorrow: bucket(acc.tomorrow.expiring, acc.tomorrow.used, acc.tomorrow.size),
    dayAfter: bucket(acc.dayAfter.expiring, acc.dayAfter.used, acc.dayAfter.size),
    week: bucket(acc.week.expiring, acc.week.used, acc.week.size),
    details,
  }
}

/** 读取 id 类字段：字符串与有限数字均接受（CodeBuddy 网关 AccountId 可能是数字）。 */
function idText(value: unknown, key: string): string {
  const raw = field(value, key)
  if (typeof raw === 'string') return raw
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw)
  return ''
}

/**
 * 账户身份指纹：同一账户无论怎么分页都返回相同的 id。
 * CycleEndTime 也在指纹内——同 DealName 的多期（renew）包按到期日区分。
 */
function accountFingerprint(account: unknown): string {
  const id = idText(account, 'AccountId') || idText(account, 'DealName') || idText(account, 'PackageName') || idText(account, 'PackageCode')
  const end = string(account, 'CycleEndTime')
  return `${id}\u0000${end}`
}

export async function fetchUsage(identity: CodeBuddyIdentity, signal?: AbortSignal): Promise<UsageView | undefined> {
  const headers: Record<string, string> = {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${identity.accessToken}`,
    'User-Agent': CODEBUDDY_IDE_USER_AGENT,
    // 客户端身份头：服务端「使用记录」据此把本插件认成 VSCode。
    ...codeBuddyIdentityHeaders(),
  }
  if (identity.uid !== undefined) headers['X-User-Id'] = identity.uid
  const seen = new Set<string>()
  let all: unknown[] = []
  let page = 1
  let previousFingerprint: string | undefined
  // 服务端实测忽略 PageNumber/PageSize 并恒定返回同一批账户（2026-09 CodeBuddy
  // 网关回归）：按「页满则续拉」会每页拿到同一页、一直拉到防御上限（50 页 × 秒级
  // 延迟 = 设置页挂起数分钟）。因此终止条件改为：
  //   1. 页不满（< PageSize）—— 正常分页的最后页；
  //   2. 连续两页指纹相同 —— 服务端分页失效，已拿到的就是全部账户；
  //   3. 到达防御性页数上限。
  const MAX_USAGE_PAGES = 50
  for (;;) {
    const body = JSON.stringify({
      PageNumber: page,
      PageSize: 100,
      ProductCode: 'p_tcaca',
      Status: [0, 3],
      PackageEndTimeRangeBegin: shanghaiWallNow(),
      PackageEndTimeRangeEnd: '2126-12-31 23:59:59',
    })
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), USAGE_FETCH_TIMEOUT_MS)
    // 单个 10s 窗口覆盖 fetch（响应头）与 json()（响应体）两段：服务端「秒回头、悬挂体」
    // 同样必须收敛。caller signal 与内部超时经 AbortSignal.any 合并；undefined 直传不报错。
    const combined = signal === undefined ? controller.signal : AbortSignal.any([signal, controller.signal])
    let response: Response
    try {
      response = await fetch(`${CODEBUDDY_USAGE_ENDPOINT}/v2/billing/meter/get-user-resource`, {
        method: 'POST', headers, body, signal: combined,
      })
      if (response.status === 401 || response.status === 403) throw new UsageAuthExpiredError()
      if (!response.ok) return undefined
      const raw = await response.json() as { code?: number }
      if (raw.code !== undefined && raw.code !== 0) return undefined
      const accounts = pointer(raw, ['data', 'Response', 'Data', 'Accounts'])
      if (!Array.isArray(accounts)) break
      // 指纹比较必须在本页并入 all 之前做：重复页不重复计数。
      const fingerprint = accounts.map(accountFingerprint).join('|')
      const repeated = previousFingerprint !== undefined && fingerprint === previousFingerprint
      for (const account of accounts) {
        const fp = accountFingerprint(account)
        if (seen.has(fp)) continue
        seen.add(fp)
        all.push(account)
      }
      previousFingerprint = fingerprint
      if (accounts.length < 100) break
      if (repeated) break
      if (page >= MAX_USAGE_PAGES) return undefined // 防御性页数上限：防异常数据导致无限拉取
      page++
    } catch (error) {
      // 401/403 是身份失效信号，必须上抛让调用方触发刷新——不能按「不可读」吞掉。
      if (error instanceof UsageAuthExpiredError) throw error
      // 超时（头或体阶段）/ 网络错误 / 上游 abort：一律视为本次不可读，返回 undefined（不抛）。
      return undefined
    } finally {
      clearTimeout(timer)
    }
  }
  return parseUsage({ data: { Response: { Data: { Accounts: all } } } })
}
