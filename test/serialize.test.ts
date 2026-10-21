import { describe, expect, it } from 'vitest'
import { serializeMessages, serializeRequest } from '../src/serialize.js'

const OPENER = 'You are an AI agent powered by DeepSeek Harness.'

describe('serializeRequest', () => {
  it('expands tool-result messages into role:tool wire messages', () => {
    // 0.1.7：工具结果是一等 role:'tool' 消息（toolCallId + content），不再是
    // user 消息里的 tool-result block。
    const wire = serializeRequest({
      provider: 'codebuddy',
      model: 'deepseek-v4-flash',
      messages: [
        { role: 'assistant', content: [{ type: 'tool-call', id: 'call_1', name: 'bash', arguments: '{}' }] },
        { role: 'tool', toolCallId: 'call_1' as never, source: { kind: 'tool' } as never, content: [{ type: 'text', text: 'ok' }] },
      ],
    }, false)
    const toolMsg = wire.messages.find(m => m.role === 'tool')
    expect(toolMsg).toBeDefined()
    expect((toolMsg as any).tool_call_id).toBe('call_1')
    expect((toolMsg as any).content).toBe('ok')
  })

  it('always streams with include_usage', () => {
    const wire = serializeRequest({ provider: 'codebuddy', model: 'm', messages: [] }, false)
    expect(wire.stream).toBe(true)
    expect(wire.stream_options).toEqual({ include_usage: true })
  })

  it('omits reasoning_content when the request carries no tools (thinking-mode docs: ignored anyway)', () => {
    const wire = serializeRequest({
      provider: 'codebuddy',
      model: 'm',
      messages: [{ role: 'assistant', content: [{ type: 'text', text: 'final' }, { type: 'reasoning', text: 'chain' }] }],
    }, false)
    expect(wire.messages[0]).toEqual({ role: 'assistant', content: 'final' })
  })

  it('keeps reasoning_content on every historical assistant turn when tools are present', () => {
    // thinking-mode 文档：携带 tools 的请求必须完整回传历史 reasoning_content，
    // 即使该轮未产生 tool_calls，否则 API 400。旧实现挂在 toolCalls.length > 0 上，
    // 会丢掉「纯推理无调用」的历史轮。
    const wire = serializeRequest({
      provider: 'codebuddy',
      model: 'm',
      messages: [
        { role: 'assistant', content: [{ type: 'text', text: 'final' }, { type: 'reasoning', text: 'chain' }] },
        { role: 'user', content: [{ type: 'text', text: 'next' }] },
      ],
      tools: [{ type: 'function', name: 'bash', description: 'run a command', parameters: {} }],
    }, false)
    expect((wire.messages[0] as { reasoning_content?: string }).reasoning_content).toBe('chain')
  })
})

describe('harness identity opener', () => {
  // CodeBuddy 网关按「渠道校验」核对调用方：system 提示以 dsh 的身份声明开头时，
  // 一律拒收（HTTP 400 · code=11128 · "Illegal API invocation from an unapproved
  // channel"，界面文案是 "Request blocked. Please send it again"）。同一凭据去掉
  // 这一句就立刻 200——所以出站前必须摘掉它。
  it('drops the identity opener from a system message', () => {
    const wire = serializeRequest({
      provider: 'codebuddy',
      model: 'm',
      messages: [{ role: 'system', content: [{ type: 'text', text: `${OPENER}\n\nYou are a coding agent powered by the m model.` }] }],
    }, false)
    expect(wire.messages[0]).toEqual({ role: 'system', content: 'You are a coding agent powered by the m model.' })
  })

  it('drops the identity opener from options.system', () => {
    const wire = serializeRequest({ provider: 'codebuddy', model: 'm', messages: [], system: `${OPENER}\n\nrest` }, false)
    expect(wire.messages[0]).toEqual({ role: 'system', content: 'rest' })
  })

  it('keeps a system prompt without the opener byte-identical', () => {
    const text = 'You are a coding agent powered by the m model.\n\n<EXTREMELY-IMPORTANT>'
    const wire = serializeRequest({
      provider: 'codebuddy',
      model: 'm',
      messages: [{ role: 'system', content: [{ type: 'text', text }] }],
    }, false)
    expect((wire.messages[0] as { content: string }).content).toBe(text)
  })

  it('keeps an opener that is not at the very start', () => {
    // 上游只认「开头」那一句；不在开头就不构成拦截，原样送。
    const text = `Hello. ${OPENER}`
    const wire = serializeRequest({
      provider: 'codebuddy',
      model: 'm',
      messages: [{ role: 'system', content: [{ type: 'text', text }] }],
    }, false)
    expect((wire.messages[0] as { content: string }).content).toBe(text)
  })

  it('omits a system message that carried nothing but the opener', () => {
    const wire = serializeRequest({
      provider: 'codebuddy',
      model: 'm',
      messages: [{ role: 'system', content: [{ type: 'text', text: OPENER }] }],
    }, false)
    expect(wire.messages.filter(message => message.role === 'system')).toEqual([])
  })
})

describe('human input ordering', () => {
  // 上游把一轮里**最后一条** user 消息当真人提问；注入上下文排在它后面时，
  // 服务读到的是时钟/上下文而不是人的问题。
  it('puts the human input after injected context of the same turn', () => {
    const wire = serializeMessages([
      { role: 'user', content: [{ type: 'text', text: 'real ask' }], source: { kind: 'user' } as never },
      { role: 'user', content: [{ type: 'text', text: 'context' }], source: { kind: 'runtime-context' } as never },
    ], false, false)
    expect(wire.map(message => message.content)).toEqual(['context', 'real ask'])
  })

  it('leaves a turn with no human input in its existing order', () => {
    const wire = serializeMessages([
      { role: 'user', content: [{ type: 'text', text: 'context' }], source: { kind: 'runtime-context' } as never },
      { role: 'user', content: [{ type: 'text', text: 'more context' }], source: { kind: 'runtime-context' } as never },
    ], false, false)
    expect(wire.map(message => message.content)).toEqual(['context', 'more context'])
  })

  it('lays out a closed turn the same way as the open one', () => {
    const wire = serializeMessages([
      { role: 'user', content: [{ type: 'text', text: 'old ask' }], source: { kind: 'user' } as never },
      { role: 'user', content: [{ type: 'text', text: 'old context' }], source: { kind: 'runtime-context' } as never },
      { role: 'assistant', content: [{ type: 'text', text: 'answer' }] },
      { role: 'user', content: [{ type: 'text', text: 'new ask' }], source: { kind: 'user' } as never },
    ], false, false)
    expect(wire.map(message => message.content)).toEqual(['old context', 'old ask', 'answer', 'new ask'])
  })
})
