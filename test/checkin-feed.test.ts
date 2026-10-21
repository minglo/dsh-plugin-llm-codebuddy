import { describe, expect, it, vi } from 'vitest'
import { checkinFeed } from '../src/client/checkin-feed.js'
import type { CheckinResultView, CheckinStatusView } from '../src/remote-types.js'

function ok<T>(value: T): { ok: true; value: T } {
  return { ok: true, value }
}
function fail(message: string): { ok: false; error: { message: string } } {
  return { ok: false, error: { message } }
}

interface Stub {
  checkinStatus: () => Promise<ReturnType<typeof ok<CheckinStatusView>> | ReturnType<typeof fail>>
  checkin: () => Promise<ReturnType<typeof ok<CheckinResultView>> | ReturnType<typeof fail>>
  statusCalls: number
  checkinCalls: number
}

function stubRemote(overrides: {
  status?: () => Promise<CheckinStatusView>
  checkin?: () => Promise<CheckinResultView>
} = {}): Stub {
  const state: Stub = {
    statusCalls: 0,
    checkinCalls: 0,
    checkinStatus: async () => {
      state.statusCalls += 1
      const view = await (overrides.status?.() ?? Promise.resolve({
        available: true, active: true, checkedIn: false, streakDays: 0, dailyCredit: 50, todayCredit: 0,
      }))
      return ok(view)
    },
    checkin: async () => {
      state.checkinCalls += 1
      const view = await (overrides.checkin?.() ?? Promise.resolve({ success: true, credit: 50, streakDays: 1 }))
      return ok(view)
    },
  }
  return state
}

const NOT_CHECKED_IN: CheckinStatusView = {
  available: true, active: true, checkedIn: false, streakDays: 0, dailyCredit: 50, todayCredit: 0,
}
const CHECKED_IN: CheckinStatusView = {
  available: true, active: true, checkedIn: true, streakDays: 3, dailyCredit: 50, todayCredit: 50,
}

describe('客户端签到 feed', () => {
  it('首个订阅者进来时读一次签到态', async () => {
    const remote = stubRemote()
    const feed = checkinFeed(remote)
    const unsubscribe = feed.subscribe(() => {})
    await vi.waitFor(() => { expect(remote.statusCalls).toBe(1) })
    expect(feed.getSnapshot().checkedIn).toBe(false)
    unsubscribe()
  })

  it('签到成功后状态变成已签到（读数是权威判据）', async () => {
    let checked = false
    const remote = stubRemote({
      status: async () => (checked ? CHECKED_IN : NOT_CHECKED_IN),
      checkin: async () => {
        checked = true
        return { success: true, credit: 50, streakDays: 1 }
      },
    })
    const feed = checkinFeed(remote)
    feed.subscribe(() => {})
    await vi.waitFor(() => { expect(feed.getSnapshot().available).toBe(true) })
    const result = await feed.checkin()
    expect(result.ok).toBe(true)
    expect(feed.getSnapshot().checkedIn).toBe(true)
  })

  it('服务端说失败、但状态说已签到时按成功算（多半是别处已签过）', async () => {
    // 这条是「失败才提示」的关键：不能因为服务端回一句「今日已签到」就弹失败。
    let checked = false
    const remote = stubRemote({
      status: async () => (checked ? CHECKED_IN : NOT_CHECKED_IN),
      checkin: async () => {
        checked = true
        return { success: false, message: '今日已签到', credit: 0, streakDays: 3 }
      },
    })
    const feed = checkinFeed(remote)
    feed.subscribe(() => {})
    await vi.waitFor(() => { expect(feed.getSnapshot().available).toBe(true) })
    const result = await feed.checkin()
    expect(result.ok).toBe(true)
    expect(feed.getSnapshot().checkedIn).toBe(true)
  })

  it('真的失败时状态仍是未签到，且带服务端的原因', async () => {
    const remote = stubRemote({
      checkin: async () => ({ success: false, message: '活动未开启', credit: 0, streakDays: 0 }),
    })
    const feed = checkinFeed(remote)
    feed.subscribe(() => {})
    await vi.waitFor(() => { expect(feed.getSnapshot().available).toBe(true) })
    const result = await feed.checkin()
    expect(result.ok).toBe(false)
    expect(result.message).toBe('活动未开启')
    expect(feed.getSnapshot().checkedIn).toBe(false)
  })

  it('网络错误不给 message（内部细节不该原样上屏）', async () => {
    const remote = stubRemote()
    remote.checkin = async () => fail('network down')
    const feed = checkinFeed(remote)
    feed.subscribe(() => {})
    await vi.waitFor(() => { expect(feed.getSnapshot().available).toBe(true) })
    const result = await feed.checkin()
    expect(result.ok).toBe(false)
    expect(result.message).toBeUndefined()
  })

  it('请求在飞时 pending 为真：防双击发出两次写请求', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>(resolve => { release = resolve })
    const remote = stubRemote({
      checkin: async () => {
        await gate
        return { success: true, credit: 50, streakDays: 1 }
      },
    })
    const feed = checkinFeed(remote)
    feed.subscribe(() => {})
    await vi.waitFor(() => { expect(feed.getSnapshot().available).toBe(true) })
    const first = feed.checkin()
    await vi.waitFor(() => { expect(feed.getSnapshot().pending).toBe(true) })
    // 在飞时再点一次：不发第二次请求。
    const second = await feed.checkin()
    expect(second.ok).toBe(false)
    expect(remote.checkinCalls).toBe(1)
    release?.()
    expect((await first).ok).toBe(true)
  })

  it('读不到状态时 available 为假（宁可不给入口）', async () => {
    const remote = stubRemote()
    let attempts = 0
    remote.checkinStatus = async () => {
      attempts += 1
      return fail('nope')
    }
    const feed = checkinFeed(remote)
    feed.subscribe(() => {})
    await vi.waitFor(() => { expect(attempts).toBe(1) })
    expect(feed.getSnapshot().available).toBe(false)
  })

  it('活动没开时状态照样读得到（active 为假，与 available 分开）', async () => {
    const remote = stubRemote({
      status: async () => ({ ...NOT_CHECKED_IN, active: false }),
    })
    const feed = checkinFeed(remote)
    feed.subscribe(() => {})
    await vi.waitFor(() => { expect(feed.getSnapshot().available).toBe(true) })
    expect(feed.getSnapshot().active).toBe(false)
  })
})
