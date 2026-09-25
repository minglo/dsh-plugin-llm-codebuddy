import { describe, expect, it } from 'vitest'
import { serializeRequest } from '../src/serialize.js'

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
