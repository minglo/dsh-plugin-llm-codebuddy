import { EMPTY_RESPONSE_CODE, LlmError, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, FinishReason, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import { DONE } from './sse.js'
import type { WireChunk, WireUsage } from './types.js'

interface ToolDefinition { name: string; parameters: Record<string, unknown> }
interface ObjectSchema { properties?: Record<string, unknown> }

function acceptsAnyJsonValue(schema: unknown): boolean {
  if (schema === true) return true
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) return false
  const record = schema as Record<string, unknown>
  return !('type' in record) && !('$ref' in record) && !('const' in record) && !('enum' in record)
    && !('allOf' in record) && !('anyOf' in record) && !('oneOf' in record) && !('not' in record)
}

function decodeNestedComposite(value: unknown): unknown {
  if (typeof value !== 'string') return value
  const text = value.trim()
  if (!(text.startsWith('{') && text.endsWith('}')) && !(text.startsWith('[') && text.endsWith(']'))) return value
  try {
    const decoded: unknown = JSON.parse(text)
    return decoded !== null && typeof decoded === 'object' ? decoded : value
  } catch { return value }
}

export function normalizeToolArguments(name: string, argumentsText: string, tools: readonly ToolDefinition[]): string {
  const tool = tools.find(candidate => candidate.name === name)
  const properties = (tool?.parameters as ObjectSchema | undefined)?.properties
  if (properties === undefined) return argumentsText
  let args: unknown
  try { args = JSON.parse(argumentsText) } catch { return argumentsText }
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return argumentsText
  const record = args as Record<string, unknown>
  let changed = false
  for (const [key, schema] of Object.entries(properties)) {
    if (!acceptsAnyJsonValue(schema) || !(key in record)) continue
    const decoded = decodeNestedComposite(record[key])
    if (decoded !== record[key]) { record[key] = decoded; changed = true }
  }
  return changed ? JSON.stringify(record) : argumentsText
}

function isCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0
}

export function mapFinishReason(reason: string): FinishReason {
  switch (reason) {
    case 'stop': return { kind: 'stop' }
    case 'tool_calls': return { kind: 'tool-calls' }
    case 'length': return { kind: 'max-tokens' }
    default: return { kind: 'error', failure: { message: `model stopped: ${reason}`, code: reason.toUpperCase() } }
  }
}

/**
 * Map CodeBuddy wire usage to harness counts.
 *
 * CodeBuddy's `prompt_tokens` INCLUDES cache hits, while the harness
 * TokenUsage convention is DISJOINT counts, so cache reads are subtracted
 * out of `inputTokens`.
 *
 * `totalTokens` is emitted only when it can be proven: the aggregate
 * prompt/completion counters must be safe non-negative integers and any wire
 * total must agree with them. token-meter's turn fold rejects an attempt
 * whose usage carries neither an exact total nor BOTH cache buckets, so
 * omitting it here silently drops the whole turn's footer token stats.
 * @param usage - wire usage from the finish chunk or the trailing usage-only chunk.
 * @returns disjoint harness counts with a provable exact total when available.
 */
export function mapUsage(usage: WireUsage): TokenUsage {
  const cacheRead = usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens
  const reasoning = usage.completion_tokens_details?.reasoning_tokens
  const prompt = usage.prompt_tokens ?? 0
  const completion = usage.completion_tokens ?? 0
  const combined = prompt + completion
  const hasExactTotal = isCount(prompt) && isCount(completion) && Number.isSafeInteger(combined)
    && (usage.total_tokens === undefined || usage.total_tokens === combined)
  // 计数不可信（NaN/负数/非整数）时不只省略 totalTokens——outputTokens 同样不透传原值。
  return {
    inputTokens: isCount(prompt) ? Math.max(0, prompt - (cacheRead ?? 0)) : 0,
    outputTokens: isCount(completion) ? completion : 0,
    ...hasExactTotal ? { totalTokens: combined } : {},
    ...cacheRead === undefined ? {} : { cacheReadTokens: cacheRead },
    ...reasoning === undefined ? {} : { reasoningTokens: reasoning },
  }
}

/**
 * 接受 tool-call 的一个流式身份字段。
 *
 * `id` 与 `name` 是身份而非累加：线上只在首个分片发送一次，续帧以 `''` 或 `null`
 * 重复表示「无更新」，绝不是「清空」——若照此覆盖，就会把一个无名调用交给宿主，
 * 而宿主会以 UNKNOWN_TOOL 拒绝。线上类型只是对远端编码器的声明，所以只有
 * **非空字符串**才能取代已确立的值；先测 `.length` 而不测 `typeof` 会在 `null` 上抛错。
 * @param current - 早前分片确立的身份。
 * @param incoming - 本分片解析出的该字段。
 * @returns 本分片之后生效的身份。
 */
