import {
  attributionHeaders, CONTEXT_WINDOW_EXCEEDED_CODE, isContextWindowExceededError, isQuotaExceededError,
  LlmAdapter, LlmError, ProviderRequestId, QUOTA_EXCEEDED_CODE, ReasoningEffortId,
} from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmModelReasoningInfo, LlmProviderInfo, LlmReasoningEffortInfo, LlmResolvedModelInfo, ResolvedRetryPolicy, StreamChunk } from '@deepseek-ai/dsh-llm'
import { deadline, idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { CODEBUDDY_DISPLAY_NAME, CODEBUDDY_PRODUCT, CODEBUDDY_REPO_URL, PACKAGE_NAME, RATE_LIMIT_WAIT_CAP_MS, REQUEST_TIMEOUT_MS } from './constants.js'
import { serializeRequest } from './serialize.js'
import { NotLoggedInError, SessionUnavailableError } from './session.js'
import type { CodeBuddySession } from './session.js'
import { resetAtFromText } from './reset-time.js'
import { parseSse } from './sse.js'
import { translate } from './translate.js'
import { hasDisclosedCapacity } from './types.js'
import type { CodeBuddyModel, WireError } from './types.js'

export interface CodeBuddyConnectionOptions {
  baseURL: string
  defaultContextWindow: number
  defaultMaxTokens: number
  streamIdleTimeoutMs: number
  /** 随路由注册一起捕获的重试策略；省略时由宿主默认接管。 */
  retryPolicy?: ResolvedRetryPolicy
}

export interface CodeBuddyAdapterOptions {
  session: CodeBuddySession
  options: () => CodeBuddyConnectionOptions
  /**
   * 当前生效的界面语言，失败时每次重新询问，故切换语言无需重新注册。
   * BCP 47 标签；缺省按英文。
   */
  language?: () => string | undefined
  /**
   * 遇到 429 是否等待到报文给出的重置时刻再让宿主重试。缺省**不等**。
   *
   * 每次请求现读而不是构造时捕获：开关是 volatile Config 字段，由 loader 就地
   * 提交，不重走 apply，捕获一次会永远读到旧值。
   *
   * 关（或缺省）时不挂等待，失败码仍是可重试的 RATE_LIMIT——宿主持本地退避
   * 快速重试几次后抛出，报文里的重置时刻随 message 原样保留。另有一个 5 小时
   * 硬上限（{@link RATE_LIMIT_WAIT_CAP_MS}）与开关无关：读出的等待超过它时，
   * 纵然开关开着也不等。
   */
  waitOnRateLimit?: () => boolean
  /**
   * 诊断出口（宿主日志）。只在「服务说稍后再试，却没说什么时候」时用一次：
   * 那条日志留下服务当时到底发了什么，下次就能照实核对，而不必再猜。
   */
  warn?: (message: string) => void
}

import { createRequire } from 'node:module'
const { version } = createRequire(import.meta.url)('../package.json') as { version: string }
const APP_IDENTITY = { product: CODEBUDDY_PRODUCT, version, url: CODEBUDDY_REPO_URL }
const CONNECT_TIMEOUT_CODE = 'LLM_CONNECT_TIMEOUT'
const STREAM_IDLE_TIMEOUT_CODE = 'LLM_STREAM_IDLE_TIMEOUT'

function requestId(headers: Headers): ReturnType<typeof ProviderRequestId> | undefined {
  const value = headers.get('x-request-id') ?? headers.get('x-requestid')
  return value === null || value.length === 0 ? undefined : ProviderRequestId(value)
}

function providerRetryAfterMs(value: string | null): number | undefined {
  if (value === null) return undefined
  if (/^\d+$/.test(value)) {
    const delay = Number(value) * 1_000
    return Number.isFinite(delay) && delay > 0 ? delay : undefined
  }
  const delay = Date.parse(value) - Date.now()
  return Number.isFinite(delay) && delay > 0 ? delay : undefined
}

/** 秒级时间戳 + 两侧时钟可能有偏差：多等 1 秒，不卡在重置边界的那一毫秒上。 */
const RESET_MARGIN_MS = 1_000

/**
 * 读整个 body 为文本；读不出来时给 undefined——状态码本身仍能标识这次失败。
 *
 * 先整段读文本、再自己 `JSON.parse`，而不是 `response.json()`：重置时刻被服务写进
 * 成句文案里（见 reset-time.ts），所以畸形 JSON 也必须能从中把它读出来。
 * @param response - 非 2xx 回复。
 * @returns body 原文，或读不出来时的 undefined。
 */
async function readBodyText(response: Response): Promise<string | undefined> {
  try {
    return await response.text()
  } catch {
    return undefined
  }
}

/**
 * 服务报文里的重置时刻 → `providerRetryAfterMs`。
 *
 * 只认 429：那是「稍后再试」的状态码，而别的状态码报文里的日期更像叙述而非调度指令。
 * @param status - 上游 HTTP 状态。
 * @param body - 原始 body 文本。
 * @param now - 计算等待时长的基准，可注入以便测试。
 * @returns 距重置的毫秒数（含 {@link RESET_MARGIN_MS}）；读不出时刻时 undefined。
 */
function waitUntilResetMs(status: number, body: string | undefined, now: number = Date.now()): number | undefined {
  if (status !== 429) return undefined
  const resetAt = resetAtFromText(body, now)
  return resetAt === undefined ? undefined : Math.max(1, resetAt - now + RESET_MARGIN_MS)
}

/** 诊断用的一行 body：太长就截断，读不出来时如实说明。 */
function bodyForLog(body: string | undefined): string {
  if (body === undefined) return '<unreadable body>'
  return body.length <= 512 ? body : `${body.slice(0, 512)}…`
}

/**
 * 上游把厂商侧的瞬时校验失败包装成 HTTP 400 抛回来的那一种 code。
 *
 * 那是服务端故障窗口，同构请求稍后重发即成功。宿主只重试 RATE_LIMIT/SERVER/
 * TIMEOUT/TRANSPORT，400 一律不重试——所以这个码得由插件自己认。
 */
const TRANSIENT_UPSTREAM_CODE = 11133

/** 瞬时 400 的退避重发间隔；用完最后一次就放弃，把失败原样抛给宿主。 */
const TRANSIENT_RETRY_DELAYS_MS: readonly number[] = [1_000, 4_000, 10_000, 25_000]

/**
 * 报文是不是「稍后重发就好」的那一种瞬时失败。
 *
 * 只认 code=11133：别的 400（参数解析错误、渠道校验拦截等）重发多少次都是同一个
 * 结果，重试只是把一次失败拖成几十秒。
 * @param body - 原始 body 文本。
 * @returns 是否值得退避后重发。
 */
function isTransientUpstreamFailure(body: string | undefined): boolean {
  if (body === undefined) return false
  try {
    const parsed = JSON.parse(body) as { code?: unknown }
    return parsed?.code === TRANSIENT_UPSTREAM_CODE
  } catch {
    return false
  }
}

/**
 * 可被 caller 的 signal 打断的等待。
 * @param ms - 等待毫秒数。
 * @param signal - caller 的取消信号，可为 undefined。
 * @returns 等待结束后的 resolve。
 */
function waitMs(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortedByCaller(new Error('aborted'))); return }
    const onAbort = () => { clearTimeout(timer); reject(abortedByCaller(new Error('aborted'))) }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve() }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * 第一个携带非空文本的条目。
 *
 * 这里的类型检测是**承重**的，不是防御性冗余：按上报的语言 id 去查 `displayMsg`
 * 可能命中 `Object.prototype` 的继承成员（上报 `constructor` 就会取到那个函数），
 * 此时对它调 `.trim` 会抛错——从而丢掉整个信封、把错误码降级。
 */
