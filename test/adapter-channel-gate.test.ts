import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { CodeBuddyAdapter } from '../src/adapter.js'
import type { CodeBuddyConnectionOptions } from '../src/adapter.js'
import type { CodeBuddySession } from '../src/session.js'
import type { CodeBuddyModel } from '../src/types.js'
import { DONE } from '../src/sse.js'

// 渠道校验的身份指纹只在 CodeBuddy 官方端点上生效：自建网关/代理没有那道校验，
// 它们的运营方应该看到 dsh 真正组装的提示。
// 另一头：上游的失败信封有两半（displayMsg 说出了什么事，displayTips 说该怎
// 么办），两半都要上报，但建议不参与失败分类。

const IDENTITY = 'You are an AI agent powered by DeepSeek Harness.'

const connection: CodeBuddyConnectionOptions = {
  baseURL: 'https://copilot.tencent.com/v2',
  defaultContextWindow: 128_000,
  defaultMaxTokens: 8_192,
  streamIdleTimeoutMs: 300_000,
}

function fakeSession(): CodeBuddySession {
  return {
    authHeaders: async () => ({ Authorization: 'Bearer t', 'X-Domain': 'd' }),
    models: async () => [{ id: 'm1', supportsImages: false, supportsToolCall: true }] as CodeBuddyModel[],
    modelsOrEmpty: async () => [] as CodeBuddyModel[],
  } as unknown as CodeBuddySession
}

function adapterWith(baseURL: string): CodeBuddyAdapter {
  return new CodeBuddyAdapter({ session: fakeSession(), options: () => ({ ...connection, baseURL }) })
}

function sseResponse(): Response {
  const enc = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"x"}}]}\n\n'))
      controller.enqueue(enc.encode(`data: ${DONE}\n\n`))
      controller.close()
    },
  })
  return { ok: true, status: 200, headers: new Headers(), body } as unknown as Response
}

function errorResponse(status: number, body: unknown): Response {
  const text = JSON.stringify(body)
  return {
    ok: false,
    status,
    headers: new Headers(),
    text: async () => text,
  } as unknown as Response
}

interface FetchCall {
  url: string
  init: { body?: string }
}

function installFetch(handler: () => unknown) {
  const calls: FetchCall[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: FetchCall['init']) => {
    calls.push({ url, init })
    return handler()
  }))
  return calls
}

function systemOf(call: FetchCall | undefined): string {
  const body = JSON.parse(String(call?.init.body)) as { messages: { role: string, content: string }[] }
  return body.messages.find(message => message.role === 'system')?.content ?? ''
}

function genOptions(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return { provider: 'codebuddy', model: 'm1', messages: [], ...overrides }
}

async function drain(iterable: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of iterable) { /* 只需把流跑完 */ }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('channel fingerprint gate', () => {
  it('breaks the fingerprint for the official endpoint', async () => {
    const calls = installFetch(() => sseResponse())
    await drain(adapterWith(connection.baseURL).stream(genOptions({ system: `${IDENTITY}\n\nBody.` })))
    expect(systemOf(calls[0])).toBe('You are an AI agent, powered by DeepSeek Harness.\n\nBody.')
  })

  it('leaves the prompt alone for a custom gateway', async () => {
    const calls = installFetch(() => sseResponse())
    await drain(adapterWith('https://proxy.example/v2').stream(genOptions({ system: `${IDENTITY}\n\nBody.` })))
    expect(systemOf(calls[0])).toBe(`${IDENTITY}\n\nBody.`)
  })
})

describe('failure advice', () => {
  const CURATED = {
    code: 11128,
    msg: 'Illegal API invocation from an unapproved channel',
    displayMsg: { en: 'Request blocked. Please send it again', zh: '请求被拦截，请重新发送' },
    displayTips: {
      en: 'This call failed channel verification, possibly because it was not sent from an official client.',
      zh: '这次调用没通过渠道校验，可能不是官方客户端发出的。',
    },
  }

  it('reports the advice after the statement', async () => {
    installFetch(() => errorResponse(400, CURATED))
    await expect(drain(adapterWith(connection.baseURL).stream(genOptions())))
      .rejects.toMatchObject({
        message: 'Request blocked. Please send it again: This call failed channel verification, possibly because it was not sent from an official client.',
      })
  })

  it('reports the Chinese advice on a Chinese client', async () => {
    installFetch(() => errorResponse(400, CURATED))
    const adapter = new CodeBuddyAdapter({ session: fakeSession(), options: () => connection, language: () => 'zh' })
    await expect(drain(adapter.stream(genOptions())))
      .rejects.toMatchObject({ message: '请求被拦截，请重新发送：这次调用没通过渠道校验，可能不是官方客户端发出的。' })
  })

  it('does not let the advice steer the failure code', async () => {
    // 只有陈述句参与分类：建议里的措辞不该把失败改归类。
    installFetch(() => errorResponse(400, { code: 1, displayMsg: { en: 'msg' }, displayTips: { en: 'quota exceeded' } }))
    await expect(drain(adapterWith(connection.baseURL).stream(genOptions())))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })
})

