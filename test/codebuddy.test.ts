import { afterEach, describe, expect, it, vi } from 'vitest'
import { getConfig, getLoginAccount, pollAuthToken, refreshAccessToken, requestAuthState } from '../src/codebuddy.js'
import type { CodeBuddyIdentity } from '../src/codebuddy.js'
import { LOGIN_POLL_INTERVAL_MS, LOGIN_TIMEOUT_MS, REQUEST_TIMEOUT_MS } from '../src/constants.js'

const identity: CodeBuddyIdentity = { accessToken: 'acc-token', domain: 'tencent' }

function response(status: number, body: unknown): { ok: boolean; status: number; json: () => Promise<unknown> } {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

interface FetchCall {
  url: string
  init: { method?: string; headers?: Record<string, string>; signal?: unknown }
}

function installFetch(handler: (url: string, init: FetchCall['init']) => unknown) {
  const calls: FetchCall[] = []
  const mock = vi.fn(async (url: string, init: FetchCall['init']) => {
    calls.push({ url, init })
    return handler(url, init)
  })
  vi.stubGlobal('fetch', mock)
  return { mock, calls }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('refreshAccessToken', () => {
  it('returns an AuthToken when the refresh succeeds (200 + code 0)', async () => {
    const token = { accessToken: 'new-acc', expiresIn: 7200, refreshToken: 'new-rt', refreshExpiresIn: 2592000, domain: 'tencent' }
    const { calls } = installFetch(() => response(200, { code: 0, msg: 'ok', requestId: 'r1', data: token }))

    await expect(refreshAccessToken(identity, 'old-rt')).resolves.toEqual({ ok: true, token })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('https://copilot.tencent.com/v2/plugin/auth/token/refresh')
    expect(calls[0]?.init.method).toBe('POST')
    const headers = calls[0]?.init.headers ?? {}
    expect(headers['Authorization']).toBe('Bearer acc-token')
    expect(headers['X-Refresh-Token']).toBe('old-rt')
    expect(headers['X-Domain']).toBe('tencent')
  })

  it('forwards optional uid and enterpriseId headers when present', async () => {
    const token = { accessToken: 'a', expiresIn: 1, refreshToken: 'r', refreshExpiresIn: 2, domain: 'd' }
    const { calls } = installFetch(() => response(200, { code: 0, msg: 'ok', requestId: 'r1', data: token }))

    await refreshAccessToken({ accessToken: 'a', domain: 'd', uid: 'u1', enterpriseId: 'e1' }, 'r')
    const headers = calls[0]?.init.headers ?? {}
    expect(headers['X-User-Id']).toBe('u1')
    expect(headers['X-Enterprise-Id']).toBe('e1')
  })

  it('reports "rejected" when the service refuses the refresh token', async () => {
    // 401/403：token 已花掉或已吊销，这是终态裁决。
    installFetch(() => response(401, { code: 1001, msg: 'unauthorized', requestId: 'r1' }))
    await expect(refreshAccessToken(identity, 'rt')).resolves.toEqual({ ok: false, reason: 'rejected' })
  })

  it('reports "rejected" when a 200 envelope carries a non-zero code', async () => {
    installFetch(() => response(200, { code: 1001, msg: 'expired', requestId: 'r1', data: undefined }))
    await expect(refreshAccessToken(identity, 'rt')).resolves.toEqual({ ok: false, reason: 'rejected' })
  })

  it('reports "unreachable" when fetch rejects (network failure)', async () => {
    // 没拿到裁决，凭据不背锅——不能叫用户重新登录。
    installFetch(() => Promise.reject(new Error('network down')))
    await expect(refreshAccessToken(identity, 'rt')).resolves.toEqual({ ok: false, reason: 'unreachable' })
  })

  it('reports "unreachable" for server-side and rate-limited statuses', async () => {
    for (const status of [408, 429, 500, 503]) {
      installFetch(() => response(status, { code: 0, msg: 'retry me', requestId: 'r1' }))
      await expect(refreshAccessToken(identity, 'rt')).resolves.toEqual({ ok: false, reason: 'unreachable' })
    }
  })

  it('reports "unreachable" when a 200 body cannot be parsed', async () => {
    installFetch(() => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => { throw new Error('truncated json') },
    } as unknown as Response))
    await expect(refreshAccessToken(identity, 'rt')).resolves.toEqual({ ok: false, reason: 'unreachable' })
  })
})

