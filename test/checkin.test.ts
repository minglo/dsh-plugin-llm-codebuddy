import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { fetchCheckinStatus, performCheckin } from '../src/checkin.js'
import type { CodeBuddyIdentity } from '../src/codebuddy.js'

const identity: CodeBuddyIdentity = {
  accessToken: 'tok',
  domain: 'd',
  uid: 'u',
  enterpriseId: 'e',
}

interface Call { url: string; init: RequestInit }

function mockFetch(responses: Array<{ status?: number; body: unknown }>): { calls: Call[] } {
  const calls: Call[] = []
  let index = 0
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    calls.push({ url, init })
    const response = responses[Math.min(index, responses.length - 1)] ?? { body: { code: 0, data: {} } }
    index += 1
    return Promise.resolve({
      status: response.status ?? 200,
      ok: (response.status ?? 200) >= 200 && (response.status ?? 200) < 300,
      json: () => Promise.resolve(response.body),
    })
  })
  return { calls }
}

beforeEach(() => { vi.unstubAllGlobals() })
afterEach(() => { vi.unstubAllGlobals() })

describe('宿主侧签到客户端', () => {
  it('状态：认下划线与驼峰两种字段名', async () => {
    mockFetch([{ body: { code: 0, data: { active: true, today_checked_in: true, streak_days: 5, daily_credit: 50, today_credit: 20 } } }])
    const status = await fetchCheckinStatus(identity)
    expect(status).toEqual({ active: true, checkedIn: true, streakDays: 5, dailyCredit: 50, todayCredit: 20 })
  })

  it('状态：驼峰写法同样认', async () => {
    mockFetch([{ body: { code: 0, data: { Active: true, todayCheckedIn: false, streakDays: 2, dailyCredit: 30 } } }])
    const status = await fetchCheckinStatus(identity)
    expect(status).toEqual({ active: true, checkedIn: false, streakDays: 2, dailyCredit: 30, todayCredit: 0 })
  })

  it('状态：第一个端点失败时回退到第二个', async () => {
    const { calls } = mockFetch([
      { status: 500, body: { code: 500, msg: 'boom' } },
      { body: { code: 0, data: { today_checked_in: true } } },
    ])
    const status = await fetchCheckinStatus(identity)
    expect(status?.checkedIn).toBe(true)
    expect(calls).toHaveLength(2)
    expect(calls[0]?.url).toContain('/v2/billing/meter/checkin-activity-status')
    expect(calls[1]?.url).toContain('/v2/billing/meter/checkin-status')
  })

  it('状态：两个端点都读不到时返回 undefined（读不到 ≠ 活动没开）', async () => {
    mockFetch([{ status: 500, body: { code: 500 } }])
    expect(await fetchCheckinStatus(identity)).toBeUndefined()
  })

  it('状态：非零 code 视为读不到（HTTP 200 不等于成功）', async () => {
    mockFetch([{ body: { code: 11140, msg: 'request illegal' } }])
    expect(await fetchCheckinStatus(identity)).toBeUndefined()
  })

  it('状态：缺字段时按缺省值填，不抛', async () => {
    mockFetch([{ body: { code: 0, data: {} } }])
    const status = await fetchCheckinStatus(identity)
    // 有 data 就认为活动存在（缺省按开启），显式 false 才算关掉。
    expect(status).toEqual({ active: true, checkedIn: false, streakDays: 0, dailyCredit: 0, todayCredit: 0 })
  })

  it('签到：成功时带回积分与连签天数', async () => {
    mockFetch([{ body: { code: 0, data: { success: true, credit: 50, streak_days: 4 } } }])
    const outcome = await performCheckin(identity)
    expect(outcome).toEqual({ success: true, credit: 50, streakDays: 4 })
  })

  it('签到：code 为 0 但 success 为假时算失败，并带上服务端原因', async () => {
    mockFetch([{ body: { code: 0, data: { success: false, message: '活动未开启' } } }])
    const outcome = await performCheckin(identity)
    expect(outcome.success).toBe(false)
    expect(outcome.message).toBe('活动未开启')
  })

  it('签到：code 非零时算失败，原因取 message/msg', async () => {
    mockFetch([{ body: { code: 10001, msg: '今日已签到' } }])
    const outcome = await performCheckin(identity)
    expect(outcome.success).toBe(false)
    expect(outcome.message).toBe('今日已签到')
  })

  it('签到：401/403 是令牌/网关问题，不当成「活动没开」', async () => {
    mockFetch([{ status: 401, body: {} }])
    const outcome = await performCheckin(identity)
    expect(outcome.success).toBe(false)
    expect(outcome.message).toBe('HTTP 401')
  })

  it('签到：发的是浏览器 UA 与身份头', async () => {
    const { calls } = mockFetch([{ body: { code: 0, data: { success: true } } }])
    await performCheckin(identity)
    const headers = calls[0]?.init.headers as Record<string, string>
    expect(headers['User-Agent']).toContain('Mozilla/5.0')
    expect(headers['Authorization']).toBe('Bearer tok')
    expect(headers['X-User-Id']).toBe('u')
    expect(calls[0]?.url).toContain('/v2/billing/meter/daily-checkin')
    expect(calls[0]?.init.method).toBe('POST')
  })
})
