import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GenerateOptions, LlmModelInfo } from '@deepseek-ai/dsh-llm'
import { CodeBuddyAdapter, failureCode, httpErrorCode } from '../src/adapter.js'
import type { CodeBuddyConnectionOptions } from '../src/adapter.js'
import type { CodeBuddySession } from '../src/session.js'
import { NotLoggedInError } from '../src/session.js'
import { CHANNEL_REJECTION_CODE, REQUEST_TIMEOUT_MS, TRANSIENT_UPSTREAM_CODE } from '../src/constants.js'
import type { CodeBuddyModel } from '../src/types.js'
import type { ChannelBlockRecord } from '../src/remote-types.js'
import { DONE } from '../src/sse.js'

const connection: CodeBuddyConnectionOptions = {
  baseURL: 'https://copilot.tencent.com/v2',
  defaultContextWindow: 128_000,
  defaultMaxTokens: 8_192,
  streamIdleTimeoutMs: 300_000,
}

interface FakeSession {
  authHeaders(): Promise<Record<string, string>>
  models(signal?: AbortSignal): Promise<readonly CodeBuddyModel[]>
  modelsOrEmpty(signal?: AbortSignal): Promise<readonly CodeBuddyModel[]>
}

function fakeSession(overrides: Partial<FakeSession> = {}): CodeBuddySession {
  return {
    authHeaders: overrides.authHeaders ?? (async () => ({ Authorization: 'Bearer t', 'X-Domain': 'd' })),
    models: overrides.models ?? (async () => [] as CodeBuddyModel[]),
    modelsOrEmpty: overrides.modelsOrEmpty ?? (async () => [] as CodeBuddyModel[]),
  } as unknown as CodeBuddySession
}

function adapter(session: CodeBuddySession, options: Partial<CodeBuddyConnectionOptions> = {}): CodeBuddyAdapter {
  return new CodeBuddyAdapter({ session, options: () => ({ ...connection, ...options }) })
}

/** 与 adapter() 同，但可注入「遇到 429 是否等待」开关；缺省即不等。 */
function adapterWithWaitSwitch(session: CodeBuddySession, wait: () => boolean): CodeBuddyAdapter {
  return new CodeBuddyAdapter({ session, options: () => connection, waitOnRateLimit: wait })
}

/** 与 adapter() 同，但可注入语言来源（失败文案按界面语言上报）。 */
function adapterWithLanguage(session: CodeBuddySession, language: () => string | undefined): CodeBuddyAdapter {
  return new CodeBuddyAdapter({ session, options: () => connection, language })
}

function sseBody(lines: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const line of lines) controller.enqueue(enc.encode(line + '\n\n'))
      controller.close()
    },
  })
}

function streamResponse(lines: string[]): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    body: sseBody(lines),
  } as unknown as Response
}

function errorResponse(status: number, body: unknown, headers: Headers = new Headers()): Response {
  // 适配器先整段读文本、再自己 JSON.parse（body 里的重置时刻就在那段文本里），
  // 所以假回复必须像真回复一样给出 text()。
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  return {
    ok: status >= 200 && status < 300,
    status,
    headers,
    text: async () => text,
    json: async () => (typeof body === 'string' ? JSON.parse(body) as unknown : body),
  } as unknown as Response
}

interface FetchCall {
  url: string
  init: { method?: string; headers?: Record<string, string>; body?: string; signal?: unknown }
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

function genOptions(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: 'codebuddy',
    model: 'm1',
    messages: [],
    ...overrides,
  }
}

