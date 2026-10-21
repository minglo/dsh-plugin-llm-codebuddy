/**
 * 签到态的**唯一**客户端来源。
 *
 * 与 {@link import('./usage-feed.js').usageFeed} 同构：一个 remote 一份 feed，
 * 两处入口（插件配置页、输入框弹层）共享同一份状态，所以在弹层里签到，
 * 插件页也立刻显示「已签到」——两处不会给出矛盾答案。
 *
 * 与 usage-feed 的三处不同，都是被签到这件事本身的性质决定的：
 *
 * 1. **不轮询。** 签到态一天只变一次（用户点一下），额度读数那种 10 秒一次的
 *    轮询对它是纯浪费。改成「首次订阅读一次 + 签到后重读」。
 * 2. **签到是写操作。** 所以有一层 `pending`：请求在飞时圆心不可再点，
 *    否则双击会发出两次写请求。
 * 3. **失败后要重读状态。** 服务端可能因为「其实今天已经签过了」而返回失败；
 *    权威判据是状态接口，不是签到接口的返回值。所以任何一次签到尝试之后都
 *    重读一次状态——**状态说签到了，就算签到了**，不弹失败提示。
 */
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { CheckinResultView, CheckinStatusView } from '../remote-types.js'
import { unwrap } from './shared.js'

/** 签到态快照。 */
export interface CheckinSnapshot {
  /** 宿主是否读到了签到态（未登录 / 接口不可用时为 false）。 */
  available: boolean
  /** 活动是否开启（账号不参与签到时为 false）。 */
  active: boolean
  /** 今日是否已签到。 */
  checkedIn: boolean
  /** 连签天数。 */
  streakDays: number
  /** 今日签到可得积分。 */
  dailyCredit: number
  /** 今日已得积分。 */
  todayCredit: number
  /** 正在请求签到：此时圆心不可点。 */
  pending: boolean
}

/** 签到结果。失败时 `message` 是服务端原文（可能是「今日已签到」）。 */
export interface CheckinResult {
  ok: boolean
  /** 失败原因（成功时缺省）。 */
  message?: string
  /** 本次签到得到的积分。 */
  credit: number
  /** 签到后的连签天数。 */
  streakDays: number
}

/** 签到面（网关 client face）。 */
export interface CheckinRemote {
  checkinStatus(): Promise<RemoteResult<CheckinStatusView>>
  checkin(): Promise<RemoteResult<CheckinResultView>>
}

export interface CheckinFeed {
  subscribe(listener: () => void): () => void
  getSnapshot(): CheckinSnapshot
  /** 读一次签到态。 */
  read(): void
  /** 点签到。返回结果；失败时状态已被重读，调用方据此决定要不要提示。 */
  checkin(): Promise<CheckinResult>
}

const EMPTY: CheckinSnapshot = {
  available: false,
  active: false,
  checkedIn: false,
  streakDays: 0,
  dailyCredit: 0,
  todayCredit: 0,
  pending: false,
}

class Feed implements CheckinFeed {
  private snapshot: CheckinSnapshot = EMPTY
  private readonly listeners = new Set<() => void>()
  private pending = false
  private disposed = false

  constructor(private readonly remote: CheckinRemote) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    // 首个订阅者进来时读一次：两处入口任一挂上，签到态就位。
    if (this.listeners.size === 1) void this.readOnce()
    return () => { this.listeners.delete(listener) }
  }

  getSnapshot = (): CheckinSnapshot => this.snapshot

  read = (): void => { void this.readOnce() }

  /**
   * 点签到。
   *
   * 流程：置 pending → 调签到 → **无论成败都重读状态** → 依据状态定成败。
   * 「服务端说失败但状态说已签到」按成功算（多半是用户已经在别处签过了）。
   */
  checkin = async (): Promise<CheckinResult> => {
    if (this.pending) return { ok: false, credit: 0, streakDays: 0 }
    this.pending = true
    this.publish({ ...this.snapshot, pending: true })
    let result: CheckinResult = { ok: false, credit: 0, streakDays: 0 }
    try {
      const response = await unwrap(this.remote.checkin())
      result = {
        ok: response.success,
        // 只把**服务端**的原因带给调用方；网络错误不给 message（那是调用方
        // 该自己翻译的内部细节，不该原样上屏）。
        ...(response.success || response.message === undefined ? {} : { message: response.message }),
        credit: response.credit,
        streakDays: response.streakDays,
      }
    } catch {
      result = { ok: false, credit: 0, streakDays: 0 }
    } finally {
      this.pending = false
    }
    // 重读状态：它是权威判据。服务端说失败但状态说已签到时，按签到成功算。
    await this.readOnce()
    if (!result.ok && this.snapshot.checkedIn) {
      return { ok: true, credit: this.snapshot.todayCredit, streakDays: this.snapshot.streakDays }
    }
    return result
  }

  private async readOnce(): Promise<void> {
    if (this.disposed) return
    try {
      const status = await unwrap(this.remote.checkinStatus())
      if (this.disposed) return
      this.publish({
        available: status.available,
        active: status.active,
        checkedIn: status.checkedIn,
        streakDays: status.streakDays,
        dailyCredit: status.dailyCredit,
        todayCredit: status.todayCredit,
        pending: this.pending,
      })
    } catch {
      if (this.disposed) return
      // 读不到就保持「不可用」：宁可不给签到入口，也不要给一个可能是错的入口。
      this.publish({ ...this.snapshot, available: false, pending: this.pending })
    }
  }

  /** 只在内容真的变了时换引用：`useSyncExternalStore` 靠引用判等。 */
  private publish(next: CheckinSnapshot): void {
    const current = this.snapshot
    if (
      current.available === next.available && current.active === next.active
      && current.checkedIn === next.checkedIn && current.streakDays === next.streakDays
      && current.dailyCredit === next.dailyCredit && current.todayCredit === next.todayCredit
      && current.pending === next.pending
    ) return
    this.snapshot = next
    for (const listener of this.listeners) listener()
  }
}

/**
 * 按 remote 身份取 feed。
 *
 * WeakMap 而不是单例：测试里每个用例都新建 remote 桩，按键隔离让用例之间不串
 * 状态；前一个 remote 被回收后 feed 也随之回收。
 */
const feeds = new WeakMap<CheckinRemote, CheckinFeed>()

export function checkinFeed(remote: CheckinRemote): CheckinFeed {
  let feed = feeds.get(remote)
  if (feed === undefined) {
    feed = new Feed(remote)
    feeds.set(remote, feed)
  }
  return feed
}