describe('getConfig', () => {
  it('carries the HTTP status on ConfigRequestError so callers can spot a refusal', async () => {
    const { ConfigRequestError } = await import('../src/codebuddy.js')
    installFetch(() => ({
      ok: false,
      status: 401,
      headers: new Headers(),
      json: async () => ({ code: 1001, msg: 'forbidden', requestId: 'r1' }),
    } as unknown as Response))
    const error = await getConfig(identity).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ConfigRequestError)
    expect((error as { status?: number }).status).toBe(401)
  })

  it('leaves the status undefined when no HTTP verdict was reached', async () => {
    const { ConfigRequestError } = await import('../src/codebuddy.js')
    installFetch(() => Promise.reject(new Error('socket hang up')))
    const error = await getConfig(identity).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ConfigRequestError)
    expect((error as { status?: number }).status).toBeUndefined()
  })

  it('returns models when the catalog request succeeds (200 + code 0)', async () => {
    const config = { models: [{ id: 'm1', name: 'Model One' }] }
    const { calls } = installFetch(() => response(200, { code: 0, msg: 'ok', requestId: 'r1', data: config }))

    await expect(getConfig(identity)).resolves.toEqual(config)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('https://copilot.tencent.com/v3/config')
    expect(calls[0]?.init.method).toBe('GET')
    const headers = calls[0]?.init.headers ?? {}
    expect(headers['Authorization']).toBe('Bearer acc-token')
    expect(headers['X-Domain']).toBe('tencent')
    expect(headers['User-Agent']).toContain('CodeBuddy')
  })

  it('forwards an AbortSignal when provided (combined with the deadline)', async () => {
    const config = { models: [] }
    const controller = new AbortController()
    const { calls } = installFetch(() => response(200, { code: 0, msg: 'ok', requestId: 'r1', data: config }))

    await getConfig(identity, controller.signal)
    expect(calls[0]?.init.signal).toBeDefined()
    expect(calls[0]?.init.signal).not.toBe(controller.signal) // 合成 signal（caller + 死线）
  })

  it('throws an Error containing the code and msg when the body code is not 0', async () => {
    installFetch(() => response(200, { code: 403, msg: 'forbidden', requestId: 'r1', data: undefined }))
    await expect(getConfig(identity)).rejects.toThrow(/403.*forbidden/)
  })

  it('throws an Error on a non-200 response', async () => {
    installFetch(() => response(503, { code: 0, msg: 'ok', requestId: 'r1' }))
    await expect(getConfig(identity)).rejects.toThrow(/503/)
  })
})