function collect(iterable: AsyncIterable<unknown>): Promise<unknown[]> {
  return (async () => {
    const out: unknown[] = []
    for await (const value of iterable) out.push(value)
    return out
  })()
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('httpErrorCode', () => {
  it('maps 401 and 403 to AUTH', () => {
    expect(httpErrorCode(401)).toBe('AUTH')
    expect(httpErrorCode(403)).toBe('AUTH')
  })

  it('maps 429 to RATE_LIMIT', () => {
    expect(httpErrorCode(429)).toBe('RATE_LIMIT')
  })

  it('maps 400 with context-window wording to CONTEXT_WINDOW_EXCEEDED', () => {
    expect(httpErrorCode(400, 'request exceeded the model context window')).toBe('CONTEXT_WINDOW_EXCEEDED')
  })

  it('maps 400 without context wording to INVALID_REQUEST', () => {
    expect(httpErrorCode(400, 'malformed body')).toBe('INVALID_REQUEST')
  })

  it('maps 500 and above to SERVER', () => {
    expect(httpErrorCode(500)).toBe('SERVER')
    expect(httpErrorCode(503)).toBe('SERVER')
  })

  it('maps quota wording to QUOTA before the 429 branch', () => {
    expect(httpErrorCode(429, 'insufficient quota')).toBe('QUOTA')
  })
})

describe('upstream business codes', () => {
  it('keeps the two 111xx codes distinct', () => {
    expect(CHANNEL_REJECTION_CODE).toBe(11128)
    expect(TRANSIENT_UPSTREAM_CODE).toBe(11133)
  })
})

describe('resolveModel', () => {
  it('uses the catalog capacity when the model is listed', async () => {
    const session = fakeSession({
      models: async () => [{
        id: 'm1', name: 'Model One',
        maxAllowedSize: 200_000, maxOutputTokens: 16_384, supportsImages: true,
        reasoning: { supportedEfforts: ['low', 'high'], defaultEffort: 'low' },
      }],
    })
    const resolved = await adapter(session).resolveModel('codebuddy', 'm1')
    expect(resolved.context).toEqual({ contextWindow: 200_000 })
    expect(resolved.defaultMaxTokens).toBe(16_384)
    expect(resolved.inputModalities).toEqual(['text', 'image'])
    expect(resolved.reasoning).toEqual({
      efforts: [{ id: 'low', name: 'low' }, { id: 'high', name: 'high' }],
      defaultEffort: 'low',
    })
  })

  it('declares reasoning for a model that names one level without listing any', async () => {
    // 真实目录里 auto/glm-5.1/kimi-k2.6 等 7 个模型正是这个形状：
    // supportsReasoning + 只给 effort、没有 supportedEfforts。
    // 旧实现只读列表 → reasoning 为 undefined → 请求不带任何思考等级。
    const session = fakeSession({
      models: async () => [{
        id: 'auto', name: 'Auto', supportsReasoning: true, onlyReasoning: true,
        maxAllowedSize: 168_000, maxOutputTokens: 32_000,
        reasoning: { effort: 'high', summary: 'auto' },
      }],
    })
    const resolved = await adapter(session).resolveModel('codebuddy', 'auto')
    expect(resolved.reasoning).toEqual({
      efforts: [{ id: 'high', name: 'high' }],
      defaultEffort: 'high',
    })
  })

  it('declares reasoning for a model that reasons but discloses no reasoning block at all', async () => {
    // kimi-k2.8-preview：supportsReasoning=true 且 reasoning 完全缺失。
    const session = fakeSession({
      models: async () => [{
        id: 'kimi-k2.8-preview', name: 'Kimi', supportsReasoning: true, onlyReasoning: true,
        maxAllowedSize: 256_000, maxOutputTokens: 32_768,
      }],
    })
    const resolved = await adapter(session).resolveModel('codebuddy', 'kimi-k2.8-preview')
    // 没有等级可声明时仍不伪造一个：不声明胜过声明一个不存在的控制项。
    expect(resolved.reasoning).toBeUndefined()
  })

  it('adds the named level to the selectable list so the harness accepts the default', async () => {
    // 宿主会拒绝一个不在 efforts 里的 defaultEffort；点名的等级必须进列表。
    const session = fakeSession({
      models: async () => [{
        id: 'm', name: 'M', supportsReasoning: true,
        maxAllowedSize: 100_000, maxOutputTokens: 8_000,
        reasoning: { defaultEffort: 'high', supportedEfforts: ['low'] },
      }],
    })
    const resolved = await adapter(session).resolveModel('codebuddy', 'm')
    const ids = resolved.reasoning?.efforts.map(e => e.id)
    expect(ids).toContain('high')
    expect(resolved.reasoning?.defaultEffort).toBe('high')
  })

  it('prefers the server-side active effort over defaultEffort', async () => {
    const session = fakeSession({
      models: async () => [{
        id: 'm', name: 'M', supportsReasoning: true,
        maxAllowedSize: 100_000, maxOutputTokens: 8_000,
        reasoning: { effort: 'medium', defaultEffort: 'high', supportedEfforts: ['high'] },
      }],
    })
    const resolved = await adapter(session).resolveModel('codebuddy', 'm')
    expect(resolved.reasoning?.defaultEffort).toBe('medium')
  })

  it('declares no reasoning for a model that does not reason', async () => {
    const session = fakeSession({
      models: async () => [{ id: 'plain', name: 'Plain', maxAllowedSize: 100_000, maxOutputTokens: 8_000 }],
    })
    const resolved = await adapter(session).resolveModel('codebuddy', 'plain')
    expect(resolved.reasoning).toBeUndefined()
  })

  it('falls back to conservative text-only defaults for an out-of-catalog explicit id', async () => {
    const session = fakeSession({ models: async () => [] })
    const resolved = await adapter(session).resolveModel('codebuddy', 'unknown-model')
    expect(resolved).toEqual({
      provider: 'codebuddy',
      id: 'unknown-model',
      name: 'unknown-model',
      inputModalities: ['text'],
      context: { contextWindow: 128_000 },
      defaultMaxTokens: 8_192,
    })
  })
})

describe('listModels', () => {
  it('returns only models that disclose capacity', async () => {
    const session = fakeSession({
      modelsOrEmpty: async () => [
        { id: 'full', name: 'Full', maxAllowedSize: 100_000, maxOutputTokens: 8_000 },
        { id: 'no-capacity', name: 'No Capacity' },
        { id: 'zero', name: 'Zero', maxAllowedSize: 0, maxOutputTokens: 0 },
      ],
    })
    const models = await adapter(session).listModels('codebuddy')
    expect(models.map((model: LlmModelInfo) => model.id)).toEqual(['full'])
    expect(models[0]?.inputModalities).toEqual(['text'])
  })
})

describe('providerInfo', () => {
  it('returns the CodeBuddy display name for the route', () => {
    const info = adapter(fakeSession()).providerInfo('codebuddy')
    expect(info).toEqual({ id: 'codebuddy', name: 'CodeBuddy' })
  })
})

describe('stream', () => {
  it('sends the white-label user-agent header without deepseek-harness, plus auth headers', async () => {
    const { calls } = installFetch(() => streamResponse([
      'data: ' + JSON.stringify({ choices: [{ delta: { content: 'Hello' } }] }),
      'data: ' + DONE,
    ]))
    await collect(adapter(fakeSession()).stream(genOptions()))
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('https://copilot.tencent.com/v2/chat/completions')
    const headers = calls[0]?.init.headers ?? {}
    const userAgent = headers['user-agent'] ?? headers['User-Agent'] ?? ''
    expect(userAgent).toMatch(/^dsh-codebuddy\/\d+\.\d+\.\d+ \(\+https:\/\/github\.com\/minglo\/dsh-plugin-llm-codebuddy\)$/)
    expect(userAgent.toLowerCase()).not.toContain('deepseek-harness')
    expect(headers['Authorization']).toBe('Bearer t')
    expect(headers['X-Domain']).toBe('d')
  })

  it('forwards the caller signal to fetch (combined with the deadline)', async () => {
    const controller = new AbortController()
    const { calls } = installFetch(() => streamResponse(['data: ' + DONE]))
    await collect(adapter(fakeSession()).stream(genOptions({ signal: controller.signal })))
    expect(calls[0]?.init.signal).toBeDefined()
    expect(calls[0]?.init.signal).not.toBe(controller.signal) // 合成 signal（caller + 死线）
  })

  it('keeps reading the SSE body after the connect deadline (long inference must not be cut at 15s)', async () => {
    // 回归：header 死线曾以 AbortSignal.timeout 绑到 fetch 全生命周期，15s 后杀掉正在读的
    // SSE body——模型思考/长回答超过 15s 就报「接口失败」。死线现在只保护连接与响应头。
    vi.useFakeTimers()
    try {
      installFetch((_url: string, init: FetchCall['init']) => {
        const signal = init.signal as AbortSignal
        const encoder = new TextEncoder()
        let timer: ReturnType<typeof setTimeout> | undefined
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            // 死线之后才出现首个 chunk：越过连接死线，模拟慢推理。
            timer = setTimeout(() => {
              controller.enqueue(encoder.encode('data: ' + JSON.stringify({ choices: [{ delta: { reasoning_content: 'thinking' } }] }) + '\n\n'))
              controller.enqueue(encoder.encode('data: ' + DONE + '\n\n'))
              controller.close()
            }, REQUEST_TIMEOUT_MS + 1_000)
            // 真实 fetch 在 signal abort 时会 error 掉 body：mock 必须复刻。
            signal.addEventListener('abort', () => {
              if (timer !== undefined) clearTimeout(timer)
              controller.error(signal.reason)
            }, { once: true })
          },
        })
        return { ok: true, status: 200, headers: new Headers(), body }
      })

      const pending = collect(adapter(fakeSession()).stream(genOptions()))
      await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + 1_000)
      const chunks = await pending
      expect(chunks).toContainEqual({ type: 'reasoning-delta', index: 0, text: 'thinking' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('maps a connect deadline expiry to TIMEOUT instead of TRANSPORT', async () => {
    vi.useFakeTimers()
    try {
      installFetch((_url: string, init: FetchCall['init']) => {
        const signal = init.signal as AbortSignal
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        })
      })

      const pending = collect(adapter(fakeSession()).stream(genOptions()))
      const rejection = expect(pending).rejects.toMatchObject({ name: 'LlmError', code: 'TIMEOUT' })
      // 死线来自 REQUEST_TIMEOUT_MS（连接死线只护连接+响应头），不能在测试里写死。
      await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS)
      await rejection
    } finally {
      vi.useRealTimers()
    }
  })

  it('maps non-2xx responses through httpErrorCode into an LlmError', async () => {
    installFetch(() => errorResponse(401, { error: { message: 'unauthorized' } }))
    await expect(collect(adapter(fakeSession()).stream(genOptions()))).rejects.toMatchObject({
      name: 'LlmError',
      code: 'AUTH',
      failure: { code: 'AUTH', status: 401 },
    })
  })

  it('reads the envelope CodeBuddy actually sends (msg/displayMsg), not just OpenAI error.message', async () => {
    // 真实失败报文是 {code, msg, extError, displayMsg}：旧实现只读 error.message，
    // 于是每个 provider 消息都被换成裸 HTTP 状态码。
    installFetch(() => errorResponse(400, {
      code: 11101,
      msg: 'Unmarshal chat params failed',
      displayMsg: { en: 'Invalid request parameters. Please check and retry.', zh: '请求参数有误，请检查后重试。' },
    }))
    await expect(collect(adapter(fakeSession()).stream(genOptions()))).rejects.toMatchObject({
      name: 'LlmError',
      code: 'INVALID_REQUEST',
      message: 'Invalid request parameters. Please check and retry.',
    })
  })

  it('classifies CONTEXT_WINDOW_EXCEEDED from the real envelope wording', async () => {
    // 这条以前永远不触发：措辞在 msg/displayMsg 里，而分类器读的是 error.message，
    // 于是超长对话只会以通用 400 失败，**不会启动溢出压缩**。
    installFetch(() => errorResponse(400, {
      code: 400,
      msg: 'request exceeded the model context window',
      displayMsg: { en: 'The conversation exceeded the model context window.' },
    }))
    await expect(collect(adapter(fakeSession()).stream(genOptions()))).rejects.toMatchObject({
      code: 'CONTEXT_WINDOW_EXCEEDED',
    })
  })

  it('classifies QUOTA from a provider extError.message', async () => {
    installFetch(() => errorResponse(400, {
      code: 11115,
      msg: 'upstream rejected',
      extError: { message: 'insufficient quota for this account' },
    }))
    await expect(collect(adapter(fakeSession()).stream(genOptions()))).rejects.toMatchObject({
      code: 'QUOTA',
    })
  })

  it('turns a 429 that names its reset instant into a scheduled retry, not an immediate one', async () => {
    // 逐字照抄 2026-09-27 那次失败的文案（会话日志 seq 45）：措辞是中文，英文分类器
    // 认不出来，于是它落成「可重试」的 RATE_LIMIT 并被立刻重试 5 次。
    // 这里要的是：把报文里的重置时刻读出来交给宿主调度，别再即时重试。
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-27T08:00:00Z'))
    installFetch(() => errorResponse(429, {
      code: 11115,
      msg: 'usage limit exceeded',
      displayMsg: { zh: '您的使用量已超出频率限制，将在 2026-09-27 17:30:18 UTC+8 重置，您也可以切换其他模型继续使用。' },
    }, new Headers({ 'x-request-id': 'c21faf12-cfb8-4d2a-89ef-700d525b4b23' })))
    await expect(collect(adapterWithWaitSwitch(fakeSession(), () => true).stream(genOptions()))).rejects.toMatchObject({
      name: 'LlmError',
      code: 'RATE_LIMIT',
      message: '您的使用量已超出频率限制，将在 2026-09-27 17:30:18 UTC+8 重置，您也可以切换其他模型继续使用。',
      failure: {
        code: 'RATE_LIMIT',
        status: 429,
        // 17:30:18 +08 - 16:00:00 +08 = 5,418,000ms，再加 1 秒边界余量。
        providerRetryAfterMs: 5_419_000,
        requestId: 'c21faf12-cfb8-4d2a-89ef-700d525b4b23',
      },
    })
  })

  it('reads the reset instant out of a body it cannot parse as JSON', async () => {
    // 服务偶尔回一段非 JSON 的错误页；只要文本里有那个时刻，调度就不该丢。
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-27T08:00:00Z'))
    installFetch(() => errorResponse(429, 'rate limited; resets at 2026-09-27 17:30:18 UTC+8'))
    await expect(collect(adapterWithWaitSwitch(fakeSession(), () => true).stream(genOptions()))).rejects.toMatchObject({
      code: 'RATE_LIMIT',
      failure: { providerRetryAfterMs: 5_419_000 },
    })
  })

  it('prefers an explicit Retry-After over a sentence read out of the body', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-27T08:00:00Z'))
    installFetch(() => errorResponse(429, {
      displayMsg: { zh: '您的使用量已超出频率限制，将在 2026-09-27 17:30:18 UTC+8 重置。' },
    }, new Headers({ 'retry-after': '30' })))
    await expect(collect(adapterWithWaitSwitch(fakeSession(), () => true).stream(genOptions()))).rejects.toMatchObject({
      failure: { providerRetryAfterMs: 30_000 },
    })
  })

  it('leaves a 429 unattached by default, so the ordinary retry path handles it', async () => {
    // 开关默认关：读得出重置时刻也不挂等待。宿主按本地退避快速重试几次后抛出，
    // 报文里的「何时重置」随 message 原样保留，主 agent 据此切换模型继续。
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-27T08:00:00Z'))
    installFetch(() => errorResponse(429, {
      code: 11115,
      msg: 'usage limit exceeded',
      displayMsg: { zh: '您的使用量已超出频率限制，将在 2026-09-27 17:30:18 UTC+8 重置，您也可以切换其他模型继续使用。' },
    }))
    const failing = new CodeBuddyAdapter({ session: fakeSession(), options: () => connection })
    const error = await collect(failing.stream(genOptions())).then(
      () => undefined,
      (thrown: unknown) => thrown as { message?: string; failure: Record<string, unknown> },
    )
    expect(error?.message).toBe('您的使用量已超出频率限制，将在 2026-09-27 17:30:18 UTC+8 重置，您也可以切换其他模型继续使用。')
    expect(error?.failure).toMatchObject({ code: 'RATE_LIMIT', status: 429 })
    expect(Object.hasOwn(error!.failure, 'providerRetryAfterMs')).toBe(false)
  })

  it('refuses to wait past the 5-hour cap even when the switch is on', async () => {
    // 重置时刻在 9 小时后：超过 5 小时硬上限，按普通失败走快速重试，
    // 而不是让一个回合睡到明天早上。
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-27T08:00:00Z'))
    installFetch(() => errorResponse(429, {
      displayMsg: { zh: '您的使用量已超出频率限制，将在 2026-09-28 01:00:00 UTC+8 重置。' },
    }))
    const error = await collect(adapterWithWaitSwitch(fakeSession(), () => true).stream(genOptions())).then(
      () => undefined,
      (thrown: unknown) => thrown as { failure: Record<string, unknown> },
    )
    expect(error?.failure).toMatchObject({ code: 'RATE_LIMIT', status: 429 })
    expect(Object.hasOwn(error!.failure, 'providerRetryAfterMs')).toBe(false)
  })

  it('keeps a non-429 provider Retry-After attached regardless of the 429 switch', async () => {
    // 开关只管 429：服务对别的状态（503 等）给出的 Retry-After 仍是明确的
    // 调度指令，不因开关关闭而被丢掉。
    installFetch(() => errorResponse(503, 'upstream busy', new Headers({ 'retry-after': '30' })))
    await expect(collect(adapter(fakeSession()).stream(genOptions()))).rejects.toMatchObject({
      failure: { code: 'SERVER', status: 503, providerRetryAfterMs: 30_000 },
    })
  })

  it('keeps a 429 without a readable retry time unattached and logs the body', async () => {
    // 服务说稍后再试却没说什么时候：不能凭空造一个等待，但要留下原文供核对。
    const warn = vi.fn()
    installFetch(() => errorResponse(429, { code: 11115, msg: 'too many requests' }))
    const failing = new CodeBuddyAdapter({ session: fakeSession(), options: () => connection, warn })
    const error = await collect(failing.stream(genOptions())).then(
      () => undefined,
      (thrown: unknown) => thrown as { failure: Record<string, unknown> },
    )
    expect(error?.failure).toMatchObject({ code: 'RATE_LIMIT', status: 429 })
    expect(Object.hasOwn(error!.failure, 'providerRetryAfterMs')).toBe(false)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toContain('too many requests')
  })

  it('keeps QUOTA for a 429 that names no reset instant', async () => {
    // 没有「何时可再试」的额度措辞仍是终态额度问题，不该被当成限流来重试。
    expect(failureCode(429, 'insufficient quota for this account', undefined)).toBe('QUOTA')
    expect(failureCode(429, undefined, 1_000)).toBe('RATE_LIMIT')
  })

  it('reports the curated sentence in the requested language', async () => {
    installFetch(() => errorResponse(400, {
      code: 11101,
      msg: 'raw service text',
      displayMsg: { en: 'Invalid request parameters.', zh: '请求参数有误，请检查后重试。', 'zh-hant': '請求參數有誤，請檢查後重試。' },
    }))
    const chunks = collect(adapterWithLanguage(fakeSession(), () => 'zh').stream(genOptions()))
    await expect(chunks).rejects.toMatchObject({ message: '请求参数有误，请检查后重试。' })
  })

  it('routes a regional Traditional Chinese id to the zh-hant wording', async () => {
    // 语言包按地区选（zh-TW），而服务把繁中只放在 zh-hant 下；
    // 按 zh 读会让繁体读者收到简体。
    installFetch(() => errorResponse(400, {
      code: 11101,
      msg: 'raw',
      displayMsg: { zh: '请求参数有误。', 'zh-hant': '請求參數有誤。' },
    }))
    const chunks = collect(adapterWithLanguage(fakeSession(), () => 'zh-TW').stream(genOptions()))
    await expect(chunks).rejects.toMatchObject({ message: '請求參數有誤。' })
  })

  it('falls back to the provider message when the envelope curates nothing', async () => {
    installFetch(() => errorResponse(400, { code: 11115, msg: 'quota exceeded somewhere' }))
    await expect(collect(adapter(fakeSession()).stream(genOptions()))).rejects.toMatchObject({
      message: 'quota exceeded somewhere',
    })
  })

  it('keeps the status-derived error when the error body is unreadable', async () => {
    // 畸形 JSON 不许把失败盖掉：状态码仍能标识它。
    installFetch(() => ({
      ok: false,
      status: 503,
      headers: new Headers(),
      text: async () => { throw new Error('truncated') },
    } as unknown as Response))
    await expect(collect(adapter(fakeSession()).stream(genOptions()))).rejects.toMatchObject({
      name: 'LlmError',
      code: 'SERVER',
      failure: { code: 'SERVER', status: 503 },
    })
  })

  it('does not let a throwing language source discard the envelope', async () => {
    // 语言只是装饰，失败不是：抛错的语言来源必须被隔离。
    installFetch(() => errorResponse(400, {
      code: 400,
      msg: 'request exceeded the model context window',
    }))
    const chunks = collect(adapterWithLanguage(fakeSession(), () => { throw new Error('no locale') }).stream(genOptions()))
    await expect(chunks).rejects.toMatchObject({ code: 'CONTEXT_WINDOW_EXCEEDED' })
  })

  it('translates an SSE body into StreamChunks', async () => {
    installFetch(() => streamResponse([
      'data: ' + JSON.stringify({ choices: [{ delta: { content: 'Hello' } }] }),
      'data: ' + DONE,
    ]))
    const chunks = await collect(adapter(fakeSession()).stream(genOptions()))
    expect(chunks[0]).toEqual({ type: 'block-start', index: 0, blockType: 'text' })
    expect(chunks[1]).toEqual({ type: 'text-delta', index: 0, text: 'Hello' })
    expect(chunks[2]).toEqual({ type: 'block-end', index: 0, block: { type: 'text', text: 'Hello' } })
    expect(chunks[3]).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('throws MISSING_CREDENTIAL when the session reports NotLoggedInError', async () => {
    const session = fakeSession({
      authHeaders: async () => { throw new NotLoggedInError('signed out') },
    })
    await expect(collect(adapter(session).stream(genOptions()))).rejects.toMatchObject({
      name: 'LlmError',
      code: 'MISSING_CREDENTIAL',
    })
  })
})

