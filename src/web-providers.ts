// ctx.web 的 CodeBuddy 后端（搜索 + 抓取）。
//
// 结构对齐上游参考包 @deepseek-ai/dsh-web-search-exa（provider.ts / types.ts 的
// 分层与约定）：
//   · id 导出为常量；wire 类型独立成 web-types.ts；
//   · redirect: 'error'（重定向在触碰目标前失败）；
//   · 中止分类：AbortError → WEB_ABORTED，其余 → WEB_PROVIDER_ERROR；
//   · 不捏造字段：缺失的可选字段一律省略，不编造；
//   · truncated 由 seam 负责（seam 按 request.maxResults 截断并自行置位），
//     故 provider 恒报 false。
//
// 与参考实现的两处刻意差异：
//   1. fetch 透传网关返回的真实 status_code（实测有值），而参考实现在注释里
//      断言「端点从不返回目标页状态码」并按恒 200 处理——那是过时的观察。
//   2. 搜索保留「有 url 但无 snippet」的条目：snippet 在 WebSearchSource 里是
//      可选的、且网关已在结果里直接给出该字段，丢弃会白丢可引用来源。
//      （Exa 之所以丢弃，是因为它只能从 highlights 里推导 snippet，无从推导
//       时必须丢弃；本网关没有这个约束。）

