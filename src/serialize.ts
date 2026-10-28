import { contentHasImage, LlmError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, RequestMessage } from '@deepseek-ai/dsh-llm'
import { rewriteHarnessIdentity } from './channel-fingerprint.js'
import type { WireMessage, WireRequest, WireTool } from './types.js'

/**
 * 把内容块里的文本按顺序拼起来。
 *
 * 导出：适配器判定指纹时也要按同一种方式取文本（`options.system` 与 system
 * 消息两条来路），各写一份 filter/map/join 迟早漂移——序列化改了取法，指纹
 * 读数还按旧规则，诊断就会说谎。
 */
export function flattenText(blocks: readonly ContentBlock[]): string {
  return blocks.filter(block => block.type === 'text').map(block => block.text).join('')
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

/**
 * 把会话消息序列化成 CodeBuddy 的线上格式。
 * @param messages - 按会话顺序排好的消息。
 * @param supportsImages - 选中的模型是否声明了图片输入。
 * @param hasTools - 本次请求是否带工具（决定历史 assistant 是否回传 reasoning_content）。
 * @param rewriteIdentity - 是否破坏渠道校验的身份指纹。缺省按官方端点处理（改写）；
 * 自建网关/代理没有那道校验，应显式传 false，让它们看到 dsh 真正组装的提示。
 * @returns 线上格式的消息。
 */
export function serializeMessages(
  messages: readonly RequestMessage[],
  supportsImages: boolean,
  hasTools: boolean,
  rewriteIdentity = true,
): WireMessage[] {
  const wire: WireMessage[] = []
  for (const message of humanInputLast(messages)) {
    // RequestUserInput（role:'user'、无 source）与 UserMessage 共用 user 分支。
    assertSupportedContent(message.content, supportsImages)
    if (message.role === 'system') {
      const content = flattenText(message.content)
      wire.push({ role: 'system', content: rewriteIdentity ? rewriteHarnessIdentity(content) : content })
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

/**
 * 把一次生成请求序列化成 CodeBuddy 的线上格式。
 * @param options - 宿主组装的生成请求。
 * @param supportsImages - 选中的模型是否声明了图片输入。
 * @param rewriteIdentity - 是否破坏渠道校验的身份指纹；见 {@link serializeMessages}。
 * @returns 线上格式的请求。
 */
export function serializeRequest(options: GenerateOptions, supportsImages: boolean, rewriteIdentity = true): WireRequest {
  const messages: WireMessage[] = []
  if (options.system !== undefined) {
    messages.push({ role: 'system', content: rewriteIdentity ? rewriteHarnessIdentity(options.system) : options.system })
  }
  messages.push(...serializeMessages(options.messages, supportsImages, options.tools !== undefined && options.tools.length > 0, rewriteIdentity))
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
