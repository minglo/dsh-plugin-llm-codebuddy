import { describe, expect, it } from 'vitest'
import { DONE } from '../src/sse.js'
import { mapFinishReason, mapUsage, normalizeToolArguments, translate } from '../src/translate.js'
import type { WireUsage } from '../src/types.js'

interface Tool { name: string; parameters: Record<string, unknown> }

async function* payloads(items: string[]): AsyncGenerator<string> {
  for (const item of items) yield item
}

async function collect(items: string[], tools: readonly Tool[] = []): Promise<unknown[]> {
  const out: unknown[] = []
  for await (const chunk of translate(payloads(items), tools)) out.push(chunk)
  return out
}

describe('mapUsage', () => {
  it('prefers prompt_tokens_details.cached_tokens over prompt_cache_hit_tokens (mutual exclusion)', () => {
    const usage: WireUsage = {
      prompt_tokens: 100,
      completion_tokens: 50,
      prompt_cache_hit_tokens: 10,
      prompt_tokens_details: { cached_tokens: 30 },
      completion_tokens_details: { reasoning_tokens: 7 },
    }
    expect(mapUsage(usage)).toEqual({
      inputTokens: 70,
      outputTokens: 50,
      totalTokens: 150,
      cacheReadTokens: 30,
      reasoningTokens: 7,
    })
  })

  it('falls back to prompt_cache_hit_tokens when cached_tokens is absent', () => {
    const usage: WireUsage = { prompt_tokens: 100, completion_tokens: 50, prompt_cache_hit_tokens: 10 }
    expect(mapUsage(usage)).toEqual({ inputTokens: 90, outputTokens: 50, totalTokens: 150, cacheReadTokens: 10 })
  })

  it('clamps inputTokens at zero when cached input exceeds prompt', () => {
    const usage: WireUsage = { prompt_tokens: 5, completion_tokens: 3, prompt_cache_hit_tokens: 20 }
    expect(mapUsage(usage)).toEqual({ inputTokens: 0, outputTokens: 3, totalTokens: 8, cacheReadTokens: 20 })
  })

  it('omits cache and reasoning keys when absent', () => {
    expect(mapUsage({ prompt_tokens: 10, completion_tokens: 2 })).toEqual({ inputTokens: 10, outputTokens: 2, totalTokens: 12 })
  })

  it('emits a provable totalTokens: token-meter drops a turn whose usage has neither an exact total nor both cache buckets', () => {
    const usage: WireUsage = {
      prompt_tokens: 66011,
      completion_tokens: 3,
      total_tokens: 66014,
      prompt_tokens_details: { cached_tokens: 65920 },
      completion_tokens_details: { reasoning_tokens: 0 },
    }
    const mapped = mapUsage(usage)
    expect(mapped.totalTokens).toBe(66014)
    // Disjoint-count contract: input excludes the cache read.
    expect(mapped.inputTokens).toBe(91)
    expect(mapped.cacheReadTokens).toBe(65920)
  })

  it('omits totalTokens when the wire total contradicts the aggregate counters', () => {
    const usage: WireUsage = { prompt_tokens: 100, completion_tokens: 50, total_tokens: 999 }
    expect(mapUsage(usage).totalTokens).toBeUndefined()
  })

  it('omits totalTokens when a counter is not a safe non-negative integer', () => {
    expect(mapUsage({ prompt_tokens: Number.NaN, completion_tokens: 5, total_tokens: 5 }).totalTokens).toBeUndefined()
    expect(mapUsage({ prompt_tokens: -1, completion_tokens: 5, total_tokens: 4 }).totalTokens).toBeUndefined()
  })

  it('does not leak an untrustworthy completion counter into outputTokens', () => {
    // 判定不信任的计数（NaN/负数/非整数）不能只省略 totalTokens 却把原值透传给 outputTokens。
    expect(mapUsage({ prompt_tokens: 5, completion_tokens: Number.NaN }).outputTokens).toBe(0)
    expect(mapUsage({ prompt_tokens: 5, completion_tokens: -1 }).outputTokens).toBe(0)
    expect(mapUsage({ prompt_tokens: 5, completion_tokens: 2.5 }).outputTokens).toBe(0)
  })

  it('omits totalTokens when the wire total is a non-integer', () => {
    expect(mapUsage({ prompt_tokens: 100, completion_tokens: 50, total_tokens: 150.5 }).totalTokens).toBeUndefined()
  })
})

