/**
 * 两个用量入口（侧栏指示器 + 输入框旁胶囊）**共用的唯一轮询器**。
 *
 * 为什么要有这一层：两处都读同一个 `remote.usage()`。各自 `setInterval` 会让
 * 每轮都对腾讯网关发两次完全相同的请求——同一账号、同一份额度、同一时刻。
 * 这里把它收敛成「一个 remote 一个 feed」：订阅者从 0 变 1 时启动，
 * 归 0 时停表，读数与失败状态在订阅者之间共享，所有订阅者看到的是同一份快照
 * （这也顺带保证了两处显示的数字永远一致，不会出现侧栏 10%、胶囊 12% 的错位）。
 *
 * 快照对象只在内容真正变化时替换引用：`useSyncExternalStore` 靠引用判等，
 * 每 tick 新建对象会让两处入口无谓重渲染。
 */
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { UsageResult, UsageView } from '../remote-types.js'
import { subscribeLoginChange } from './notifiers.js'
import { unwrap, withTimeout } from './shared.js'

/** 轮询周期。切到后台不停表。 */
export const USAGE_REFRESH_MS = 10_000

/**
 * 单次外呼硬超时；网关挂住时不能让定时器越堆越多。
 *
 * 取 8 秒＝**短于**轮询周期（10 秒）。这不是硬性正确性要求，而是让每一 tick 都
 * 重新获得机会：超时若长于周期，一次慢读会横跨两个 tick，中间那一轮被单飞挡掉，
 * 有效刷新间隔就从 10 秒退化到 20 秒（更慢还会继续乘）。超时短于周期时，最坏
 * 情况只是那一轮读数落空、下一 tick 立刻重试。
 *
 * 8 秒也留得住正常路径：宿主的真实外呼只发生在冷启动或缓存陈旧时。2026-09-28
 * 实测单页外呼（含 90KB 响应体，当前账号 66 个包、单页即结束）为 342–531ms，
 * 8 秒有约 15 倍余量；宿主自己的每页上限是 10 秒，多页账号最坏会到十几秒。
 * 极端情况下冷读超过 8 秒，界面会短暂落成空态，但宿主侧仍在飞的那次刷新不会被
 * 取消——下一 tick 会接上它并拿到值。
 */
export const USAGE_READ_TIMEOUT_MS = 8_000

/** 一次读数的结果。三个字段要么整组出现，要么整组保持上一次的值。 */
export interface UsageSnapshot {
  /** 最近一次成功读数；未登录、读取失败或尚未读过时为 undefined。 */
  view: UsageView | undefined
  /** 是否已登录。false 表示「未登录」或「还没读到」——两者都不该渲染数字。 */
  loggedIn: boolean
  /** 最近一次成功读数的时刻，用于「更新于」；未读到时为 undefined。 */
  updatedAt: number | undefined
}

const EMPTY: UsageSnapshot = { view: undefined, loggedIn: false, updatedAt: undefined }

/**
 * 关闭态用的稳定空态。必须是**同一个对象**：`useSyncExternalStore` 用
 * `Object.is` 比较快照，每次新建对象会被判成「变了」，从而触发无限重渲染。
 */
export const EMPTY_USAGE_SNAPSHOT: UsageSnapshot = EMPTY

/** 用量远端面：与 `UsageIndicatorInjected['remote']` 同形，只取 feed 需要的两个方法。 */
export interface UsageRemote {
  usage(): Promise<RemoteResult<UsageResult>>
}

/** 一个 remote 对应一个 feed；订阅者拿到的读写面。 */
export interface UsageFeed {
  subscribe(listener: () => void): () => void
  getSnapshot(): UsageSnapshot
  /** 立即重读一次（登录态变化时用；不改变订阅计数）。 */
  refresh(): void
  /**
   * 立即读一次，**用于用户主动索要新读数**（打开额度弹窗）。
   *
   * 与 `refresh()` 是同一件事，分开命名是为了让调用点的意图可读：
   * `refresh` = 「有外部事件说明数据变了」，`read` = 「用户现在想看」。
   * 两者都尊重单飞：上一轮还没回来时不叠加请求。真正的出站成本由宿主侧
   * 缓存吸收（TTL 内的重复读取不会再打 CodeBuddy 网关）。
   */
  read(): void
}

