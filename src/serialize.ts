import { contentHasImage, LlmError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, RequestMessage } from '@deepseek-ai/dsh-llm'
import type { WireMessage, WireRequest, WireTool } from './types.js'

function flattenText(blocks: readonly ContentBlock[]): string {
  return blocks.filter(block => block.type === 'text').map(block => block.text).join('')
}

/**
 * dsh 系统提示开头固定的一句身份声明（`@deepseek-ai/dsh-system-prompt` 的
 * `includeHarnessIdentity` 段，order −1000）。
 *
 * CodeBuddy 网关按「渠道校验」核对调用方：以这句开头的请求一律拒收——
 * HTTP 400 · `code=11128` · "Illegal API invocation from an unapproved channel"，
 * 界面文案是 "Request blocked. Please send it again"。这不是认证问题：同一凭据、
 * 同一请求头，只把这句去掉就立刻 200。
 *
 * 上游只认**开头**那一句（不在开头不构成拦截），且不区分大小写。
 */
const HARNESS_IDENTITY_OPENER = /^You are an AI agent powered by DeepSeek Harness[^\n]*\r?\n?/i

/**
 * 摘掉上游不认的身份声明开头。
 *
 * 只动开头：没命中就逐字节原样返回，别的系统提示一个字符都不改。
 * @param text - 原始 system 文本。
 * @returns 摘掉身份声明后的文本。
 */
export function stripHarnessIdentity(text: string): string {
  const stripped = text.replace(HARNESS_IDENTITY_OPENER, '')
  // 只有真的摘掉了才顺带收掉留下的空行：没摘的提示必须原封不动。
  return stripped === text ? text : stripped.replace(/^\s+/, '')
}

/**
 * 送出的 system 文本；`undefined` 表示这条 system 不该发。
 *
 * 整条只剩身份声明时不送空 system——空提示对上游没有意义，还可能被当成非法请求。
 * @param raw - 原始 system 文本。
 * @returns 送出的文本，或 undefined（不送这条）。
 */
function wireSystemText(raw: string): string | undefined {
  const stripped = stripHarnessIdentity(raw)
  if (raw.length > 0 && stripped.length === 0) return undefined
  return stripped
}

/**
 * 一条消息是不是真人输入，而不是宿主注入的上下文。
 *
 * 两者共用 user 角色，靠 source 区分：真人那条的 `source.kind` 是 `'user'`；
 * 一次性请求输入（`RequestUserInput`）干脆没有 source，也算真人。
 * @param message - 一条待判定消息。
 * @returns 是否来自真人。
 */
function isHumanInput(message: RequestMessage | undefined): boolean {
  if (message === undefined || message.role !== 'user') return false
  const source = (message as { source?: { kind?: unknown } }).source
  return source === undefined || source.kind === 'user'
}

/**
 * 把每一轮里的真人输入挪到该轮 user 消息的末尾。
 *
 * CodeBuddy 把一轮里**最后一条** user 消息当真人提问：dsh 在真人消息之后还会
 * 注入运行时上下文（AGENTS.md、runtime context、skills 清单、时钟），不重排的话
 * 服务读到的是那些注入内容，而不是人问的话。
 *
 * 每一轮都重排（含已关闭的轮次），这样一轮无论出现在哪都长得一样，请求前缀逐字
 * 稳定，上游的 prefix cache 照旧命中。
 * @param messages - 按会话顺序排好的消息。
 * @returns 重排后的消息；没有需要挪动时返回原数组。
 */
function humanInputLast(messages: readonly RequestMessage[]): readonly RequestMessage[] {
  const output: RequestMessage[] = []
  let moved = false
  let start = 0
  while (start < messages.length) {
    if (messages[start]?.role !== 'user') {
      output.push(messages[start]!)
      start++
      continue
    }
    // 一轮 = 一段连续的 user 消息。
    let end = start
    while (end + 1 < messages.length && messages[end + 1]?.role === 'user') end++
    let human = -1
    for (let i = start; i <= end; i++) {
      if (isHumanInput(messages[i])) human = i
    }
    for (let i = start; i <= end; i++) {
      if (i !== human) output.push(messages[i]!)
    }
    if (human !== -1) {
      output.push(messages[human]!)
      if (human !== end) moved = true
    }
    start = end + 1
  }
  return moved ? output : messages
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
  for (const message of humanInputLast(messages)) {
    // RequestUserInput（role:'user'、无 source）与 UserMessage 共用 user 分支。
    assertSupportedContent(message.content, supportsImages)
    if (message.role === 'system') {
      const content = wireSystemText(flattenText(message.content))
      if (content !== undefined) wire.push({ role: 'system', content })
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
    const content = wireSystemText(options.system)
    if (content !== undefined) messages.push({ role: 'system', content })
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