function firstText(values: readonly unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return undefined
}

/** 一个失败信封的价值：要上报的一句话，以及供分类器读的文本。 */
interface WireFailure {
  /** 上报语言下的成句文案，其次才是服务自己的字段。 */
  message?: string
  /**
   * 信封携带的所有字段拼在一起。分类器匹配的是英文标识符子串，而各自读的字段不同：
   * 成句的 `displayMsg` 装着溢出措辞，provider 的 `msg` 装着配额措辞。
   */
  detail: string
}

/**
 * 一个语言 id 可能命名的 `displayMsg` 键，最优者在前。
 *
 * 服务把繁中文案只放在 `zh-hant` 下，而语言包按地区选它（`zh-TW`/`zh-HK`/`zh-MO`），
 * 所以这些 id 必须能到达该脚本键。按 `zh` 去读会让繁体读者收到简体。
 */
function wordingKeys(language: string | undefined): readonly string[] {
  const key = language?.trim().toLowerCase()
  if (key === undefined || key.length === 0) return []
  if (key === 'zh-tw' || key === 'zh-hk' || key === 'zh-mo') return [key, 'zh-hant']
  return [key]
}

/**
 * 读一个失败信封；body 不可读时什么都不给——状态码本身仍能标识这次失败。
 * @param body - 解析出的错误 body。
 * @param language - 用哪种语言上报服务的文案。
 */