describe('login handshake', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('requestAuthState posts to auth/state and returns state+authUrl', async () => {
    const { calls } = installFetch(() => response(200, { code: 0, msg: 'ok', requestId: 'r1', data: { state: 's1', authUrl: 'https://x/login' } }))

    await expect(requestAuthState()).resolves.toEqual({ state: 's1', authUrl: 'https://x/login' })
    expect(calls).toHaveLength(1)
    // platform=CLI：ide 会让登录成功页自动跳 codebuddy:// 深链，浏览器登录流程被打断；
    // CLI 停留在浏览器页面（见 codebuddy.ts 注释）。回归锁。
    expect(calls[0]?.url).toBe('https://copilot.tencent.com/v2/plugin/auth/state?platform=CLI')
    expect(calls[0]?.init.method).toBe('POST')
    const headers = calls[0]?.init.headers ?? {}
    expect(headers['X-No-Authorization']).toBe('true')
    expect(headers['X-No-User-Id']).toBe('true')
    expect(headers['X-No-Enterprise-Id']).toBe('true')
  })

  it('refreshAccessToken carries X-Auth-Refresh-Source: workbuddy', async () => {
    const token = { accessToken: 'new-acc', expiresIn: 7200, refreshToken: 'new-rt', refreshExpiresIn: 2592000, domain: 'tencent' }
    const { calls } = installFetch(() => response(200, { code: 0, msg: 'ok', requestId: 'r1', data: token }))

    await refreshAccessToken(identity, 'old-rt')
    const headers = calls[0]?.init.headers ?? {}
    expect(headers['X-Auth-Refresh-Source']).toBe('workbuddy')
  })

  it('pollAuthToken polls while the code is AUTH_PENDING and resolves with the token on code 0', async () => {
    vi.useFakeTimers()
    const token = { accessToken: 'acc', expiresIn: 7200, refreshToken: 'rt', refreshExpiresIn: 2592000, domain: 'tencent' }
    let fetches = 0
    installFetch(() => {
      fetches += 1
      if (fetches < 3) return response(200, { code: 11217, msg: 'pending', requestId: 'r1', data: undefined })
      return response(200, { code: 0, msg: 'ok', requestId: 'r1', data: token })
    })

    const pending = pollAuthToken('st1')
    await vi.advanceTimersByTimeAsync(LOGIN_POLL_INTERVAL_MS)
    await vi.advanceTimersByTimeAsync(LOGIN_POLL_INTERVAL_MS)
    await vi.advanceTimersByTimeAsync(LOGIN_POLL_INTERVAL_MS)
    await expect(pending).resolves.toEqual(token)
    expect(fetches).toBe(3)
  })

  it('pollAuthToken returns undefined when the body code is neither 0 nor AUTH_PENDING', async () => {
    vi.useFakeTimers()
    installFetch(() => response(200, { code: 1001, msg: 'expired', requestId: 'r1', data: undefined }))

    const pending = pollAuthToken('st1')
    await vi.advanceTimersByTimeAsync(LOGIN_POLL_INTERVAL_MS)
    await expect(pending).resolves.toBeUndefined()
  })

  it('pollAuthToken keeps polling when one round times out at the per-round deadline', async () => {
    // 回归：每轮 poll 曾带 15s 硬死线，且单轮超时被 catch 成 return undefined——
    // 登录网关慢一次，整个轮询流程就提前终止。单轮失败应 continue，整体由 LOGIN_TIMEOUT_MS 控制。
    vi.useFakeTimers()
    try {
      const token = { accessToken: 'acc', expiresIn: 7200, refreshToken: 'rt', refreshExpiresIn: 2592000, domain: 'tencent' }
      let fetches = 0
      installFetch((_url: string, init: FetchCall['init']) => {
        fetches += 1
        if (fetches === 1) {
          // 第一轮：尊重传入 signal，等到 15s 单轮死线 abort 才拒绝（真实 fetch 行为）。
          const signal = init.signal as AbortSignal
          return new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('round deadline elapsed')), { once: true })
          })
        }
        return response(200, { code: 0, msg: 'ok', requestId: 'r1', data: token })
      })

      const pending = pollAuthToken('st1')
      await vi.advanceTimersByTimeAsync(LOGIN_POLL_INTERVAL_MS) // 第一轮发出并挂起
      await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS) // 第一轮死线触发 → 应 continue
      await vi.advanceTimersByTimeAsync(LOGIN_POLL_INTERVAL_MS) // 第二轮发出并成功
      await expect(pending).resolves.toEqual(token)
      expect(fetches).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('pollAuthToken gives up at the overall login deadline even when every single round is fine', async () => {
    // 单轮失败不再终止流程，但整体 10 分钟上限仍是最终兜底。
    vi.useFakeTimers()
    try {
      installFetch(() => response(200, { code: 11217, msg: 'pending', requestId: 'r1', data: undefined }))

      const pending = pollAuthToken('st1')
      await vi.advanceTimersByTimeAsync(LOGIN_TIMEOUT_MS + LOGIN_POLL_INTERVAL_MS)
      await expect(pending).resolves.toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('getLoginAccount returns a normalized Account (empty optional strings omitted)', async () => {
    const { calls } = installFetch(() => response(200, {
      code: 0, msg: 'ok', requestId: 'r1', data: {
        uid: 'u1', nickname: 'nick', uin: '', enterpriseId: '', enterpriseName: 'Tencent',
        enterpriseUserName: '', departmentFullName: 'Engineering',
      },
    }))

    await expect(getLoginAccount('a/b', 'acc-token', 'tencent')).resolves.toStrictEqual({
      uid: 'u1', nickname: 'nick', enterpriseName: 'Tencent', departmentFullName: 'Engineering',
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('https://copilot.tencent.com/v2/plugin/login/account?state=a%2Fb')
    expect(calls[0]?.init.method).toBe('GET')
    const headers = calls[0]?.init.headers ?? {}
    expect(headers['Authorization']).toBe('Bearer acc-token')
    expect(headers['X-Domain']).toBe('tencent')
    expect(headers['X-No-User-Id']).toBe('true')
    expect(headers['X-No-Enterprise-Id']).toBe('true')
  })

  it('throws an Error containing the code and msg when the login account body code is not 0', async () => {
    installFetch(() => response(200, { code: 403, msg: 'forbidden', requestId: 'r1', data: undefined }))
    await expect(getLoginAccount('st1', 'acc', 'tencent')).rejects.toThrow(/403.*forbidden/)
  })
})
