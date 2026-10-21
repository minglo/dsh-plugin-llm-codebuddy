import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchUsage, UsageAuthExpiredError } from '../src/usage.js'
import type { CodeBuddyIdentity } from '../src/codebuddy.js'
import { CODEBUDDY_IDE_USER_AGENT } from '../src/constants.js'

const identity: CodeBuddyIdentity = { accessToken: 'acc', domain: 'tencent', uid: 'u1' }

function page(accounts: unknown[], full = true): { data: { Response: { Data: { Accounts: unknown[] } } } } {
  const list = accounts.slice(0, 100)
  if (full) while (list.length < 100) list.push({ PackageName: 'fill', CycleEndTime: '2026-12-31 23:59:59', CycleCapacityRemainPrecise: 1 })
  return { data: { Response: { Data: { Accounts: list } } } }
}

function response(status: number, body: unknown): { ok: boolean; status: number; json: () => Promise<unknown> } {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

function emptyPageFull(): unknown {
  return page([], true)
}

interface FetchCall {
  url: string
  init: { method?: string; headers?: Record<string, string>; body?: string }
}

function installFetch(handler: (url: string, init: FetchCall['init']) => unknown): FetchCall[] {
  const calls: FetchCall[] = []
  const mock = vi.fn(async (url: string, init: FetchCall['init']) => {
    calls.push({ url, init })
    return handler(url, init)
  })
  vi.stubGlobal('fetch', mock)
  return calls
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('fetchUsage', () => {
  it('posts to the codebuddy.cn usage endpoint with UA, Bearer, and X-User-Id headers', async () => {
    const calls = installFetch(() => response(200, page([{ PackageName: 'a', CycleEndTime: '2026-08-31 23:59:59', CycleCapacityRemainPrecise: 10 }], false)))

    await fetchUsage(identity)

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('https://www.codebuddy.cn/v2/billing/meter/get-user-resource')
    expect(calls[0]?.init.method).toBe('POST')
    const headers = calls[0]?.init.headers ?? {}
    expect(headers['User-Agent']).toBe(CODEBUDDY_IDE_USER_AGENT)
    expect(headers['Authorization']).toBe('Bearer acc')
    expect(headers['X-User-Id']).toBe('u1')
    expect(headers['X-Enterprise-Id']).toBeUndefined()
  })

  it('即便身份里有 enterpriseId 也不发 X-Enterprise-Id（本调用点是刻意的例外）', async () => {
    // 上面那条用的 identity 根本没有 enterpriseId，所以它的 toBeUndefined 只能证明
    // 「本来就没有」，无法发现 withIdentityHeaders 的 withEnterpriseId:false 被去掉
    // （实测：去掉后上面那条照样绿）。这里给一个**确实带** enterpriseId 的身份，
    // 才能真正锁住「fetchUsage 刻意不带企业头」这个行为。
    const calls = installFetch(() => response(200, page([], false)))
    await fetchUsage({ accessToken: 'acc', domain: 'tencent', uid: 'u1', enterpriseId: 'ent-9' })
    const headers = calls[0]?.init.headers ?? {}
    expect(headers['X-User-Id']).toBe('u1') // 用户头照常
    expect(headers['X-Enterprise-Id']).toBeUndefined() // 企业头被刻意省略
  })

  it('omits X-User-Id when the identity has no uid', async () => {
    const calls = installFetch(() => response(200, page([], false)))

    await fetchUsage({ accessToken: 'acc', domain: 'tencent' })

    const headers = calls[0]?.init.headers ?? {}
    expect(headers['X-User-Id']).toBeUndefined()
  })

  it('sends PageSize 100 and body fields on every page', async () => {
    const calls = installFetch(() => response(200, page([], false)))

    await fetchUsage(identity)

    const body = JSON.parse(calls[0]?.init.body ?? '{}') as { PageNumber: number; PageSize: number; ProductCode: string; Status: number[] }
    expect(body.PageNumber).toBe(1)
    expect(body.PageSize).toBe(100)
    expect(body.ProductCode).toBe('p_tcaca')
    expect(body.Status).toEqual([0, 3])
  })

  it('sends PackageEndTimeRangeBegin as the Asia/Shanghai wall time', async () => {
    const calls = installFetch(() => response(200, page([], false)))
    // 固定 UTC 时刻：上海墙钟 = UTC+8。
    vi.setSystemTime(new Date('2026-08-15T18:30:00Z'))

    await fetchUsage(identity)

    const body = JSON.parse(calls[0]?.init.body ?? '{}') as { PackageEndTimeRangeBegin: string; PackageEndTimeRangeEnd: string }
    expect(body.PackageEndTimeRangeBegin).toBe('2026-08-16 02:30:00') // +08 墙上时间
    expect(body.PackageEndTimeRangeEnd).toBe('2126-12-31 23:59:59')
  })

  it('rejects UsageAuthExpiredError on 401', async () => {
    installFetch(() => response(401, { code: 401 }))
    await expect(fetchUsage(identity)).rejects.toBeInstanceOf(UsageAuthExpiredError)
  })

  it('rejects UsageAuthExpiredError on 403', async () => {
    installFetch(() => response(403, { code: 403 }))
    await expect(fetchUsage(identity)).rejects.toBeInstanceOf(UsageAuthExpiredError)
  })

  it('resolves undefined on a non-zero code', async () => {
    installFetch(() => response(200, { code: 1001, msg: 'boom' }))
    await expect(fetchUsage(identity)).resolves.toBeUndefined()
  })

  it('resolves undefined on a network error', async () => {
    installFetch(() => { throw new Error('network down') })
    await expect(fetchUsage(identity)).resolves.toBeUndefined()
  })

  it('aborts a hung fetch after the hard timeout and resolves undefined', async () => {
    // 回归防护：10s 硬超时（AbortController + setTimeout abort）改坏不会红。
    vi.useFakeTimers()
    try {
      installFetch((_url: string, init: FetchCall['init']) => {
        const signal = init.signal as AbortSignal
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        })
      })
      const pending = fetchUsage(identity)
      await vi.advanceTimersByTimeAsync(10_000)
      await expect(pending).resolves.toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('aborts when the caller signal aborts mid-request', async () => {
    const controller = new AbortController()
    const received: AbortSignal[] = []
    const mock = vi.fn((_url: string, init: FetchCall['init']) => {
      const signal = init.signal as AbortSignal
      received.push(signal)
      // 尊重传入 signal：abort 时拒绝，模拟真实 fetch 行为。
      return new Promise((_resolve, reject) => {
        if (signal.aborted) { reject(new Error('aborted')); return }
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
    })
    vi.stubGlobal('fetch', mock)

    const pending = fetchUsage(identity, controller.signal)
    await vi.waitFor(() => expect(received).toHaveLength(1))
    controller.abort()
    await expect(pending).resolves.toBeUndefined()
    expect(received[0]?.aborted).toBe(true)
  })

  it('keeps the body read under timeout protection when the response hangs after headers', async () => {
    // 服务端「秒回 header、悬挂 body」：json() 阶段同样要有超时兜底。
    vi.useFakeTimers()
    try {
      installFetch((_url: string, init: FetchCall['init']) => ({
        ok: true,
        status: 200,
        json: () => new Promise((_resolve, reject) => {
          const signal = init.signal as AbortSignal
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        }),
      }))
      const pending = fetchUsage(identity)
      await vi.advanceTimersByTimeAsync(10_000)
      await expect(pending).resolves.toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('follows a second full page then stops at a short page', async () => {
    const accounts = Array.from({ length: 100 }, (_, i) => ({ PackageName: `p${i}`, CycleEndTime: '2026-12-31 23:59:59', CycleCapacityRemainPrecise: 1 }))
    const calls: FetchCall[] = []
    let pageNumber = 0
    const mock = vi.fn(async (_url: string, init: FetchCall['init']) => {
      calls.push({ url: _url, init })
      pageNumber++
      if (pageNumber === 1) return response(200, page(accounts))
      return response(200, page([{ PackageName: 'last', CycleEndTime: '2026-12-31 23:59:59', CycleCapacityRemainPrecise: 2 }], false))
    })
    vi.stubGlobal('fetch', mock)

    const view = await fetchUsage(identity)

    expect(calls).toHaveLength(2)
    expect(JSON.parse(calls[1]?.init.body ?? '{}').PageNumber).toBe(2)
    expect(view?.totalBalance).toBe(102)
    expect(view?.details).toHaveLength(101)
  })

  it('does not exceed the 50-page defensive cap when every page stays full', async () => {
    // 每页账户各不相同（指纹每页变化）但恒满：只有 50 页防御上限能拦下。
    let pages = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      pages++
      const accounts = Array.from({ length: 100 }, (_, i) => ({ AccountId: 40000000 + pages * 100 + i, PackageName: `p${pages}-${i}`, CycleEndTime: '2026-12-31 23:59:59', CycleCapacityRemainPrecise: 1 }))
      return response(200, page(accounts))
    }))

    await expect(fetchUsage(identity)).resolves.toBeUndefined()

    expect(pages).toBe(50)
  })

  it('stops after a repeated full page instead of running to the cap (CodeBuddy pagination regression)', async () => {
    // 服务端回归实测：忽略 PageNumber/PageSize，每页恒定返回同一批账户。旧实现按
    // 「页满则续拉」一路拉到 50 页上限才放弃（数分钟挂起 → 设置页永远「加载中」）。
    // 新实现：连续两页指纹相同即视为已拿全，去重后返回。
    const accounts = Array.from({ length: 100 }, (_, i) => ({ AccountId: `acc-${i}`, PackageName: `p${i}`, CycleEndTime: '2026-12-31 23:59:59', CycleCapacityRemainPrecise: 1 }))
    const calls: FetchCall[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: FetchCall['init']) => {
      calls.push({ url: _url, init })
      return response(200, page(accounts))
    }))

    const view = await fetchUsage(identity)

    // 第 1 页满 → 续拉第 2 页 → 指纹相同 → 停止：共 2 次请求。
    expect(calls).toHaveLength(2)
    expect(JSON.parse(calls[1]?.init.body ?? '{}').PageNumber).toBe(2)
    // 去重后只有一页的 100 条，不因重复页翻倍。
    expect(view?.details).toHaveLength(100)
    expect(view?.totalBalance).toBe(100)
  })

  it('dedupes by AccountId even when the gateway returns numeric AccountIds', async () => {
    // 回显场景下账户仅有数字 AccountId 而无 DealName 等 fallback 字段时，
    // 指纹必须仍以账户为单位判重（数字 id 归一为字符串参与指纹）。
    const accounts = Array.from({ length: 100 }, (_, i) => ({ AccountId: 40000000 + i, CycleEndTime: '2026-12-31 23:59:59', CycleCapacityRemainPrecise: 1 }))
    vi.stubGlobal('fetch', vi.fn(async () => response(200, page(accounts))))

    const view = await fetchUsage(identity)

    expect(view?.details).toHaveLength(100)
    expect(view?.totalBalance).toBe(100)
  })

  it('runs to the cap when echoed pages reorder accounts (order-sensitive fingerprint)', async () => {
    // 当前实现用整页顺序串比较指纹：同一批账户若每页内部次序不同，两页指纹永不相等，
    // 只能靠 50 页防御上限兜底（仍返回 undefined，不会挂起设置页——但比理论上限多拉请求）。
    let pages = 0
    const accounts = Array.from({ length: 100 }, (_, i) => ({ AccountId: 40000000 + i, CycleEndTime: '2026-12-31 23:59:59', CycleCapacityRemainPrecise: 1 }))
    vi.stubGlobal('fetch', vi.fn(async () => {
      pages++
      const shuffled = pages % 2 === 0 ? [...accounts].reverse() : accounts
      return response(200, page(shuffled))
    }))

    await expect(fetchUsage(identity)).resolves.toBeUndefined()

    expect(pages).toBe(50)
  })
})