function readWireFailure(body: WireError, language: string | undefined): WireFailure {
  const provider = body.extError
  const display = body.displayMsg
  const compatible = body.error
  // 上报的语言 id 直接命名键；英文作为服务自己的默认。
  const curated = firstText([
    ...wordingKeys(language).map(key => display?.[key]),
    display?.en,
    display?.zh,
  ])
  const message = curated ?? firstText([
    body.msg,
    provider?.message,
    compatible?.message,
  ])
  const detail = [
    body.code === undefined ? undefined : String(body.code),
    body.msg,
    provider?.code,
    provider?.type,
    provider?.param,
    provider?.message,
    display?.en,
    display?.zh,
    display?.['zh-hant'],
    compatible?.code,
    compatible?.type,
    compatible?.message,
  ].filter(value => value !== undefined && value.length > 0).join(' ')
  return { ...message === undefined ? {} : { message }, detail }
}

/**
 * 把 HTTP 状态映射为稳定的宿主错误码。
 * @param status - 非 2xx 状态。
 * @param detail - 回复携带的全部错误措辞，可读时。
 * @returns 归一化后的错误码。
 */
export function httpErrorCode(status: number, detail?: string): string {
  if (status === 401 || status === 403) return 'AUTH'
  const text = detail ?? ''
  if (isQuotaExceededError(text)) return QUOTA_EXCEEDED_CODE
  if (status === 429) return 'RATE_LIMIT'
  if (status === 400) {
    if (isContextWindowExceededError(text)) return CONTEXT_WINDOW_EXCEEDED_CODE
    return 'INVALID_REQUEST'
  }
  if (status >= 500) return 'SERVER'
  return `HTTP_${status}`
}

/**
 * 失败码的最后一道判断：429 且服务给出了「何时可再试」= 限流，而不是额度用尽。
 *
 * 为什么不让措辞分类器抢这条：聊天界面按 code 把 QUOTA 换掉——`message.failure.quota`
 * 是一句通用文案，服务写在 displayMsg 里的重置时刻会在界面上**消失**，而那个时刻
 * 正是用户唯一能知道「还要等多久」的地方。限流既可重试，又保住了这句话。
 * @param status - 非 2xx 状态。
 * @param detail - 回复携带的全部错误措辞，可读时。
 * @param resetWaitMs - 从报文里读出的到重置的等待；读不出时 undefined。
 * @returns 归一化后的错误码。
 */
export function failureCode(status: number, detail: string | undefined, resetWaitMs: number | undefined): string {
  if (status === 429 && resetWaitMs !== undefined) return 'RATE_LIMIT'
  return httpErrorCode(status, detail)
}