import { WebError } from '@deepseek-ai/dsh-web'
import type {
  WebFetchProvider,
  WebFetchRequest,
  WebFetchResult,
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from '@deepseek-ai/dsh-web'
import type { CodeBuddySession } from './session.js'
import { deadlineSignal } from './codebuddy.js'
import {
  AGENTTOOL_FETCH_PATH,
  AGENTTOOL_SEARCH_PATH,
  AGENTTOOL_USER_AGENT,
  CODEBUDDY_WEB_PROVIDER_ID,
} from './constants.js'
import type { AgentToolFetchResponse, AgentToolSearchResponse } from './web-types.js'

export { CODEBUDDY_WEB_PROVIDER_ID }

/**
 * 无调用方 signal 时的兜底死线。tool-web 会以自己的协作超时（搜索 60s /
 * 抓取 30s）传入 signal，那个 signal 总是更短、总是先触发；这里的兜底只用于
 * 「调用方完全没给 signal」的场合，避免出现真正无界的出站请求。
 */
export const AGENTTOOL_FALLBACK_DEADLINE_MS = 120_000

/** provider 的两个面共享的出站依赖。 */
export interface CodeBuddyWebProviderOptions {
  /** 取当前凭据（含临期自动刷新）。未登录时抛 NotLoggedInError。 */
  session: CodeBuddySession
  /** 会话配置里的聊天 baseURL；agenttool 挂在同一网关根下。 */
  gatewayRoot: string
  /**
   * 廉价的本地可用性判断（同步）。由 web-sync 维护的「已登录」缓存供给——
   * seam 契约要求 available() 不做网络调用，而读 grant 是异步的，故不能现读。
   */
  isAvailable: () => boolean
}

/**
 * agenttool 出站请求头。Authorization 与 X-Domain/X-User-Id/X-Enterprise-Id
 * 与登录 grant 同源（2026-09 实测：该组合在 /agenttool 上直接可用；
 * 仅 Bearer 亦可，但带上归属头与官方 CLI 行为一致）。
 */
function authHeaders(identity: { accessToken: string; domain: string; uid?: string; enterpriseId?: string }): Record<string, string> {
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${identity.accessToken}`,
    'X-Domain': identity.domain,
    'User-Agent': AGENTTOOL_USER_AGENT,
    'X-Requested-With': 'XMLHttpRequest',
    'Accept': 'application/json',
    'Content-Type': 'application/json',
  }
  if (identity.uid !== undefined) headers['X-User-Id'] = identity.uid
  if (identity.enterpriseId !== undefined) headers['X-Enterprise-Id'] = identity.enterpriseId
  return headers
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
}

/**
 * 把出站失败分类成 seam 的错误码。只有**调用方主动取消**才是 WEB_ABORTED；
 * 我们自己的兜底死线到点属于 provider 侧失败（WEB_PROVIDER_ERROR），
 * 与上游参考实现「只有调用方中止才判 WEB_ABORTED」的口径一致——
 * 用 signal.aborted 区分两者，而不是猜错误名。
 */
function transportError(path: string, error: unknown, signal: AbortSignal | undefined): WebError {
  const detail = causeChain(error)
  if (isAbortError(error) && signal?.aborted === true) {
    return new WebError(`CodeBuddy ${path} aborted`, 'WEB_ABORTED', { cause: error })
  }
  if (isAbortError(error)) {
    return new WebError(`CodeBuddy ${path} timed out after ${AGENTTOOL_FALLBACK_DEADLINE_MS}ms`, 'WEB_PROVIDER_ERROR', { cause: error })
  }
  return new WebError(`CodeBuddy ${path} network error: ${detail}`, 'WEB_PROVIDER_ERROR', { cause: error })
}

/**
 * 网络层错误的成因链。undici 把真实原因藏在 err.cause（ECONNRESET / 证书错误…），
 * 只报 "fetch failed" 无法排查——与项目内其余外呼同一处理。
 */
function causeChain(error: unknown): string {
  const parts: string[] = []
  for (let e: unknown = error; e !== undefined && e !== null; e = (e as { cause?: unknown }).cause) {
    const member = e as { code?: string; message?: string }
    parts.push(member.code ?? member.message ?? String(e))
  }
  return parts.join(' ← ')
}

async function callAgentTool(
  options: CodeBuddyWebProviderOptions,
  path: string,
  payload: unknown,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  let identity: Awaited<ReturnType<CodeBuddySession['identity']>>
  try {
    identity = await options.session.identity()
  } catch (error: unknown) {
    // 竞态：provider 已注册但凭据刚被清掉（登出事件与本次调用赛跑）。
    // 归一到带 code 的 seam 错误，别把裸 NotLoggedInError 漏给工具层。
    throw new WebError(
      `CodeBuddy ${path} has no usable credential: ${error instanceof Error ? error.message : String(error)}`,
      'WEB_PROVIDER_CREDENTIAL_MISSING',
      { cause: error },
    )
  }
  let response: Response
  try {
    response = await fetch(`${options.gatewayRoot}${path}`, {
      method: 'POST',
      // 网关是固定 HTTPS 端点，不应发生重定向；发生即视为异常而不是跟过去。
      redirect: 'error',
      headers: authHeaders(identity),
      body: JSON.stringify(payload),
      signal: deadlineSignal(signal, AGENTTOOL_FALLBACK_DEADLINE_MS),
    })
  } catch (error: unknown) {
    throw transportError(path, error, signal)
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    let detail = ''
    try {
      const parsed = JSON.parse(body) as { code?: number; msg?: string }
      if (parsed.code !== undefined) detail = ` code ${parsed.code}: ${parsed.msg ?? ''}`
    } catch { /* 非 JSON 错误体：下面的原文兜底 */ }
    throw new WebError(
      `CodeBuddy ${path} HTTP ${response.status}${detail !== '' ? detail : ` ${body.slice(0, 160)}`}`,
      'WEB_PROVIDER_ERROR',
    )
  }
  let parsed: unknown
  try {
    parsed = await response.json()
  } catch (error: unknown) {
    if (isAbortError(error)) throw transportError(path, error, signal)
    throw new WebError(`CodeBuddy ${path} returned an unprocessable response body: ${causeChain(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
  }
  // 网关用 200 + 信封内 code 报业务错，必须显式甄别（code 0 / 缺失为成功）。
  const envelope = parsed as { code?: number; msg?: string }
  if (envelope?.code !== undefined && envelope.code !== 0) {
    throw new WebError(`CodeBuddy ${path} error ${envelope.code}: ${envelope.msg ?? ''}`, 'WEB_PROVIDER_ERROR')
  }
  return parsed
}

/** 一条网关搜索结果 → 可引用来源；无 url 的条目丢弃（url 是 source 的必填项）。 */
export function mapSearchResult(result: { url?: string | null; title?: string | null; snippet?: string | null }): WebSearchSource | undefined {
  const url = typeof result.url === 'string' ? result.url : ''
  if (url.length === 0) return undefined
  return {
    url,
    ...typeof result.title === 'string' && result.title.length > 0 ? { title: result.title } : {},
    ...typeof result.snippet === 'string' && result.snippet.length > 0 ? { snippet: result.snippet } : {},
  }
}

/** 搜索结果响应 → seam 结果。截断归 seam，故 truncated 恒 false。 */
export function mapSearchResponse(response: AgentToolSearchResponse): WebSearchResult {
  const sources = (response.results ?? [])
    .map(mapSearchResult)
    .filter((source): source is WebSearchSource => source !== undefined)
  return { sources, truncated: false }
}

/** 抓取响应 → seam 结果；网关解码后的正文按 text 归类。 */
export function mapFetchResponse(response: AgentToolFetchResponse, requestUrl: string): WebFetchResult {
  const content = typeof response.content === 'string' ? response.content : ''
  const status = typeof response.status_code === 'number' && response.status_code > 0 ? response.status_code : 200
  return {
    url: typeof response.url === 'string' && response.url.length > 0 ? response.url : requestUrl,
    statusCode: status,
    body: { kind: 'text', content },
    truncated: response.truncated === true,
  }
}

/** CodeBuddy 网关搜索后端。 */
export class CodeBuddySearchProvider implements WebSearchProvider {
  readonly id = CODEBUDDY_WEB_PROVIDER_ID

  constructor(private readonly options: CodeBuddyWebProviderOptions) {}

  available(): boolean {
    return this.options.isAvailable()
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const payload: Record<string, unknown> = { query: request.query, type: 'text2text' }
    // maxResults 只作为成本/延迟优化下推；最终上限由 seam 强制。
    if (request.maxResults !== undefined) payload.max_results = request.maxResults
    const data = await callAgentTool(this.options, AGENTTOOL_SEARCH_PATH, payload, signal)
    return mapSearchResponse(data as AgentToolSearchResponse)
  }
}

/** CodeBuddy 网关抓取后端。 */
export class CodeBuddyFetchProvider implements WebFetchProvider {
  readonly id = CODEBUDDY_WEB_PROVIDER_ID

  constructor(private readonly options: CodeBuddyWebProviderOptions) {}

  available(): boolean {
    return this.options.isAvailable()
  }

  async fetch(request: WebFetchRequest, signal?: AbortSignal): Promise<WebFetchResult> {
    const data = await callAgentTool(this.options, AGENTTOOL_FETCH_PATH, { url: request.url }, signal)
    return mapFetchResponse(data as AgentToolFetchResponse, request.url)
  }
}