describe('mapFinishReason', () => {
  it('maps stop', () => expect(mapFinishReason('stop')).toEqual({ kind: 'stop' }))
  it('maps tool_calls', () => expect(mapFinishReason('tool_calls')).toEqual({ kind: 'tool-calls' }))
  it('maps length', () => expect(mapFinishReason('length')).toEqual({ kind: 'max-tokens' }))
  it('maps an unknown reason to an error finish', () => {
    expect(mapFinishReason('content_filter')).toEqual({
      kind: 'error',
      failure: { message: 'model stopped: content_filter', code: 'CONTENT_FILTER' },
    })
  })
})

describe('normalizeToolArguments', () => {
  const tools: readonly Tool[] = [
    {
      name: 'search',
      parameters: {
        type: 'object',
        properties: {
          query: {},
          tags: { description: 'any JSON value' },
          path: { type: 'string' },
        },
      },
    },
  ]

  it('decodes double-encoded JSON in unconstrained fields', () => {
    const args = JSON.stringify({ query: '{"x":1}', tags: '["a","b"]' })
    const out = normalizeToolArguments('search', args, tools)
    expect(JSON.parse(out)).toEqual({ query: { x: 1 }, tags: ['a', 'b'] })
  })

  it('passes constrained fields through unchanged', () => {
    const args = { path: '{"not":"decoded"}' }
    const out = normalizeToolArguments('search', JSON.stringify(args), tools)
    expect(JSON.parse(out)).toEqual(args)
  })

  it('returns the input verbatim for unknown tools or missing properties', () => {
    const text = '{"query":' + JSON.stringify('{"x":1}') + '}'
    expect(normalizeToolArguments('other', text, tools)).toBe(text)
    expect(normalizeToolArguments('search', text, [])).toBe(text)
  })

  it('returns the input verbatim when arguments are not a JSON object', () => {
    expect(normalizeToolArguments('search', 'not json', tools)).toBe('not json')
    expect(normalizeToolArguments('search', '[1,2]', tools)).toBe('[1,2]')
  })
})