/** 未登录（NotLoggedInError）统一映射为宿主唯一认识的 MISSING_CREDENTIAL 形状；其余错误原样上抛。 */
function throwMissingCredential(error: unknown): never {
  if (error instanceof NotLoggedInError) {
    throw new LlmError(error.message, 'MISSING_CREDENTIAL', { cause: error })
  }
  if (error instanceof SessionUnavailableError) {
    // 凭据根本没被裁决——刷新端点不可达。TRANSPORT 在默认可重试集合里，
    // 所以宿主会重试，而不是叫用户重新登录。
    throw new LlmError(error.message, 'TRANSPORT', { cause: error })
  }
  throw error
}

/** caller 取消的公共错误形状：连接阶段与流读取阶段共用。 */
function abortedByCaller(error: unknown): LlmError {
  return new LlmError('CodeBuddy request aborted by caller', 'ABORTED', { cause: error })
}

function modelInfo(provider: string, model: CodeBuddyModel): LlmModelInfo {
  const credits = model.credits?.trim()
  return {
    provider,
    id: model.id,
    name: model.name,
    ...credits === undefined || credits.length === 0 ? {} : { description: credits },
    inputModalities: model.supportsImages === true ? ['text', 'image'] : ['text'],
  }
}

/**
 * 把 CodeBuddy 披露的思考等级翻译成宿主的 reasoning 元数据；
 * 模型根本不思考时返回 `undefined`。
 *
 * 等级按不透明 id 原样透传，而非映射到固定刻度：它们正是 chat 端点接受的
 * `reasoning_effort`，所以 CodeBuddy 以后新增等级无需改这里的代码。
 *
 * **不在列表里的等级也要声明**：一个模型可以只说出自己恒定的那一个等级、
 * 不提供可选项（真实目录里 `auto`/`glm-5.1`/`kimi-k2.6` 等 7 个模型就是这样，
 * 另有 `kimi-k2.8-preview` 是 `supportsReasoning: true` 但完全没有 reasoning 块）。
 * 只读列表会让这些模型的请求**不带任何思考等级**；而声明为空又会让宿主拒绝
 * 一个点名了该等级的调用者。
 */
function reasoningInfo(model: CodeBuddyModel): LlmModelReasoningInfo | undefined {
  const reasoning = model.reasoning
  const capable = model.supportsReasoning === true
    || model.onlyReasoning === true
    || (reasoning?.supportedEfforts?.length ?? 0) > 0
  if (!capable) return undefined

  const seen = new Set<string>()
  const efforts: LlmReasoningEffortInfo[] = []
  const declare = (id: string): void => {
    if (seen.has(id)) return
    seen.add(id)
    efforts.push({ id: ReasoningEffortId(id), name: id })
  }
  for (const raw of reasoning?.supportedEfforts ?? []) {
    const id = typeof raw === 'string' ? raw.trim() : ''
    if (id.length > 0) declare(id)
  }

  // 调用者不选时请求携带的等级：优先服务端**当前**的 `effort`，其次 `defaultEffort`，
  // 最后才落到第一个可选项。必须声明进列表——宿主会拒绝一个它找不到的默认值，
  // 而「点名一个等级」正是模型表达「我一直这么思考」的方式。
  const active = reasoning?.effort?.trim()
  const preferred = reasoning?.defaultEffort?.trim()
  const resolved = active !== undefined && active.length > 0 ? active
    : preferred !== undefined && preferred.length > 0 ? preferred
      : efforts[0]?.id
  if (resolved === undefined) return undefined
  declare(resolved)

  // 始终设置：该等级本来就是模型会用的，宿主会把它物化进每个省略选择的请求。
  return { efforts, defaultEffort: ReasoningEffortId(resolved) }
}

