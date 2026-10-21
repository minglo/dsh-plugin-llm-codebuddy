import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { usageFeed, USAGE_READ_TIMEOUT_MS, USAGE_REFRESH_MS } from '../src/client/usage-feed.js'
import { emitLoginChange } from '../src/client/notifiers.js'

const ok = <T,>(value: T): { ok: true; value: T } => ({ ok: true, value })

/** 一份最小可用的额度 view；feed 只做搬运，不解释字段。 */
const view = { totalBalance: 100, totalSize: 200, totalUsed: 100, totalUsedRatio: 0.5 }

function makeRemote(): { usage: ReturnType<typeof vi.fn> } {
  // 每个用例一个新对象：feed 按 remote 身份缓存，新对象 = 新 feed = 干净状态。
  // 刻意不带 fetchedAt：这是「旧宿主」形态，用来覆盖回落分支。
  return { usage: vi.fn(async () => ok({ loggedIn: true, view })) }
}

/** 让已排队的微任务跑完（feed 的 read 是 async）。 */
const flush = async (): Promise<void> => { await vi.advanceTimersByTimeAsync(0) }

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('usageFeed（两个用量入口共用的唯一轮询器）', () => {
  it('订阅者共享同一次请求：侧栏与胶囊不再各打一次网关', async () => {
    const remote = makeRemote()
    const feed = usageFeed(remote)
    const a = feed.subscribe(() => {})
    const b = feed.subscribe(() => {})
    await flush()
    expect(remote.usage).toHaveBeenCalledTimes(1)

    // 一个周期仍然只发一次，而不是每个订阅者一次。
    await vi.advanceTimersByTimeAsync(USAGE_REFRESH_MS)
    expect(remote.usage).toHaveBeenCalledTimes(2)
    a(); b()
  })

  it('read() 立即重读一次，供「用户主动索要」的入口使用', async () => {
    // 打开额度弹窗属于显式意图，不该等下一轮客户端定时器（10 秒）。
    const remote = makeRemote()
    const feed = usageFeed(remote)
    const stop = feed.subscribe(() => {})
    await flush()
    expect(remote.usage).toHaveBeenCalledTimes(1)

    feed.read()
    await flush()
    expect(remote.usage).toHaveBeenCalledTimes(2)
    stop()
  })

  it('read() 在上一轮未回来时被单飞守卫跳过（不叠加请求）', async () => {
    // 「点开就刷新」不能变成连点连打：出站成本由宿主侧缓存吸收，但客户端
    // 这一层也不该把重复请求排出去。
    let release: (() => void) | undefined
    const remote = {
      usage: vi.fn(async () => {
        await new Promise<void>((resolve) => { release = resolve })
        return ok({ loggedIn: true, view })
      }),
    }
    const feed = usageFeed(remote)
    const stop = feed.subscribe(() => {})
    await flush()
    feed.read()
    feed.read()
    await flush()
    expect(remote.usage).toHaveBeenCalledTimes(1)
    release?.()
    await flush()
    stop()
  })

  it('updatedAt 取宿主报的抓取时刻，而不是「本次读到」的时刻', async () => {
    // 宿主缓存让一次抓取服务多个入口与多次重挂；客户端各自打时间戳会把同一份
    // 读数标成不同时间（于是「更新于」在不同入口显示不同值）。
    const hosted = 1_700_000_000_000
    const remote = { usage: vi.fn(async () => ok({ loggedIn: true, view, fetchedAt: hosted })) }
    const feed = usageFeed(remote)
    const stop = feed.subscribe(() => {})
    await flush()
    expect(feed.getSnapshot().updatedAt).toBe(hosted)
    stop()
  })

  it('旧宿主不发 fetchedAt 时回落到本地时刻', async () => {
    const remote = makeRemote()
    const feed = usageFeed(remote)
    const stop = feed.subscribe(() => {})
    await flush()
    expect(typeof feed.getSnapshot().updatedAt).toBe('number')
    stop()
  })

  it('订阅者看到同一份快照（两处入口不会显示对不上的数字）', async () => {
    const remote = makeRemote()
    const feed = usageFeed(remote)
    const stop = feed.subscribe(() => {})
    await flush()
    expect(feed.getSnapshot()).toEqual({ view, loggedIn: true, updatedAt: expect.any(Number) })
    // 第二个订阅者拿到的就是这份共享读数，不是自己的一份拷贝。
    const other = usageFeed(remote)
    expect(other.getSnapshot()).toBe(feed.getSnapshot())
    stop()
  })

  it('内容没变的重复读数换快照引用（updatedAt 每次都推进，useSyncExternalStore 靠引用判等）', async () => {
    // 原用例名说「不换引用」，断言却是 not.toBe（正好相反）——任实现怎么变都能过。
    // 实测语义是：宿主每次读数都带新的 fetchedAt，updatedAt 因此每次都变，
    // 快照必须换新引用，否则 uSES 认为没变化、界面上的「更新于」永远停在第一次。
    const hosted = [1_700_000_000_000, 1_700_000_010_000]
    let call = 0
    const remote = { usage: vi.fn(async () => ok({ loggedIn: true, view, fetchedAt: hosted[call++] })) }
    const feed = usageFeed(remote)
    const listener = vi.fn()
    const stop = feed.subscribe(listener)
    await flush()
    const first = feed.getSnapshot()
    expect(listener).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(USAGE_REFRESH_MS)
    // 引用必须换；且换的是**新读数**（updatedAt 跟着宿主的 fetchedAt 走）。
    const second = feed.getSnapshot()
    expect(second).not.toBe(first)
    expect(second.updatedAt).toBe(hosted[1])
    expect(listener).toHaveBeenCalledTimes(2)
    stop()
  })

  it('最后一个订阅者离开即停表：关掉开关的入口不产生任何外呼', async () => {
    const remote = makeRemote()
    const feed = usageFeed(remote)
    const stop = feed.subscribe(() => {})
    await flush()
    expect(remote.usage).toHaveBeenCalledTimes(1)

    stop()
    await vi.advanceTimersByTimeAsync(USAGE_REFRESH_MS * 3)
    expect(remote.usage).toHaveBeenCalledTimes(1)

    // 重新订阅：先回到空态再读新值，不把几分钟前的旧额度当当前值亮出来。
    const again = feed.subscribe(() => {})
    expect(feed.getSnapshot()).toEqual({ view: undefined, loggedIn: false, updatedAt: undefined })
    await flush()
    expect(remote.usage).toHaveBeenCalledTimes(2)
    again()
  })

  it('登录/退出后立即重读，不等满一个客户端轮询周期（10 秒）', async () => {
    const remote = makeRemote()
    const feed = usageFeed(remote)
    const stop = feed.subscribe(() => {})
    await flush()
    expect(remote.usage).toHaveBeenCalledTimes(1)

    emitLoginChange()
    await flush()
    expect(remote.usage).toHaveBeenCalledTimes(2)
    stop()
  })

  it('读取失败落成空态，且不影响下一个周期继续重试', async () => {
    const remote = makeRemote()
    remote.usage.mockRejectedValueOnce(new Error('gateway down')).mockResolvedValue(ok({ loggedIn: false }))
    const feed = usageFeed(remote)
    const stop = feed.subscribe(() => {})
    await flush()
    expect(feed.getSnapshot()).toEqual({ view: undefined, loggedIn: false, updatedAt: undefined })

    remote.usage.mockResolvedValue(ok({ loggedIn: true, view }))
    await vi.advanceTimersByTimeAsync(USAGE_REFRESH_MS)
    expect(feed.getSnapshot().view).toBe(view)
    stop()
  })

  it('未登录时落成空态而不是把 undefined view 当读数', async () => {
    const remote = { usage: vi.fn(async () => ok({ loggedIn: false })) }
    const feed = usageFeed(remote)
    const stop = feed.subscribe(() => {})
    await flush()
    expect(feed.getSnapshot().loggedIn).toBe(false)
    expect(feed.getSnapshot().view).toBeUndefined()
    stop()
  })

  it('单飞：读数还没回来时，登录态变化触发的重读不会叠加第二个请求', async () => {
    const pending: Array<(value: unknown) => void> = []
    const remote = {
      usage: vi.fn(() => new Promise(resolve => { pending.push(resolve as (value: unknown) => void) })),
    }
    const feed = usageFeed(remote)
    const stop = feed.subscribe(() => {})
    await flush()
    expect(remote.usage).toHaveBeenCalledTimes(1)

    // 首次读数仍在途中时又来了登录变化：跳过这一轮，而不是并排再打一次网关。
    emitLoginChange()
    emitLoginChange()
    await flush()
    expect(remote.usage).toHaveBeenCalledTimes(1)

    pending[0]?.(ok({ loggedIn: true, view }))
    await flush()
    expect(feed.getSnapshot().view).toBe(view)
    stop()
  })

  it('外呼超时后解除单飞，下一个周期照常重试', async () => {
    // 网关挂住而不是拒绝：`withTimeout` 必须在硬超时后结束这一轮，否则单飞标志
    // 永远不解除，轮询就此静默死掉——用户看到的是「数字停住不再变」。
    const remote = { usage: vi.fn(() => new Promise(() => {})) }
    const feed = usageFeed(remote)
    const stop = feed.subscribe(() => {})
    await flush()
    expect(remote.usage).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(USAGE_READ_TIMEOUT_MS)
    expect(feed.getSnapshot()).toEqual({ view: undefined, loggedIn: false, updatedAt: undefined })

    await vi.advanceTimersByTimeAsync(USAGE_REFRESH_MS)
    expect(remote.usage).toHaveBeenCalledTimes(2)
    stop()
  })
})

