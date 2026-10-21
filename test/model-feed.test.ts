import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  EMPTY_MODEL_SNAPSHOT,
  MODEL_READ_TIMEOUT_MS,
  MODEL_REFRESH_MS,
  modelFeed,
} from '../src/client/model-feed.js'
import { emitLoginChange } from '../src/client/notifiers.js'
import type { CodeBuddyModelEntry } from '../src/remote-types.js'

const ok = <T,>(value: T): { ok: true; value: T } => ({ ok: true, value })

/** 一条最小可用的目录条目；feed 只做搬运，不解释字段。 */
const entry = (over: Partial<CodeBuddyModelEntry> = {}): CodeBuddyModelEntry => ({
  id: 'hy3',
  name: 'Hy3',
  rate: { base: 'x0.30', current: 'x0.10', strikethrough: true, free: false },
  ...over,
})

/**
 * 每个用例一个 remote 新对象：feed 按 remote 身份缓存，新对象 = 新 feed = 干净状态。
 * 每次调用 `models()` 都返回**新对象、同内容**的条目（`entry()` 每次新造），
 * 这样「快照引用没变」只可能来自实现按内容判等，而不是按引用判等。
 */
function makeRemote(models: () => CodeBuddyModelEntry[] = () => [entry()]): {
  models: ReturnType<typeof vi.fn>
} {
  return { models: vi.fn(async () => ok({ loggedIn: true, models: models() })) }
}