describe('chat request headers', () => {
  it('sends X-Model-ID set to the routed model', async () => {
    const { calls } = installFetch(() => streamResponse(['data: ' + DONE]))
    await collect(adapter(fakeSession()).stream(genOptions({ model: 'claude-sonnet-4.5' })))
    expect(calls[0].init.headers?.['X-Model-ID']).toBe('claude-sonnet-4.5')
  })

  it('stamps X-Conversation-ID from the session id', async () => {
    const { calls } = installFetch(() => streamResponse(['data: ' + DONE]))
    await collect(adapter(fakeSession()).stream(genOptions({ sessionId: 'sess-42' as never })))
    expect(calls[0].init.headers?.['X-Conversation-ID']).toBe('sess-42')
  })

  it('omits X-Conversation-ID when no session id is stamped', async () => {
    const { calls } = installFetch(() => streamResponse(['data: ' + DONE]))
    await collect(adapter(fakeSession()).stream(genOptions()))
    expect(calls[0].init.headers).not.toHaveProperty('X-Conversation-ID')
  })
})

describe('channel block recording', () => {
  it('records the X-User-Id it sent with the block', async () => {
    // $DSH_HOME 可能被多个账号共用：没有发出的 uid，记录说不清是谁被拦。
    const recorded: ChannelBlockRecord[] = []
    const instance = new CodeBuddyAdapter({
      session: fakeSession({
        authHeaders: async () => ({ Authorization: 'Bearer t', 'X-User-Id': 'user-7' }),
      }),
      options: () => connection,
      recordBlock: (record) => { recorded.push(record) },
    })
    installFetch(() => errorResponse(400, {
      code: CHANNEL_REJECTION_CODE,
      msg: 'Illegal API invocation from an unapproved channel',
    }))

    await expect(collect(instance.stream(genOptions()))).rejects.toMatchObject({ code: 'CHANNEL_BLOCKED' })
    expect(recorded).toHaveLength(1)
    expect(recorded[0]?.sentUserId).toBe('user-7')
  })
})

describe('providerRetryPolicy', () => {
  it('returns undefined when no policy is configured', () => {
    expect(adapter(fakeSession()).providerRetryPolicy('codebuddy')).toBeUndefined()
  })

  // 原第二例（'returns the policy captured for the route'）只是把测试自己传进去的
  // 对象再读回来，且实现签名是 providerRetryPolicy(_provider)——provider 参数根本
  // 不参与取数，"for the route" 无从谈起，故删除。这里只保留真边界：
  // 配置了策略就必须原样取回（重试执行器据此决定 providerRetryAfterMs 是否采纳）。
  it('returns the configured policy unchanged', () => {
    const policy = { mode: 'normal', maxRetries: 3, retryableCodes: ['TRANSPORT'], initialDelayMs: 100, maxDelayMs: 1_000, jitterRatio: 0.1 }
    const instance = adapter(fakeSession(), { retryPolicy: policy as never })
    expect(instance.providerRetryPolicy('codebuddy')).toBe(policy)
  })
})

