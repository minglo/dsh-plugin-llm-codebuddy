import { describe, expect, it } from 'vitest'
import { parseSse, DONE } from '../src/sse.js'

function sse(lines: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  return new ReadableStream({
    start(c) { for (const l of lines) c.enqueue(enc.encode(l + '\n\n')); c.close() },
  })
}

describe('parseSse', () => {
  it('yields data payloads and the DONE sentinel', async () => {
    const out: string[] = []
    for await (const p of parseSse(sse(['data: {"a":1}', 'data: [DONE]']))) out.push(p)
    expect(out).toEqual(['{"a":1}', DONE])
  })

  it('throws STREAM_CLOSED on EOF without DONE', async () => {
    const it = parseSse(sse(['data: {"a":1}']))
    await expect(async () => { for await (const _ of it) { /* drain */ } }).rejects.toMatchObject({ code: 'STREAM_CLOSED' })
  })
})
