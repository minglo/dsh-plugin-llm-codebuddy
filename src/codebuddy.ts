import { AUTH_PENDING_CODE, CODEBUDDY_ENDPOINT, CODEBUDDY_IDE_USER_AGENT, codeBuddyIdentityHeaders, LOGIN_POLL_INTERVAL_MS, LOGIN_TIMEOUT_MS, REQUEST_TIMEOUT_MS, withIdentityHeaders } from './constants.js'
import type { Account, AccountResponse, AuthState, AuthStateResponse, AuthToken, AuthTokenResponse, CodeBuddyConfig, ConfigResponse } from './types.js'

export interface CodeBuddyIdentity {
  accessToken: string
  domain: string
  uid?: string
  enterpriseId?: string
}

/**
 * 单次外呼硬超时：caller signal（若有）与 ms 死线合并成一个 fetch signal，
 * 覆盖 fetch 的整个生命周期（含 body 读取），超时以 TimeoutError 呈现。
 * 长生命 SSE 不要用它：请用 dsh-timeout 的 deadline()，并在响应头到达后 dispose。
 */
export function deadlineSignal(signal: AbortSignal | undefined, ms: number = REQUEST_TIMEOUT_MS): AbortSignal {
  // 不用 AbortSignal.timeout：它绑定 Node 内部定时器，测试的 fake timers 推不动它，
  // 且 jsdom 环境下该 API 是否来自 window polyfill 随版本漂移（30.1.x 起行为变了）。
  // setTimeout + AbortController 语义等价（abort reason 同为 TimeoutError），且可控。
  const controller = new AbortController()
  const id = setTimeout(() => {
    controller.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))
  }, ms)
  const dispose = (): void => { clearTimeout(id) }
  controller.signal.addEventListener('abort', dispose, { once: true })
  signal?.addEventListener('abort', dispose, { once: true })
  return signal === undefined ? controller.signal : AbortSignal.any([signal, controller.signal])
}

/** 刷新没有产出新 token 的原因。 */
export type RefreshFailure =
  /** 服务端拒绝了 refresh token：已花掉、已吊销，或根本不对。 */
  | 'rejected'
  /**
   * 请求没有拿到裁决——网络故障、超时，或网关 5xx。
   * 磁盘上的凭据可能完全健康，所以这**绝不能**被报成「请重新登录」。
   */
  | 'unreachable'

/** 一次刷新尝试的结果：新 token，或没有新 token 的原因。 */
export type RefreshResult =
  | { ok: true, token: AuthToken }
  | { ok: false, reason: RefreshFailure }

/**
 * 用 refresh token 换新的 access token。
 *
 * 「被拒绝」与「服务不可达」必须分开：前者要用户重新登录，后者只需重试；
 * 混为一谈会因为 Wi-Fi 闪一下就叫一个凭据健康的用户重走浏览器握手。
 * 只有已裁决且不可重试的答案——非 408/429 的 4xx，或 code≠0 的 200 报文——才算
 * `rejected`；其余一律 `unreachable`。
 */
export async function refreshAccessToken(identity: CodeBuddyIdentity, refreshToken: string): Promise<RefreshResult> {
  const headers = withIdentityHeaders({
    'Accept': 'application/json',
    'X-Refresh-Token': refreshToken,
    'X-Auth-Refresh-Source': 'workbuddy',
  }, identity)
  let response: Response
  try {
    response = await fetch(`${CODEBUDDY_ENDPOINT}/v2/plugin/auth/token/refresh`, { method: 'POST', headers, signal: deadlineSignal(undefined) })
  } catch {
    // 没拿到裁决，凭据不背锅。
    return { ok: false, reason: 'unreachable' }
  }
  if (!response.ok) {
    // 408/429 按定义可重试，5xx 是服务端的问题；其余（含 401/403）才是 token 被拒。
    const retryable = response.status === 408 || response.status === 429 || response.status >= 500
    return { ok: false, reason: retryable ? 'unreachable' : 'rejected' }
  }
  let body: AuthTokenResponse
  try {
    body = await response.json() as AuthTokenResponse
  } catch {
    // 200 但 body 读不出来，是坏响应，不是拒绝。
    return { ok: false, reason: 'unreachable' }
  }
  if (body.code !== 0 || body.data === undefined) return { ok: false, reason: 'rejected' }
  return { ok: true, token: body.data }
}

/** 目录读取在传输层或 HTTP 层失败；`status` 对 HTTP 拒绝有值。 */
export class ConfigRequestError extends Error {
  constructor(detail: string, readonly status?: number, options?: ErrorOptions) {
    super(detail, options)
    this.name = 'ConfigRequestError'
  }
}