function acceptIdentity(current: string | undefined, incoming: string | null | undefined): string | undefined {
  return typeof incoming === 'string' && incoming.length > 0 ? incoming : current
}

/**
 * 一个正在组装的块。`callId`/`name` 显式接纳 `undefined`，因为身份助手在
 * 某个分片提供它之前会返回 `undefined`。
 */
interface OpenBlock {
  index: number
  kind: 'text' | 'reasoning' | 'tool-call'
  text: string
  callId?: string | undefined
  name?: string | undefined
}

function closeBlock(block: OpenBlock, tools: readonly ToolDefinition[]): ContentBlock {
  switch (block.kind) {
    case 'text': return { type: 'text', text: block.text }
    case 'reasoning': return { type: 'reasoning', text: block.text }
    case 'tool-call': return {
      type: 'tool-call',
      id: ToolCallId(block.callId ?? ''),
      name: block.name ?? '',
      arguments: normalizeToolArguments(block.name ?? '', block.text, tools),
    }
  }
}

export async function* translate(payloads: AsyncIterable<string>, tools: readonly ToolDefinition[] = []): AsyncGenerator<StreamChunk> {
  let nextIndex = 0
  let textBlock: OpenBlock | undefined
  let reasoningBlock: OpenBlock | undefined
  const toolBlocks = new Map<number, OpenBlock>()
  const order: OpenBlock[] = []
  let pendingFinish: FinishReason | undefined
  let pendingUsage: TokenUsage | undefined
  const open = (kind: OpenBlock['kind']): OpenBlock => {
    const block: OpenBlock = { index: nextIndex++, kind, text: '' }
    order.push(block)
    return block
  }
  for await (const payload of payloads) {
    if (payload === DONE) {
      for (const block of order) yield { type: 'block-end', index: block.index, block: closeBlock(block, tools) }
      if (pendingUsage !== undefined) yield { type: 'usage', usage: pendingUsage }
      const reason = pendingFinish ?? { kind: 'stop' as const }
      yield {
        type: 'finish',
        reason: reason.kind === 'stop' && order.length === 0
          ? { kind: 'error', failure: { message: 'model returned a completed response with no content', code: EMPTY_RESPONSE_CODE } }
          : reason,
      }
      return
    }
    let chunk: WireChunk
    try { chunk = JSON.parse(payload) as WireChunk } catch {
      throw new LlmError(`malformed CodeBuddy SSE payload: ${payload.slice(0, 120)}`, 'MALFORMED_RESPONSE')
    }
    for (const choice of chunk.choices ?? []) {
      const delta = choice.delta
      const reasoning = delta?.reasoning_content ?? delta?.reasoning
      if (typeof reasoning === 'string' && reasoning.length > 0) {
        if (reasoningBlock === undefined) {
          reasoningBlock = open('reasoning')
          yield { type: 'block-start', index: reasoningBlock.index, blockType: 'reasoning' }
        }
        reasoningBlock.text += reasoning
        yield { type: 'reasoning-delta', index: reasoningBlock.index, text: reasoning }
      }
      const content = delta?.content
      if (typeof content === 'string' && content.length > 0) {
        if (textBlock === undefined) {
          textBlock = open('text')
          yield { type: 'block-start', index: textBlock.index, blockType: 'text' }
        }
        textBlock.text += content
        yield { type: 'text-delta', index: textBlock.index, text: content }
      }
      for (const call of delta?.tool_calls ?? []) {
        let block = toolBlocks.get(call.index)
        if (block === undefined) {
          block = open('tool-call')
          toolBlocks.set(call.index, block)
          yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
        }
        // 只认身份；CodeBuddy 会在续帧把这两个字段清空。
        block.callId = acceptIdentity(block.callId, call.id)
        block.name = acceptIdentity(block.name, call.function?.name)
        const fragment = call.function?.arguments ?? ''
        block.text += fragment
        yield {
          type: 'tool-call-delta',
          index: block.index,
          id: ToolCallId(block.callId ?? ''),
          ...block.name === undefined ? {} : { name: block.name },
          argumentsDelta: fragment,
        }
      }
      if (typeof choice.finish_reason === 'string') pendingFinish = mapFinishReason(choice.finish_reason)
    }
    if (chunk.usage !== undefined && chunk.usage !== null) pendingUsage = mapUsage(chunk.usage)
  }
  throw new LlmError('CodeBuddy SSE payload stream ended without [DONE]', 'STREAM_CLOSED')
}