/** 让已排队的微任务跑完（feed 的 read 是 async）。 */
const flush = async (): Promise<void> => { await vi.advanceTimersByTimeAsync(0) }

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('modelFeed（读同一份目录的入口共用的唯一轮询器）', () => {
  it('多个订阅者共用同一次请求', async () => {
    const remote = makeRemote()
    const feed = modelFeed(remote)
    const a = feed.subscribe(() => {})
    const b = feed.subscribe(() => {})
    await flush()
    expect(remote.models).toHaveBeenCalledTimes(1)
    a(); b()
  })

  it('一个周期发一次', async () => {
    const remote = makeRemote()
    const feed = modelFeed(remote)
    const stop = feed.subscribe(() => {})
    await flush()
    expect(remote.models).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(MODEL_REFRESH_MS)
    expect(remote.models).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(MODEL_REFRESH_MS * 3)
    expect(remote.models).toHaveBeenCalledTimes(5)
    stop()
  })

  it('上一轮没回来时单飞跳过（不排队、不叠加）', async () => {
    // 慢网关下排队等着的请求会在恢复后一次性倾泻，而它们读的是同一份目录。
    const pending: Array<(value: unknown) => void> = []
    const remote = {
      models: vi.fn(() => new Promise((resolve) => { pending.push(resolve as (value: unknown) => void) })),
    }
    const feed = modelFeed(remote)
    const stop = feed.subscribe(() => {})
    await flush()
    expect(remote.models).toHaveBeenCalledTimes(1)

    // 首轮挂在途中，外部事件（登录态变化 / 主动 refresh）反复要求重读：
    // 全部被单飞挡掉，只保留第一轮。
    emitLoginChange()
    feed.refresh()
    await flush()
    expect(remote.models).toHaveBeenCalledTimes(1)

    // 首轮超时落空后单飞解除；在 t=31s 再发起一轮并让它继续挂着，这样 t=60s
    // 的 tick 到来时确实有在途读取（离它自己的 30s 超时还有 29s）。
    await vi.advanceTimersByTimeAsync(MODEL_READ_TIMEOUT_MS + 1_000)
    feed.refresh()
    await flush()
    expect(remote.models).toHaveBeenCalledTimes(2)

    // tick 被跳过而不是排队：慢网关不会变成请求堆积。
    await vi.advanceTimersByTimeAsync(MODEL_REFRESH_MS - MODEL_READ_TIMEOUT_MS - 1_000)
    expect(remote.models).toHaveBeenCalledTimes(2)

    // 手动放行在途这一轮：读数落地，之后的重读恢复正常。
    pending[1]?.(ok({ loggedIn: true, models: [entry()] }))
    await flush()
    expect(feed.getSnapshot().models).toHaveLength(1)

    feed.refresh()
    await flush()
    expect(remote.models).toHaveBeenCalledTimes(3)
    stop()
  })

  it('读失败时保留上一份好快照（不把元数据清空）', async () => {
    // 与 usage-feed 刻意相反：用量读失败 = 没有额度可显示，清空是诚实的；
    // 目录读失败 = 暂时拿不到促销，清空会让每一行瞬间退化成裸名字。
    const remote = makeRemote()
    const feed = modelFeed(remote)
    const listener = vi.fn()
    const stop = feed.subscribe(listener)
    await flush()
    const good = feed.getSnapshot()
    expect(good.loggedIn).toBe(true)
    expect(good.models).toHaveLength(1)
    expect(listener).toHaveBeenCalledTimes(1)

    remote.models.mockRejectedValueOnce(new Error('gateway down'))
    await vi.advanceTimersByTimeAsync(MODEL_REFRESH_MS)
    await flush()
    expect(remote.models).toHaveBeenCalledTimes(2)
    // 引用都不换（内容没变），订阅者也不被通知：界面上的徽标原样不动。
    expect(feed.getSnapshot()).toBe(good)
    expect(feed.getSnapshot().models[0]?.rate?.current).toBe('x0.10')
    expect(listener).toHaveBeenCalledTimes(1)

    // 下一轮恢复后照常更新。
    remote.models.mockResolvedValueOnce(ok({ loggedIn: true, models: [entry({ id: 'hy4', name: 'Hy4' })] }))
    await vi.advanceTimersByTimeAsync(MODEL_REFRESH_MS)
    expect(feed.getSnapshot().models[0]?.id).toBe('hy4')
    stop()
  })

  it('登录态变化立即重读', async () => {
    const remote = makeRemote()
    const feed = modelFeed(remote)
    const stop = feed.subscribe(() => {})
    await flush()
    expect(remote.models).toHaveBeenCalledTimes(1)

    emitLoginChange()
    await flush()
    expect(remote.models).toHaveBeenCalledTimes(2)
    stop()
  })

  it('订阅者归零后停表', async () => {
    const remote = makeRemote()
    const feed = modelFeed(remote)
    const stop = feed.subscribe(() => {})
    await flush()
    expect(remote.models).toHaveBeenCalledTimes(1)

    stop()
    await vi.advanceTimersByTimeAsync(MODEL_REFRESH_MS * 3)
    expect(remote.models).toHaveBeenCalledTimes(1)

    // 重新订阅重新起表（并立即读一次，不等一个周期）。
    const again = feed.subscribe(() => {})
    await flush()
    expect(remote.models).toHaveBeenCalledTimes(2)
    again()
  })

  it('最后一个人离开后登录态翻转会作废快照：后来者看不到上一个账号的目录', async () => {
    // 回归：stop 保留快照 + 登录监听随 stop 拆除的话，登出发生在无人订阅时就
    // 无人作废快照，后来者首帧会闪出上一个账号的模型/徽章/倍率（串号）。
    const remote = makeRemote()
    const feed = modelFeed(remote)
    const stop = feed.subscribe(() => {})
    await flush()
    expect(feed.getSnapshot().models).toHaveLength(1)

    stop()
    // 登出/切换账号发生在无人订阅时：常驻监听同步落成空态，不用等下一轮读取。
    emitLoginChange()
    expect(feed.getSnapshot()).toBe(EMPTY_MODEL_SNAPSHOT)

    // 新账号挂载：首帧就是空态；重读落地后是新账号的目录。
    remote.models.mockResolvedValueOnce(ok({ loggedIn: true, models: [entry({ id: 'new9', name: 'New9' })] }))
    const again = feed.subscribe(() => {})
    expect(feed.getSnapshot()).toBe(EMPTY_MODEL_SNAPSHOT)
    await flush()
    expect(feed.getSnapshot().models[0]?.id).toBe('new9')
    again()
  })

  it('同账号重挂时保留上一份好快照（首帧不闪空）', async () => {
    // 上面的作废只发生在登录态翻转时：没有翻转的重挂，首帧仍是旧目录——
    // 这就是 stop 保留快照要保住的那一下。
    const remote = makeRemote()
    const feed = modelFeed(remote)
    const stop = feed.subscribe(() => {})
    await flush()
    const good = feed.getSnapshot()
    expect(good.models).toHaveLength(1)

    stop()
    const again = feed.subscribe(() => {})
    expect(feed.getSnapshot()).toBe(good)
    await flush()
    again()
  })

  it('快照引用只在内容变化时替换', async () => {
    // useSyncExternalStore 靠引用判等：内容没变却换对象会让每个订阅者白重渲染。
    // remote 每次返回的是新对象（见 makeRemote），所以这里锁的是「按内容判等」。
    const remote = makeRemote()
    const feed = modelFeed(remote)
    const listener = vi.fn()
    const stop = feed.subscribe(listener)
    await flush()
    const first = feed.getSnapshot()
    expect(listener).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(MODEL_REFRESH_MS)
    expect(remote.models).toHaveBeenCalledTimes(2)
    expect(feed.getSnapshot()).toBe(first)
    expect(listener).toHaveBeenCalledTimes(1)

    // 内容真的变了（多了一条促销）才换引用并通知。
    remote.models.mockResolvedValueOnce(ok({
      loggedIn: true,
      models: [entry({ promotion: { label: '限时免费', color: '#FF5A1F' } })],
    }))
    await vi.advanceTimersByTimeAsync(MODEL_REFRESH_MS)
    const changed = feed.getSnapshot()
    expect(changed).not.toBe(first)
    expect(changed.models[0]?.promotion?.label).toBe('限时免费')
    expect(listener).toHaveBeenCalledTimes(2)
    stop()
  })

  it('未登录是成功的读数：发布共享空快照，而不是留着上一个账号的目录', async () => {
    const remote = makeRemote()
    const feed = modelFeed(remote)
    const stop = feed.subscribe(() => {})
    await flush()
    expect(feed.getSnapshot().models).toHaveLength(1)

    remote.models.mockResolvedValueOnce(ok({ loggedIn: false, models: [] }))
    await vi.advanceTimersByTimeAsync(MODEL_REFRESH_MS)
    expect(feed.getSnapshot()).toBe(EMPTY_MODEL_SNAPSHOT)
    stop()
  })

  it('已登录但目录为空：发布空列表，而不是退回未登录空态', async () => {
    // 服务端真的没有模型，与「没登录」是两回事：客户端分支不一样。
    const remote = makeRemote(() => [])
    const feed = modelFeed(remote)
    const stop = feed.subscribe(() => {})
    await flush()
    expect(feed.getSnapshot()).toEqual({ loggedIn: true, models: [] })
    expect(feed.getSnapshot()).not.toBe(EMPTY_MODEL_SNAPSHOT)
    stop()
  })

  it('尚未读到目录时是共享空快照，同一个 remote 拿到同一个 feed', () => {
    const remote = makeRemote()
    const feed = modelFeed(remote)
    expect(feed.getSnapshot()).toBe(EMPTY_MODEL_SNAPSHOT)
    expect(modelFeed(remote)).toBe(feed)
  })

  it('外呼超时后解除单飞，下一轮照常重试', async () => {
    // 网关挂住而不是拒绝：没有硬超时，busy 永不解除，轮询就此静默死掉——
    // 界面上的倍率会停在某一刻，看不出已经停止更新。
    const remote = { models: vi.fn(() => new Promise(() => {})) }
    const feed = modelFeed(remote)
    const stop = feed.subscribe(() => {})
    await flush()
    expect(remote.models).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(MODEL_READ_TIMEOUT_MS)
    // 还没有好快照可保留：仍是共享空态。
    expect(feed.getSnapshot()).toBe(EMPTY_MODEL_SNAPSHOT)

    await vi.advanceTimersByTimeAsync(MODEL_REFRESH_MS)
    expect(remote.models).toHaveBeenCalledTimes(2)
    stop()
  })
})

describe('轮询周期', () => {
  it('客户端每 60 秒问一次宿主', () => {
    // 60 秒是「徽标对促销时间窗边界（23:00 / 08:00）的滞后上限」这一约定的
    // 唯一出处；改大改小都必须同时改这里。
    expect(MODEL_REFRESH_MS).toBe(60_000)
  })

  it('单次读取超时短于轮询周期，否则单飞会让读数停更', () => {
    // 超时若 ≥ 周期，一次卡住的读取会横跨多个 tick，后续每轮都被 busy 挡掉。
    expect(MODEL_READ_TIMEOUT_MS).toBeLessThan(MODEL_REFRESH_MS)
  })
})
