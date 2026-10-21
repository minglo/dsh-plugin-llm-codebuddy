import { describe, expect, it, vi } from 'vitest'
import { UsageCache, usageCacheKey } from '../src/usage-cache.js'
import type { UsageView } from '../src/usage.js'

const view = (totalBalance: number): UsageView => ({ totalBalance } as UsageView)

/** 可控时钟。 */
function clock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let t = start
  return { now: () => t, advance: (ms: number) => { t += ms } }
}

describe('usageCacheKey', () => {
  it('keys on account identity, not the rotating token', () => {
    // token 会随刷新轮换：拿它当键会让每次正常刷新都判定成「换了账号」，缓存永不命中。
    const base = { accessToken: 'a', domain: 'tencent', uid: 'u-1', enterpriseId: 'e-1' }
    expect(usageCacheKey(base)).toBe(usageCacheKey({ ...base, accessToken: 'rotated' }))
  })

  it('separates different accounts and enterprises', () => {
    const base = { accessToken: 'a', domain: 'tencent', uid: 'u-1', enterpriseId: 'e-1' }
    expect(usageCacheKey(base)).not.toBe(usageCacheKey({ ...base, uid: 'u-2' }))
    expect(usageCacheKey(base)).not.toBe(usageCacheKey({ ...base, enterpriseId: 'e-2' }))
  })
})

describe('UsageCache（宿主侧额度缓存）', () => {
  it('serves a fresh entry without any outbound call', async () => {
    const c = clock()
    const load = vi.fn(async () => view(1))
    const cache = new UsageCache({ ttlMs: 60_000, now: c.now })

    await cache.read('k', load)
    const second = await cache.read('k', load)
    expect(second.view).toEqual(view(1))
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('returns the stale value immediately and revalidates in the background', async () => {
    // 这是「指标要等一下才出来」的正面修法：陈旧时立刻给旧值，不阻塞调用方。
    const c = clock()
    let current = view(1)
    const load = vi.fn(async () => current)
    const cache = new UsageCache({ ttlMs: 60_000, now: c.now })

    await cache.read('k', load)
    c.advance(60_001)
    current = view(2)

    const stale = await cache.read('k', load)
    expect(stale.view).toEqual(view(1))   // 立刻拿到上一份读数
    expect(stale.refreshing).toBe(true)
    expect(stale.at).toBe(0)              // 时刻如实反映数据有多旧
    await vi.waitFor(() => { expect(load).toHaveBeenCalledTimes(2) })
  })

  it('waits only on a cold cache (no previous value exists)', async () => {
    const c = clock()
    const cache = new UsageCache({ ttlMs: 60_000, now: c.now })
    const first = await cache.read('k', async () => view(7))
    expect(first.view).toEqual(view(7))
    expect(first.refreshing).toBe(false)
  })

  it('single-flights concurrent reads of the same account', async () => {
    const c = clock()
    const load = vi.fn(async () => view(1))
    const cache = new UsageCache({ ttlMs: 60_000, now: c.now })
    await Promise.all([cache.read('k', load), cache.read('k', load), cache.read('k', load)])
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('does not serve one account the previous account\'s allowance', async () => {
    // 换账号（重新登录、换企业）必须让旧读数失效。
    const c = clock()
    const cache = new UsageCache({ ttlMs: 60_000, now: c.now })
    await cache.read('account-a', async () => view(1))
    const other = await cache.read('account-b', async () => view(2))
    expect(other.view).toEqual(view(2))
  })

  it('clear() drops the cached allowance (called on logout)', async () => {
    const c = clock()
    const load = vi.fn(async () => view(1))
    const cache = new UsageCache({ ttlMs: 60_000, now: c.now })
    await cache.read('k', load)
    cache.clear()
    await cache.read('k', load)
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('keeps the previous good value when a refresh fails', async () => {
    // 一次失败不该把已有的好数据丢掉：下一次读取仍给旧值，并继续重试。
    const c = clock()
    const load = vi.fn(async () => view(1))
    const cache = new UsageCache({ ttlMs: 60_000, now: c.now })
    await cache.read('k', load)
    c.advance(60_001)

    load.mockRejectedValueOnce(new Error('gateway down'))
    const stale = await cache.read('k', load)
    expect(stale.view).toEqual(view(1))
    await vi.waitFor(() => { expect(load).toHaveBeenCalledTimes(2) })

    // 之后仍能用缓存里的旧值，并在下一次读时再试。
    const again = await cache.read('k', load)
    expect(again.view).toEqual(view(1))
  })

  it('treats "unreadable" (undefined) as a normal result and keeps the previous value', async () => {
    const c = clock()
    const load = vi.fn(async () => view(1))
    const cache = new UsageCache({ ttlMs: 60_000, now: c.now })
    await cache.read('k', load)
    c.advance(60_001)

    load.mockResolvedValueOnce(undefined)
    const stale = await cache.read('k', load)
    expect(stale.view).toEqual(view(1))
    await vi.waitFor(() => { expect(load).toHaveBeenCalledTimes(2) })

    // 冷缓存下 undefined 才表现为「无数据」。
    const fresh = new UsageCache({ ttlMs: 60_000, now: c.now })
    await expect(fresh.read('k', async () => undefined)).resolves.toEqual({ view: undefined, at: undefined, refreshing: false })
  })
})
