import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { CodeBuddyAdapter } from '../src/adapter.js'
import type { CodeBuddyConnectionOptions } from '../src/adapter.js'
import type { CodeBuddySession } from '../src/session.js'
import type { CodeBuddyModel } from '../src/types.js'
import { DONE } from '../src/sse.js'

// CodeBuddy 网关偶发把上游厂商的瞬时校验失败包装成 HTTP 400 code=11133 返回
// （服务端侧故障窗口，同构请求稍后重发即成功）。宿主只重试 RATE_LIMIT/SERVER/
// TIMEOUT/TRANSPORT 这些码，400 一律不重试——所以插件自己得认这个码。

const connection: CodeBuddyConnectionOptions = {
  baseURL: 'https://copilot.tencent.com/v2',
  defaultContextWindow: 128_000,
  defaultMaxTokens: 8_192,
  streamIdleTimeoutMs: 300_000,
}

function fakeSession(): CodeBuddySession {
  return {
    authHeaders: async () => ({ Authorization: 'Bearer t', 'X-Domain': 'd' }),
    models: async () => [] as CodeBuddyModel[],
    modelsOrEmpty: async () => [] as CodeBuddyModel[],
  } as unknown as CodeBuddySession
}

function adapter(): CodeBuddyAdapter {
  return new CodeBuddyAdapter({ session: fakeSession(), options: () => connection })
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

function errorResponse(status: number, body: unknown): Response {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  return {
    ok: false,
    status,
    headers: new Headers(),
    text: async () => text,
  } as unknown as Response
}

interface FetchCall {
  url: string
  init: { method?: string; headers?: Record<string, string>; body?: string; signal?: unknown }
}

function installFetch(handler: () => unknown) {
  const calls: FetchCall[] = []
  const mock = vi.fn(async (url: string, init: FetchCall['init']) => {
    calls.push({ url, init })
    return handler()
  })
  vi.stubGlobal('fetch', mock)
  return { mock, calls }
}

function genOptions(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return { provider: 'codebuddy', model: 'm1', messages: [], ...overrides }
}

async function collect(iterable: AsyncIterable<unknown>): Promise<unknown[]> {
  const out: unknown[] = []
  for await (const value of iterable) out.push(value)
  return out
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('transient upstream 400 (code 11133)', () => {
  it('retries the same request and streams the next response', async () => {
    vi.useFakeTimers()
    let attempt = 0
    const { calls } = installFetch(() => {
      attempt++
      return attempt === 1
        ? errorResponse(400, { code: 11133, msg: 'Invalid request parameters' })
        : streamResponse(['data: ' + JSON.stringify({ choices: [{ delta: { content: 'Hello' } }] }), 'data: ' + DONE])
    })

    const pending = collect(adapter().stream(genOptions()))
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(1000)
    const chunks = await pending
    expect(calls).toHaveLength(2)
    expect(chunks.length).toBeGreaterThan(0)
    // 重发的是同一个请求：目标地址与 body 都逐字相同。
    expect(calls[1]?.url).toBe(calls[0]?.url)
    expect(calls[1]?.init.body).toBe(calls[0]?.init.body)
  })

  it('does not retry a 400 that is not 11133', async () => {
    const { calls } = installFetch(() => errorResponse(400, { code: 11101, msg: 'Non-stream chat request is currently not supported' }))
    await expect(collect(adapter().stream(genOptions()))).rejects.toThrow()
    expect(calls).toHaveLength(1)
  })

  it('gives up after the last retry and reports the failure', async () => {
    vi.useFakeTimers()
    const { calls } = installFetch(() => errorResponse(400, { code: 11133, msg: 'Invalid request parameters' }))

    const pending = collect(adapter().stream(genOptions()))
    const settled = pending.then(() => 'resolved', (error: unknown) => error)
    // 初次 + 4 次退避重发（1s → 4s → 10s → 25s）。
    for (const step of [0, 1000, 4000, 10_000, 25_000]) {
      await vi.advanceTimersByTimeAsync(step)
    }
    const outcome = await settled
    expect(outcome).toBeInstanceOf(Error)
    expect(calls).toHaveLength(5)
  })
})