/**
 * 一个 feed = 一个 remote 的一份共享读数。
 *
 * 计数归零时**丢弃快照**而不是保留：再次订阅（例如用户关掉又打开开关）应当
 * 先显示空态再等新读数，而不是把几分钟前的旧额度当成当前值重新亮出来。
 */
class Feed implements UsageFeed {
  private snapshot: UsageSnapshot = EMPTY
  private readonly listeners = new Set<() => void>()
  private timer: number | undefined
  private unsubscribeLogin: (() => void) | undefined
  private busy = false
  private disposed = false

  constructor(private readonly remote: UsageRemote) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    if (this.listeners.size === 1) this.start()
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size === 0) this.stop()
    }
  }

  getSnapshot = (): UsageSnapshot => this.snapshot

  refresh = (): void => { void this.readOnce() }
  read = (): void => { void this.readOnce() }

  private start(): void {
    this.disposed = false
    this.snapshot = EMPTY
    // 登录/退出成功后立即重读：不重读就要等满一个轮询周期才看到新账号的额度。
    this.unsubscribeLogin = subscribeLoginChange(this.refresh)
    void this.readOnce()
    this.timer = window.setInterval(() => { void this.readOnce() }, USAGE_REFRESH_MS)
  }

  private stop(): void {
    this.disposed = true
    this.unsubscribeLogin?.()
    this.unsubscribeLogin = undefined
    if (this.timer !== undefined) window.clearInterval(this.timer)
    this.timer = undefined
    this.snapshot = EMPTY
  }

  /**
   * 单飞：上一轮没回来就跳过这一轮。网关慢于 10 秒时，排队等着的请求会
   * 在恢复后一次性倾泻，而它们读的是同一份额度——跳过不丢信息。
   *
   * 出站成本不在这里控制，而在宿主侧缓存：轮询快只是「问得勤」，宿主按
   * `USAGE_CACHE_TTL_MS`（60 秒）决定何时真的去打 CodeBuddy，问再勤也只让
   * 界面更快看到后台刷新出来的新值。
   */
  private async readOnce(): Promise<void> {
    if (this.busy || this.disposed || this.listeners.size === 0) return
    this.busy = true
    try {
      const result = await withTimeout(unwrap(this.remote.usage()), USAGE_READ_TIMEOUT_MS)
      if (this.disposed) return
      this.publish(result.loggedIn && result.view !== undefined
        // `updatedAt` 取宿主报的**抓取时刻**，不是「本次读到」的时刻：宿主缓存
        // 会让一次抓取服务多个入口与多次重挂，客户端各自打时间戳会把同一份
        // 读数标成不同时间。旧宿主不发 fetchedAt 时才回落到本地时刻。
        ? { view: result.view, loggedIn: true, updatedAt: result.fetchedAt ?? Date.now() }
        // 未登录不是「读失败」：同样落成空态。
        : EMPTY)
    } catch {
      // 网关失败/本地故障：清空读数，等下一轮或登录态变化重试。
      if (!this.disposed) this.publish(EMPTY)
    } finally {
      this.busy = false
    }
  }

  /** 只在内容变化时换引用：`useSyncExternalStore` 靠引用判等，避免无谓重渲染。 */
  private publish(next: UsageSnapshot): void {
    const current = this.snapshot
    if (current.view === next.view && current.loggedIn === next.loggedIn
      && current.updatedAt === next.updatedAt) return
    this.snapshot = next
    for (const listener of this.listeners) listener()
  }
}

/**
 * 按 remote 身份取 feed。
 *
 * WeakMap 而不是单例：测试里每个用例都会新建一个 remote 桩，按键隔离能让
 * 用例之间不串状态（否则上一个用例的定时器会把读数带进下一个用例），
 * 同时前一个 remote 被回收后 feed 也随之回收，无需手工清理。
 */
const feeds = new WeakMap<UsageRemote, UsageFeed>()

export function usageFeed(remote: UsageRemote): UsageFeed {
  let feed = feeds.get(remote)
  if (feed === undefined) {
    feed = new Feed(remote)
    feeds.set(remote, feed)
  }
  return feed
}