export class CodeBuddyAdapter extends LlmAdapter {
  constructor(private readonly config: CodeBuddyAdapterOptions) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: CODEBUDDY_DISPLAY_NAME }
  }

  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy | undefined {
    return this.config.options().retryPolicy
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const models = await this.config.session.modelsOrEmpty()
    return models.filter(model => hasDisclosedCapacity(model)).map(model => modelInfo(provider, model))
  }

  override async resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    const connection = this.config.options()
    let models: readonly CodeBuddyModel[]
    try {
      models = await this.config.session.models(signal)
    } catch (error) {
      throwMissingCredential(error)
    }
    const entry = models.find(candidate => candidate.id === model)
    if (entry === undefined) {
      return {
        provider, id: model, name: model, inputModalities: ['text'],
        context: { contextWindow: connection.defaultContextWindow },
        defaultMaxTokens: connection.defaultMaxTokens,
      }
    }
    const reasoning = reasoningInfo(entry)
    return {
      ...modelInfo(provider, entry),
      context: { contextWindow: entry.maxAllowedSize !== undefined && entry.maxAllowedSize > 0 ? entry.maxAllowedSize : connection.defaultContextWindow },
      defaultMaxTokens: entry.maxOutputTokens !== undefined && entry.maxOutputTokens > 0 ? entry.maxOutputTokens : connection.defaultMaxTokens,
      ...reasoning === undefined ? {} : { reasoning },
    }
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const connection = this.config.options()
    let authHeaders: Record<string, string>
    try {
      authHeaders = await this.config.session.authHeaders()
    } catch (error) {
      throwMissingCredential(error)
    }
    // X-Conversation-ID 供服务端做亲和路由与 prefix-cache 复用：盖上宿主每会话 id，
    // 让同一会话的每一轮都落在同一条路由上（opencode 同款插件亦发此头）。
    // X-Model-ID 显式声明本次路由到的模型，便于服务端按模型分账与限流。
    const headers = {
      ...authHeaders,
      'content-type': 'application/json',
      'accept': 'text/event-stream',
      ...attributionHeaders(APP_IDENTITY),
      ...options.sessionId === undefined ? {} : { 'X-Conversation-ID': options.sessionId },
      'X-Model-ID': options.model,
    }
    const models = await this.config.session.models(options.signal)
    const entry = models.find(candidate => candidate.id === options.model)
    const supportsImages = entry?.supportsImages === true
    if (options.tools !== undefined && options.tools.length > 0 && entry?.supportsToolCall === false) {
      throw new LlmError(`CodeBuddy model "${options.model}" does not support tool calls`, 'UNSUPPORTED_OPTION')
    }
    const body = JSON.stringify(serializeRequest(options, supportsImages))
    // 连接死线只护「建立连接 + 等响应头」这一阶段；响应体是长生命 SSE，由下面的
    // idleWatchdog 管，绝不能让一个总时长窗口在模型推理中途 abort 掉 body。
    let response!: Response
    let failureBody: string | undefined
    for (let attempt = 0; ; attempt++) {
      const connect = deadline(options.signal, REQUEST_TIMEOUT_MS, CONNECT_TIMEOUT_CODE)
      try {
        response = await fetch(`${connection.baseURL}/chat/completions`, {
          method: 'POST', headers, body, signal: connect.signal,
        })
      } catch (error: unknown) {
        // 先认自己的死线：timeoutOf 只匹配本 code，caller 自己的超时不会被误报成连接超时。
        if (timeoutOf(connect.signal, CONNECT_TIMEOUT_CODE) !== undefined) {
          throw new LlmError(`CodeBuddy connect timeout after ${REQUEST_TIMEOUT_MS}ms`, 'TIMEOUT', { cause: error })
        }
        if (options.signal?.aborted) throw abortedByCaller(error)
        throw new LlmError(`CodeBuddy request to ${connection.baseURL} failed`, 'TRANSPORT', { cause: error })
      } finally {
        // 响应头已到（或请求已失败）：连接死线使命完成，清掉 timer，body 读取不再受它约束。
        connect[Symbol.dispose]()
      }
      if (response.ok) break
      failureBody = await readBodyText(response)
      // 瞬时 400：退避后把同一个请求原样再发一次（同构请求重发即成功）。
      const retryDelay = TRANSIENT_RETRY_DELAYS_MS[attempt]
      if (retryDelay === undefined || !isTransientUpstreamFailure(failureBody)) break
      this.config.warn?.(`${PACKAGE_NAME}: CodeBuddy transient 400 (code ${TRANSIENT_UPSTREAM_CODE}); retrying in ${retryDelay}ms`)
      await waitMs(retryDelay, options.signal)
    }
    if (!response.ok) {
      let message = `CodeBuddy API error (HTTP ${response.status})`
      let failure: WireFailure = { detail: '' }
      // 在解析块之外询问：抛错的语言来源不能被误判成体型损坏的 body，
      // 那会把整个信封丢掉。
      let language: string | undefined
      try {
        language = this.config.language?.()
      } catch {
        // 语言只是装饰，失败本身不是。
      }
      const body = failureBody
      if (body !== undefined) {
        try {
          failure = readWireFailure(JSON.parse(body) as WireError, language)
          if (failure.message !== undefined) message = failure.message
        } catch {
          // 只吞错误 body 的解析失败：状态码仍能标识这次失败，畸形 JSON 不许把它盖掉；
          // 报文里的重置时刻照样读得出来——它就在这段文本里。
        }
      }
      // `Retry-After` 是明确的调度指令，优先采信；没有才去读文案里写的重置时刻。
      const delay = providerRetryAfterMs(response.headers.get('retry-after'))
        ?? waitUntilResetMs(response.status, body)
      if (response.status === 429 && delay === undefined) {
        // 服务说「稍后再试」却没说什么时候：把它的原文留一行给运维，下一次有据可查。
        this.config.warn?.(`${PACKAGE_NAME}: CodeBuddy 429 without a readable retry time: ${bodyForLog(body)}`)
      }
      // 429 等不等：先看 5 小时硬上限，再看开关，两样都具备才把等待交给宿主。
      // 不等时与普通可重试失败同路——不挂 providerRetryAfterMs，宿主持本地退避
      // 快速重试几次后抛出，报文里的重置时刻随 message 原样保留，主 agent 据此
      // 切换模型继续；用 QUOTA 会被界面换成通用文案，把那句话吃掉，故不用。
      // 非 429 的 Retry-After 不受这两个条件约束：那是服务对任何状态的调度指令。
      const honorProviderDelay = response.status !== 429
        || (delay !== undefined
          && delay <= RATE_LIMIT_WAIT_CAP_MS
          && this.config.waitOnRateLimit?.() === true)
      const id = requestId(response.headers)
      throw new LlmError(message, failureCode(response.status, failure.detail, delay), {
        status: response.status,
        ...honorProviderDelay && delay !== undefined ? { providerRetryAfterMs: delay } : {},
        ...id === undefined ? {} : { requestId: id },
      })
    }
    if (response.body === null) throw new LlmError('CodeBuddy API returned no response body', 'EMPTY_RESPONSE')
    const consumer = new AbortController()
    const upstream = options.signal === undefined ? consumer.signal : AbortSignal.any([options.signal, consumer.signal])
    using watchdog = idleWatchdog(upstream, connection.streamIdleTimeoutMs, STREAM_IDLE_TIMEOUT_CODE)
    const iterator = translate(parseSse(response.body), options.tools)[Symbol.asyncIterator]()
    let exhausted = false
    try {
      while (true) {
        const result = await watchdog.next(iterator)
        if (result.done) { exhausted = true; return }
        yield result.value
      }
    } catch (error: unknown) {
      if (timeoutOf(watchdog.signal, STREAM_IDLE_TIMEOUT_CODE) !== undefined) {
        throw new LlmError(`CodeBuddy stream idle timeout after ${connection.streamIdleTimeoutMs}ms`, 'TIMEOUT', { cause: error })
      }
      if (options.signal?.aborted) throw abortedByCaller(error)
      if (error instanceof LlmError) throw error
      throw new LlmError(`CodeBuddy API stream from ${connection.baseURL} failed`, 'TRANSPORT', { cause: error })
    } finally {
      consumer.abort('CodeBuddy stream consumer stopped')
      if (!exhausted && iterator.return !== undefined) { try { await iterator.return(undefined) } catch {} }
    }
  }
}