describe('channel rejection classification', () => {
  const BLOCKED = {
    code: 11128,
    msg: 'Illegal API invocation from an unapproved channel',
    displayMsg: { en: 'Request blocked. Please send it again' },
    displayTips: { en: 'This call failed channel verification.' },
  }

  it('classifies 11128 as CHANNEL_BLOCKED, not INVALID_REQUEST', async () => {
    installFetch(() => errorResponse(400, BLOCKED))
    await expect(drain(adapterWith(connection.baseURL).stream(genOptions())))
      .rejects.toMatchObject({ code: 'CHANNEL_BLOCKED' })
  })

  it('does not retry a channel rejection', async () => {
    // 11128 是确定性失败：重发只把一次失败拖成几十秒。
    const calls = installFetch(() => errorResponse(400, BLOCKED))
    await expect(drain(adapterWith(connection.baseURL).stream(genOptions()))).rejects.toThrow()
    expect(calls).toHaveLength(1)
  })

  it('hands the block record to the injected callback', async () => {
    installFetch(() => errorResponse(400, BLOCKED))
    const recordBlock = vi.fn()
    const adapter = new CodeBuddyAdapter({ session: fakeSession(), options: () => connection, recordBlock })
    const system = `${IDENTITY}\n\nBody.`
    await expect(drain(adapter.stream(genOptions({ system })))).rejects.toThrow()
    expect(recordBlock).toHaveBeenCalledTimes(1)
    expect(recordBlock.mock.calls[0]?.[0]).toMatchObject({
      endpoint: 'https://copilot.tencent.com/v2',
      fingerprintGuess: 'identity-sentence',
      // 指纹与长度必须来自同一份原文：只断 guess 会放过「长度取自另一处」的回归。
      systemLength: system.length,
    })
  })

  it('reads the fingerprint from the loop-built system message', async () => {
    // 真实对话走这条路径：宿主不发 options.system，system 提示在 messages[0]。
    // 若只看 options.system，systemLength 恒 0、guess 恒 unknown。
    installFetch(() => errorResponse(400, BLOCKED))
    const recordBlock = vi.fn()
    const adapter = new CodeBuddyAdapter({ session: fakeSession(), options: () => connection, recordBlock })
    await expect(drain(adapter.stream(genOptions({
      messages: [{ role: 'system', content: [{ type: 'text', text: `${IDENTITY}\n\nBody.` }] }],
    })))).rejects.toThrow()
    expect(recordBlock.mock.calls[0]?.[0]).toMatchObject({
      fingerprintGuess: 'identity-sentence',
    })
    expect(recordBlock.mock.calls[0]?.[0]?.systemLength).toBeGreaterThan(0)
  })

  it('survives a throwing callback', async () => {
    // 诊断不能反过来弄坏请求结果。
    installFetch(() => errorResponse(400, BLOCKED))
    const adapter = new CodeBuddyAdapter({
      session: fakeSession(), options: () => connection,
      recordBlock: () => { throw new Error('disk full') },
    })
    await expect(drain(adapter.stream(genOptions()))).rejects.toMatchObject({ code: 'CHANNEL_BLOCKED' })
  })

  it('does not let a throwing warn replace the CHANNEL_BLOCKED error', async () => {
    // recordBlock 失败后的 warn 也是注入的：它再抛错，不能把分类结果换掉。
    installFetch(() => errorResponse(400, BLOCKED))
    const adapter = new CodeBuddyAdapter({
      session: fakeSession(), options: () => connection,
      recordBlock: () => { throw new Error('disk full') },
      warn: () => { throw new Error('logger down') },
    })
    await expect(drain(adapter.stream(genOptions()))).rejects.toMatchObject({ code: 'CHANNEL_BLOCKED' })
  })

  it('leaves other 400s as INVALID_REQUEST', async () => {
    installFetch(() => errorResponse(400, { code: 1, msg: 'bad parameter' }))
    await expect(drain(adapterWith(connection.baseURL).stream(genOptions())))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })

  it('does not misclassify a 400 that merely mentions the channel wording', async () => {
    // Review Focus 第 5 条：按 code 判，不按文案判——文案会被改。
    installFetch(() => errorResponse(400, { code: 1, msg: 'Illegal API invocation from an unapproved channel' }))
    await expect(drain(adapterWith(connection.baseURL).stream(genOptions())))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })
})