describe('轮询周期与宿主缓存的关系', () => {
  it('客户端每 10 秒问一次宿主', () => {
    // 「加快到 10 秒一次」是明确的接口约定：这里是它的唯一出处，
    // 改大改小都必须同时改这里，避免常量被人顺手当成魔法数字。
    expect(USAGE_REFRESH_MS).toBe(10_000)
  })

  it('单次读取超时短于轮询周期，否则单飞会让读数停更', () => {
    // 超时若 ≥ 周期，一次卡住的读取会横跨两个 tick，后续每轮都被 busy 挡掉——
    // 界面继续显示旧值，看不出已经停止更新。这是「加快轮询」最容易踩的坑。
    expect(USAGE_READ_TIMEOUT_MS).toBeLessThan(USAGE_REFRESH_MS)
  })

  it('宿主缓存 TTL 仍然吸收多次轮询（周期比 TTL 短）', async () => {
    // 客户端每一次轮询都会走一次 remote.usage()，但真正的外呼由宿主侧缓存决定。
    // 周期必须短于 TTL，否则每个 tick 都判陈旧，等于每 10 秒打一次网关——
    // 缓存就等于不存在了。
    //
    // 两者**不要求任何整数倍关系**：TTL 是「多久之后值得再问一次上游」的独立
    // 判断，不是轮询周期的函数。这里只锁住「缓存确实在吸收重复读取」这一个性质。
    const { USAGE_CACHE_TTL_MS } = await import('../src/constants.js')
    expect(USAGE_CACHE_TTL_MS).toBeGreaterThan(USAGE_REFRESH_MS)
    // 一个 TTL 窗口内至少发生若干次轮询，「多次刷新由缓存吸收」才有意义。
    expect(USAGE_CACHE_TTL_MS / USAGE_REFRESH_MS).toBeGreaterThanOrEqual(5)
  })

  it('周期变快不改变每 tick 的调用次数：一个周期一次，不多发', async () => {
    const remote = makeRemote()
    const feed = usageFeed(remote)
    const stop = feed.subscribe(() => {})
    await flush()
    expect(remote.usage).toHaveBeenCalledTimes(1)
    // 连续 5 个周期 = 5 次调用（每个 tick 恰好一次），不会因周期短而叠加。
    await vi.advanceTimersByTimeAsync(USAGE_REFRESH_MS * 5)
    expect(remote.usage).toHaveBeenCalledTimes(6)
    stop()
  })
})
