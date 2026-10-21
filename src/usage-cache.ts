/**
 * 宿主侧额度读数的进程内缓存（stale-while-revalidate）。
 *
 * 为什么放在宿主而不是客户端：
 *
 * 1. **额度接口是宿主的能力，不是浏览器能自己拿的东西**。客户端只经
 *    `remote.codebuddy.usage()` 走 Typert 网关；出站 HTTP、凭据刷新、分页
 *    全部发生在宿主。所以「缓存一份」的唯一合理位置也是宿主——浏览器里的
 *    缓存只是同一份数据的第二副本，且刷新它仍要付一次多页外呼。
 * 2. 多个客户端入口（侧栏指示器、输入框胶囊、插件配置页）与多次重挂
 *    （HMR、刷新页面、面板开合）会各自发起读取。没有共享缓存时，这些读取
 *    各自打一轮**多页**外呼，用户看到的就是「指标要等一下才出来」。
 *
 * 策略是 stale-while-revalidate 而不是纯 TTL：
 *
 * - 冷启动（无任何缓存）：必须等一次真实读取——没有旧值可给。
 * - 新鲜（年龄 < TTL）：直接给缓存，一个请求都不发。
 * - 陈旧：**立刻**返回缓存里的旧值，同时在后台做一次共享刷新。
 *
 * 陈旧分支是关键：它把「等待」从用户可见路径上彻底移除。用户永远先看到
 * 上一份读数（带 `at` 即抓取时刻，所以不会被误读成实时），数值在后台刷新
 * 到位后由下一次读取替换。这也让 `usage()` 在网关慢或抖动时依旧即时返回。
 *
 * 单飞（single-flight）：并发读取共享同一次外呼，不叠加。上一轮没回来时
 * 不另起一轮——它们读的是同一账号同一份额度。
 */
import type { CodeBuddyIdentity } from './codebuddy.js'
import type { UsageView } from './usage.js'

/**
 * 账号身份键。
 *
 * 用 uid + 企业 id，**不用 token**：token 会随刷新轮换，拿它当键会让每次
 * 401 后的正常刷新都判定成「换了账号」，缓存永远命不中。
 */
export function usageCacheKey(identity: CodeBuddyIdentity): string {
  return `${identity.uid ?? ''}\u0000${identity.enterpriseId ?? ''}`
}

/** 一份缓存条目：键（账号身份）+ 值 + 抓取时刻。 */
interface CacheEntry {
  key: string
  view: UsageView
  at: number
}

/** 一次读取的结果：值、抓取时刻（undefined = 无缓存），以及是否在后台刷新。 */
export interface UsageSnapshot {
  view: UsageView | undefined
  /** 该值的抓取时刻（宿主时钟，毫秒）；无缓存时 undefined。 */
  at: number | undefined
  /** 是否已触发一次后台刷新（陈旧缓存分支）。调用方无需等待它。 */
  refreshing: boolean
}

export interface UsageCacheOptions {
  /** 新鲜窗口；超过即视为陈旧（但仍可用，并触发后台刷新）。 */
  ttlMs: number
  /** 时钟，测试可注入。 */
  now?: () => number
}

/**
 * 按账号身份键缓存的额度读数。
 *
 * 账号切换（重新登录、换企业）会让键失效：旧账号的额度绝不能显示给新账号。
 * 实现上不主动按账号清理，只在读取时按键比对——键不一致就等于没有缓存，
 * 于是新账号走一次冷读取。
 */
export class UsageCache {
  private entry: CacheEntry | undefined
  private inflight: { key: string; promise: Promise<UsageView | undefined> } | undefined

  constructor(private readonly options: UsageCacheOptions) {}

  private get now(): number {
    return this.options.now?.() ?? Date.now()
  }

  /**
   * 读一次。**永不因为「陈旧」而阻塞调用方。**
   *
   * @param key - 当前账号身份键；与缓存条目不符即视为无缓存。
   * @param load - 真实外呼；返回 undefined 表示「本次不可读」（正常结果，非错误）。
   */
  async read(key: string, load: (key: string) => Promise<UsageView | undefined>): Promise<UsageSnapshot> {
    const cached = this.entry?.key === key ? this.entry : undefined

    if (cached !== undefined) {
      const age = this.now - cached.at
      // 新鲜：一个请求都不发。
      if (age < this.options.ttlMs) {
        return { view: cached.view, at: cached.at, refreshing: false }
      }
      // 陈旧：先把旧值给出去，再在后台刷新。不 await，并吞掉失败——
      // 这一轮的失败只该让下一次读取重试，不该变成未处理的 rejection，更不该
      // 影响已经返回给调用方的旧值。
      void this.refresh(key, load).catch(() => undefined)
      return { view: cached.view, at: cached.at, refreshing: true }
    }

    // 冷启动：没有旧值可给，必须等。
    const view = await this.refresh(key, load)
    return view === undefined
      ? { view: undefined, at: undefined, refreshing: false }
      : { view, at: this.now, refreshing: false }
  }

  /** 丢弃缓存：退出登录时必须调用，否则会把上一个账号的额度留给下一个。 */
  clear(): void {
    this.entry = undefined
  }

  /**
   * 单飞刷新。并发调用共享同一个 promise。
   *
   * 失败（load 抛错）不污染缓存：保留旧条目，让下一次读取继续重试。
   * load 返回 undefined（不可读）同样保留旧条目——「本次读不到」是正常结果，
   * 不该因此把已有的好数据丢掉。
   */
  private refresh(key: string, load: (key: string) => Promise<UsageView | undefined>): Promise<UsageView | undefined> {
    if (this.inflight !== undefined && this.inflight.key === key) return this.inflight.promise
    const promise = load(key).then(
      (view) => {
        // 账号在飞行途中变了怎么办？不需要在这里判断：条目按 key 存，
        // 下一次 read 拿新 key 去比就必然不命中，于是走冷读取。
        // 旧 key 的条目留在那里也永远不会被读到。
        if (view !== undefined) this.entry = { key, view, at: this.now }
        return view
      },
    ).finally(() => {
      if (this.inflight?.promise === promise) this.inflight = undefined
    })
    this.inflight = { key, promise }
    return promise
  }
}