describe('translate', () => {
  it('assembles text and emits usage before finish', async () => {
    const chunks = await collect([
      JSON.stringify({ choices: [{ delta: { content: 'Hello' } }] }),
      JSON.stringify({ choices: [{ delta: { content: ' world' } }] }),
      JSON.stringify({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } }),
      DONE,
    ])
    expect(chunks[0]).toEqual({ type: 'block-start', index: 0, blockType: 'text' })
    expect(chunks[1]).toEqual({ type: 'text-delta', index: 0, text: 'Hello' })
    expect(chunks[2]).toEqual({ type: 'text-delta', index: 0, text: ' world' })
    expect(chunks[3]).toEqual({ type: 'block-end', index: 0, block: { type: 'text', text: 'Hello world' } })
    expect(chunks[4]).toEqual({ type: 'usage', usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } })
    expect(chunks[5]).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    const types = chunks.map((c) => (c as { type: string }).type)
    expect(types.indexOf('usage')).toBeLessThan(types.indexOf('finish'))
  })

  it('emits nothing after the finish chunk', async () => {
    const chunks = await collect([
      JSON.stringify({ choices: [{ delta: { content: 'x' }, finish_reason: 'stop' }] }),
      DONE,
      JSON.stringify({ choices: [{ delta: { content: 'LATE' } }] }),
    ])
    const types = chunks.map((c) => (c as { type: string }).type)
    expect(types).toEqual(['block-start', 'text-delta', 'block-end', 'finish'])
    expect(chunks).not.toContainEqual(expect.objectContaining({ text: 'LATE' }))
  })

  it('throws STREAM_CLOSED when the payload stream ends without [DONE]', async () => {
    const gen = translate(payloads([JSON.stringify({ choices: [{ delta: { content: 'x' } }] })]))
    await expect(async () => { for await (const _ of gen) { /* drain */ } }).rejects.toMatchObject({ code: 'STREAM_CLOSED' })
  })

  it('assembles reasoning deltas into a reasoning block', async () => {
    const chunks = await collect([
      JSON.stringify({ choices: [{ delta: { reasoning_content: 'think' } }] }),
      JSON.stringify({ choices: [{ delta: { reasoning_content: 'ing' }, finish_reason: 'stop' }] }),
      DONE,
    ])
    expect(chunks[0]).toEqual({ type: 'block-start', index: 0, blockType: 'reasoning' })
    expect(chunks[1]).toEqual({ type: 'reasoning-delta', index: 0, text: 'think' })
    expect(chunks[2]).toEqual({ type: 'reasoning-delta', index: 0, text: 'ing' })
    expect(chunks[3]).toEqual({ type: 'block-end', index: 0, block: { type: 'reasoning', text: 'thinking' } })
    expect(chunks[4]).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('assembles tool calls and normalizes their arguments', async () => {
    const tools: readonly Tool[] = [{ name: 'run', parameters: { type: 'object', properties: { input: {} } } }]
    const arg1 = '{"input":' + JSON.stringify(JSON.stringify({ a: 1 }))
    const arg2 = '}'
    const chunks = await collect([
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'run', arguments: arg1 } }] } }] }),
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: arg2 } }] }, finish_reason: 'tool_calls' }] }),
      DONE,
    ], tools)
    expect(chunks[0]).toEqual({ type: 'block-start', index: 0, blockType: 'tool-call' })
    expect(chunks[1]).toEqual({ type: 'tool-call-delta', index: 0, id: 'call_1', name: 'run', argumentsDelta: arg1 })
    expect(chunks[2]).toEqual({ type: 'tool-call-delta', index: 0, id: 'call_1', name: 'run', argumentsDelta: arg2 })
    const end = chunks[3] as { type: string; block: { type: string; id: string; name: string; arguments: string } }
    expect(end.type).toBe('block-end')
    expect(end.block).toEqual({ type: 'tool-call', id: 'call_1', name: 'run', arguments: JSON.stringify({ input: { a: 1 } }) })
    expect(chunks[4]).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
  })

  it('reports EMPTY_RESPONSE when a completed response has no blocks', async () => {
    const chunks = await collect([DONE])
    expect(chunks).toEqual([
      { type: 'finish', reason: { kind: 'error', failure: { message: 'model returned a completed response with no content', code: 'EMPTY_RESPONSE' } } },
    ])
  })

  it('throws MALFORMED_RESPONSE on non-JSON payloads', async () => {
    const gen = translate(payloads(['not json']))
    await expect(async () => { for await (const _ of gen) { /* drain */ } }).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
  })
})

describe('tool-call identity on continuation fragments', () => {
  const frame = (call: unknown) => JSON.stringify({ choices: [{ delta: { tool_calls: [call] } }] })

  it('keeps the established id/name when a continuation repeats them as null', async () => {
    // CodeBuddy 只在首帧发身份，续帧会以 null 重复表示「无更新」。
    // 旧实现先测 .length 而不测 typeof，null 会让整个请求以 TypeError 崩掉。
    const chunks = await collect([
      frame({ index: 0, id: 'call_9', function: { name: 'run', arguments: '{"a"' } }),
      frame({ index: 0, id: null, function: { name: null, arguments: ':1}' } }),
      DONE,
    ])
    const end = chunks.find(c => (c as { type: string }).type === 'block-end') as {
      block: { type: string; id: string; name: string; arguments: string }
    }
    expect(end.block).toEqual({ type: 'tool-call', id: 'call_9', name: 'run', arguments: '{"a":1}' })
  })

  it('keeps the established id/name when a continuation repeats them as empty strings', async () => {
    const chunks = await collect([
      frame({ index: 0, id: 'call_8', function: { name: 'run', arguments: '{}' } }),
      frame({ index: 0, id: '', function: { name: '', arguments: '' } }),
      DONE,
    ])
    const end = chunks.find(c => (c as { type: string }).type === 'block-end') as {
      block: { id: string; name: string }
    }
    expect(end.block.id).toBe('call_8')
    expect(end.block.name).toBe('run')
  })

  it('still adopts an identity supplied by a later fragment', async () => {
    // null/空值表示「无更新」，但一个真正的新值仍须被接受（首帧可能缺身份）。
    const chunks = await collect([
      frame({ index: 0, function: { arguments: '{}' } }),
      frame({ index: 0, id: 'late_id', function: { name: 'late_name' } }),
      DONE,
    ])
    const end = chunks.find(c => (c as { type: string }).type === 'block-end') as {
      block: { id: string; name: string }
    }
    expect(end.block.id).toBe('late_id')
    expect(end.block.name).toBe('late_name')
  })
})