export async function getConfig(identity: CodeBuddyIdentity, signal?: AbortSignal): Promise<CodeBuddyConfig> {
  // 客户端身份头：服务端「使用记录」据此把本插件认成 VSCode。
  const headers = withIdentityHeaders({
    'Accept': 'application/json',
    'User-Agent': CODEBUDDY_IDE_USER_AGENT,
    ...codeBuddyIdentityHeaders(),
  }, identity)
  let response: Response
  try {
    response = await fetch(`${CODEBUDDY_ENDPOINT}/v3/config`, { method: 'GET', headers, signal: deadlineSignal(signal) })
  } catch (error) {
    // 没有 HTTP 裁决，status 保持 undefined。
    throw new ConfigRequestError('CodeBuddy config request failed (transport)', undefined, { cause: error })
  }
  if (!response.ok) {
    throw new ConfigRequestError(`CodeBuddy config request failed (HTTP ${response.status})`, response.status)
  }
  const body = await response.json() as ConfigResponse
  if (body.code !== 0 || body.data === undefined) {
    throw new ConfigRequestError(`CodeBuddy config request failed: ${body.code} - ${body.msg}`)
  }
  return body.data
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('aborted')); return }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve() }, ms)
    const onAbort = (): void => { clearTimeout(timer); reject(new Error('aborted')) }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export async function requestAuthState(signal?: AbortSignal): Promise<AuthState> {
  // platform=CLI：登录页按 platform 区分客户端平台。ide 会命中 IDE 深链分支
  // （登录成功页自动 `location.href = 'codebuddy://getStarted'`，浏览器里表现为
  // 尝试唤起本地客户端后停在原页），而 CLI 只显示「请返回 CLI 继续」，页面留在
  // 浏览器——这正是设置卡 window.open(authUrl) 所需的形态（上游同款修复）。
  // 轮询 token / 取账号 / 模型目录等其余端点不区分 platform，无需跟随。
  const response = await fetch(`${CODEBUDDY_ENDPOINT}/v2/plugin/auth/state?platform=CLI`, {
    method: 'POST',
    headers: { 'Accept': 'application/json', 'X-No-Authorization': 'true', 'X-No-User-Id': 'true', 'X-No-Enterprise-Id': 'true' },
    signal: deadlineSignal(signal),
  })
  if (!response.ok) throw new Error(`CodeBuddy auth state request failed (HTTP ${response.status})`)
  const body = await response.json() as AuthStateResponse
  if (body.code !== 0 || body.data === undefined) throw new Error(`CodeBuddy auth state request failed: ${body.code} - ${body.msg}`)
  return body.data
}

export async function pollAuthToken(state: string, signal?: AbortSignal): Promise<AuthToken | undefined> {
  const deadline = Date.now() + LOGIN_TIMEOUT_MS
  while (Date.now() < deadline) {
    await delay(LOGIN_POLL_INTERVAL_MS, signal)
    try {
      const response = await fetch(`${CODEBUDDY_ENDPOINT}/v2/plugin/auth/token?state=${encodeURIComponent(state)}`, {
        method: 'GET',
        headers: { 'Accept': 'application/json', 'X-No-Authorization': 'true' },
        signal: deadlineSignal(signal),
      })
      if (!response.ok) continue
      const body = await response.json() as AuthTokenResponse
      if (body.code === AUTH_PENDING_CODE) continue
      if (body.code !== 0) return undefined
      return body.data
    } catch {
      // 单轮超时/网络抖动只意味着「本轮读不到」，不能终止整个登录：继续下一轮，
      // 直到 10 分钟的 LOGIN_TIMEOUT_MS 总死线。caller 取消才是终止信号。
      if (signal?.aborted) return undefined
      continue
    }
  }
  return undefined
}

function normalizeAccount(account: Account): Account {
  const pick = (v: string | undefined): string | undefined => v === undefined || v.length === 0 ? undefined : v
  return {
    uid: account.uid,
    nickname: account.nickname,
    ...pick(account.uin) === undefined ? {} : { uin: account.uin },
    ...pick(account.enterpriseId) === undefined ? {} : { enterpriseId: account.enterpriseId },
    ...pick(account.enterpriseName) === undefined ? {} : { enterpriseName: account.enterpriseName },
    ...pick(account.enterpriseUserName) === undefined ? {} : { enterpriseUserName: account.enterpriseUserName },
    ...pick(account.departmentFullName) === undefined ? {} : { departmentFullName: account.departmentFullName },
  }
}

export async function getLoginAccount(state: string, accessToken: string, domain: string): Promise<Account> {
  const response = await fetch(`${CODEBUDDY_ENDPOINT}/v2/plugin/login/account?state=${encodeURIComponent(state)}`, {
    method: 'GET',
    headers: { 'Accept': 'application/json', 'Authorization': `Bearer ${accessToken}`, 'X-No-User-Id': 'true', 'X-No-Enterprise-Id': 'true', 'X-Domain': domain },
    signal: deadlineSignal(undefined),
  })
  if (!response.ok) throw new Error(`CodeBuddy login account request failed (HTTP ${response.status})`)
  const body = await response.json() as AccountResponse
  if (body.code !== 0 || body.data === undefined) throw new Error(`CodeBuddy login account request failed: ${body.code} - ${body.msg}`)
  return normalizeAccount(body.data)
}
