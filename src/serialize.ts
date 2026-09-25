import { contentHasImage, LlmError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, RequestMessage } from '@deepseek-ai/dsh-llm'
import type { WireMessage, WireRequest, WireTool } from './types.js'

function flattenText(blocks: readonly ContentBlock[]): string {
  return blocks.filter(block => block.type === 'text').map(block => block.text).join('')
}

function assertSupportedContent(blocks: readonly ContentBlock[], supportsImages: boolean): void {
  if (!supportsImages && contentHasImage(blocks)) {
    throw new LlmError('The selected CodeBuddy model does not accept image content.', 'UNSUPPORTED_CONTENT')
  }
}

function serializeAssistant(message: Extract<RequestMessage, { role: 'assistant' }>, hasTools: boolean): WireMessage {
  const text = flattenText(message.content)
  const reasoning = message.content.filter(block => block.type === 'reasoning').map(block => block.text).join('')
  const toolCalls = message.content.filter(block => block.type === 'tool-call').map(block => ({
    id: block.id as unknown as string,
    type: 'function' as const,
    function: { name: block.name, arguments: block.arguments },
  }))
  return {
    role: 'assistant',
    content: text,
    // thinking-mode 语义：携带 tools 的请求必须完整回传历史 reasoning_content，
    // 即使该轮无 tool_calls（否则 API 400）；不带 tools 时无需回传（API 忽略）。
    ...hasTools && reasoning.length > 0 ? { reasoning_content: reasoning } : {},
    ...toolCalls.length > 0 ? { tool_calls: toolCalls } : {},
  }
}

export function serializeMessages(messages: readonly RequestMessage[], supportsImages: boolean, hasTools: boolean): WireMessage[] {
  const wire: WireMessage[] = []
  for (const message of messages) {
    // RequestUserInput（role:'user'、无 source）与 UserMessage 共用 user 分支。
    assertSupportedContent(message.content, supportsImages)
    if (message.role === 'system') {
      wire.push({ role: 'system', content: flattenText(message.content) })
      continue
    }
    if (message.role === 'assistant') {
      wire.push(serializeAssistant(message, hasTools))
      continue
    }
    if (message.role === 'tool') {
      // 0.1.7：工具结果是一等 role:'tool' 消息（toolCallId + content），不再是
      // user 消息里的 tool-result block。OpenAI wire 仍是 role:'tool' + tool_call_id。
      wire.push({
        role: 'tool',
        tool_call_id: message.toolCallId as unknown as string,
        content: flattenText(message.content) || '(no output)',
      })
      continue
    }
    wire.push({ role: 'user', content: flattenText(message.content) })
  }
  return wire
}

export function serializeRequest(options: GenerateOptions, supportsImages: boolean): WireRequest {
  const messages: WireMessage[] = []
  if (options.system !== undefined) {
    messages.push({ role: 'system', content: options.system })
  }
  messages.push(...serializeMessages(options.messages, supportsImages, options.tools !== undefined && options.tools.length > 0))
  const tools: WireTool[] | undefined = options.tools?.map(tool => ({
    type: 'function' as const,
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }))
  return {
    model: options.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...tools !== undefined && tools.length > 0 ? { tools } : {},
    ...options.temperature === undefined ? {} : { temperature: options.temperature },
    ...options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens },
    ...options.stop === undefined ? {} : { stop: options.stop },
    ...options.reasoningEffort === undefined ? {} : { reasoning_effort: options.reasoningEffort as unknown as string },
  }
}
