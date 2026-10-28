import { describe, expect, it } from 'vitest'
import { buildChatHeaders } from '../src/chat-headers.js'

const auth = { Authorization: 'Bearer t', 'X-Domain': 'www.codebuddy.cn' }

describe('buildChatHeaders', () => {
  it('carries the credential through', () => {
    const headers = buildChatHeaders(auth, { model: 'm1' })
    expect(headers.Authorization).toBe('Bearer t')
    expect(headers['X-Domain']).toBe('www.codebuddy.cn')
  })

  it('declares the model and the streaming content type', () => {
    const headers = buildChatHeaders(auth, { model: 'm1' })
    expect(headers['X-Model-ID']).toBe('m1')
    expect(headers['content-type']).toBe('application/json')
    expect(headers.accept).toBe('text/event-stream')
  })

  it('sends the conversation id only when a session exists', () => {
    expect(buildChatHeaders(auth, { model: 'm1' })['X-Conversation-ID']).toBeUndefined()
    expect(buildChatHeaders(auth, { model: 'm1', sessionId: 's1' })['X-Conversation-ID']).toBe('s1')
  })

  it('sends the dsh attribution user-agent', () => {
    // 阶段二会把它换成 IDE 形态；此刻先钉住现状，让那次变更是一次可见的 diff。
    // 完整形态是 `product/version (+url)`：只钉前缀会放过版本/URL 漂移。
    expect(buildChatHeaders(auth, { model: 'm1' })['user-agent'])
      .toMatch(/^dsh-codebuddy\/\d+\.\d+\.\d+ \(\+https:\/\/github\.com\/minglo\/dsh-plugin-llm-codebuddy\)$/)
  })
})
