import { describe, expect, it } from 'vitest'
import {
  CodeBuddySearchProvider,
  mapFetchResponse,
  mapSearchResponse,
  mapSearchResult,
} from '../src/web-providers.js'
import { NotLoggedInError } from '../src/session.js'
import type { CodeBuddySession } from '../src/session.js'

describe('mapSearchResult', () => {
  it('maps url/title/snippet and keeps all three when present', () => {
    expect(mapSearchResult({ url: 'https://a.example', title: 'T', snippet: 'S' }))
      .toEqual({ url: 'https://a.example', title: 'T', snippet: 'S' })
  })

  it('drops an entry with no usable url (url is required on a source)', () => {
    expect(mapSearchResult({ title: 'T', snippet: 'S' })).toBeUndefined()
    expect(mapSearchResult({ url: '', title: 'T' })).toBeUndefined()
    expect(mapSearchResult({ url: null })).toBeUndefined()
  })

  it('keeps a source that has a url but no snippet', () => {
    // 与上游 Exa 参考实现刻意的差异：Exa 只能从 highlights 推导 snippet，无从
    // 推导时必须丢弃；本网关直接给出 snippet 字段，缺 snippet 仍可引用，不该白丢。
    expect(mapSearchResult({ url: 'https://a.example' })).toEqual({ url: 'https://a.example' })
  })

  it('omits blank optional fields instead of emitting empty strings', () => {
    expect(mapSearchResult({ url: 'https://a.example', title: '', snippet: '' }))
      .toEqual({ url: 'https://a.example' })
  })
})

describe('mapSearchResponse', () => {
  it('maps results and drops unusable entries', () => {
    const result = mapSearchResponse({
      results: [
        { url: 'https://a.example', title: 'A', snippet: 'sa' },
        { title: 'no url' },
        { url: 'https://b.example' },
      ],
    })
    expect(result.sources).toEqual([
      { url: 'https://a.example', title: 'A', snippet: 'sa' },
      { url: 'https://b.example' },
    ])
  })

  it('reports truncated:false because the seam owns maxResults truncation', () => {
    const result = mapSearchResponse({ results: [{ url: 'https://a.example' }] })
    expect(result.truncated).toBe(false)
  })

  it('tolerates a missing or null results array', () => {
    expect(mapSearchResponse({}).sources).toEqual([])
    expect(mapSearchResponse({ results: null }).sources).toEqual([])
  })
})

describe('mapFetchResponse', () => {
  it('classifies the decoded body as text and passes the real status through', () => {
    const result = mapFetchResponse({ url: 'https://a.example/f', content: 'hello', status_code: 404 }, 'https://req.example')
    expect(result).toEqual({
      url: 'https://a.example/f',
      statusCode: 404,
      body: { kind: 'text', content: 'hello' },
      truncated: false,
    })
  })

  it('falls back to the request url when the gateway omits one', () => {
    expect(mapFetchResponse({ content: 'x' }, 'https://req.example').url).toBe('https://req.example')
  })

  it('assumes 200 when the gateway could not determine the target status', () => {
    // 网关取不到目标页状态时给 null；这时的 200 是「取回成功」而非目标页的 200。
    expect(mapFetchResponse({ content: 'x', status_code: null }, 'https://req.example').statusCode).toBe(200)
    expect(mapFetchResponse({ content: 'x' }, 'https://req.example').statusCode).toBe(200)
  })

  it('forwards the gateway truncation flag', () => {
    expect(mapFetchResponse({ content: 'x', truncated: true }, 'https://req.example').truncated).toBe(true)
  })

  it('yields empty text rather than undefined when content is absent', () => {
    const result = mapFetchResponse({ status_code: 200 }, 'https://req.example')
    expect(result.body).toEqual({ kind: 'text', content: '' })
  })
})

describe('CodeBuddy providers · credential race', () => {
  it('normalizes a missing credential into a coded WebError instead of leaking NotLoggedInError', async () => {
    // 竞态：provider 已注册，但凭据刚被清掉（登出事件与本次调用赛跑）。
    const session = {
      identity: async () => { throw new NotLoggedInError('CodeBuddy is not signed in') },
    } as unknown as CodeBuddySession
    const provider = new CodeBuddySearchProvider({
      session,
      gatewayRoot: 'https://copilot.tencent.com',
      isAvailable: () => true,
    })

    await expect(provider.search({ query: 'q' })).rejects.toMatchObject({
      code: 'WEB_PROVIDER_CREDENTIAL_MISSING',
    })
  })
})
