import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { readGrant, recordKey } from './auth.js'
import type { CodeBuddyGrant } from './auth.js'
import { ConfigRequestError, getConfig, refreshAccessToken } from './codebuddy.js'
import type { CodeBuddyIdentity } from './codebuddy.js'
import { CATALOG_TTL_MS, codeBuddyIdentityHeaders, PACKAGE_NAME, REFRESH_SKEW_MS } from './constants.js'
import type { CodeBuddyModel } from './types.js'

export class NotLoggedInError extends Error {
  constructor(detail: string) {
    super(detail)
    this.name = 'NotLoggedInError'
  }
}

/**
 * 凭据无法被校验，因为服务不可达——磁盘上的会话很可能仍然有效。
 *
 * 刻意与 {@link NotLoggedInError} 分开： remedy 是重试而不是重新登录，
 * adapter 把它映射为**可重试**的 TRANSPORT，而不是终态的 MISSING_CREDENTIAL。
 * 把网络抖动报成「登录已过期」，会让一个已正确登录的用户白跑一遍浏览器握手。
 */
export class SessionUnavailableError extends Error {
  constructor(detail: string, options?: ErrorOptions) {
    super(detail, options)
    this.name = 'SessionUnavailableError'
  }
}

/**
 * 强制读之间的最小间隔。
 *
 * 强制读是为了让选择器跟上服务端编辑，但每次都要打一次 `/v3/config`。
 * 「打开菜单」→「它发了事件」→「客户端跟着重读」本来可能挤在同一秒内，
 * 所以落在这个下限内的强制读退化为缓存副本——它的指纹没变，自然什么都不播报。
 */
const CATALOG_FORCE_FLOOR_MS = 3_000

/** 一次缓存的目录读取：条目、读取时间，以及内容摘要。 */
interface CatalogSnapshot {
  models: readonly CodeBuddyModel[]
  readAt: number
  /** 可上架条目的稳定摘要，用于比对发现服务端编辑。 */
  fingerprint: string
}

/**
 * 目录用户可见内容的稳定摘要。
 *
 * 读前读后各算一次，内容没变就什么都不播报——无条件播报会让每次打开菜单
 * 都 churn 客户端的目录、分组与所有下游 surface。摘要只覆盖选择器真正渲染的字段
 * （id/name/credits/尺寸/能力开关/reasoning），服务端回显的其他东西不值得让客户端
 * 重拉；条目按 id 排序，所以单纯换序不算变化。
 *
 * `JSON.stringify` 保持这里写下的字面字段顺序，故同一目录多次读取摘要稳定。
 */
function catalogFingerprint(models: readonly CodeBuddyModel[]): string {
  const projected = models
    .map(model => ({
      id: model.id,
      name: model.name,
      credits: model.credits,
      maxAllowedSize: model.maxAllowedSize,
      maxOutputTokens: model.maxOutputTokens,
      supportsImages: model.supportsImages,
      supportsToolCall: model.supportsToolCall,
      supportsReasoning: model.supportsReasoning,
      reasoning: model.reasoning,
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return createHash('sha256').update(JSON.stringify(projected)).digest('hex')
}

function identityOf(grant: CodeBuddyGrant): CodeBuddyIdentity {
  return {
    accessToken: grant.accessToken,
    domain: grant.domain,
    ...grant.uid === undefined ? {} : { uid: grant.uid },
    ...grant.enterpriseId === undefined ? {} : { enterpriseId: grant.enterpriseId },
  }
}

export class CodeBuddySession {
  private catalog: CatalogSnapshot | undefined
  private catalogRead: Promise<CatalogSnapshot> | undefined
  /**
   * 最近一次读到的摘要，跨 {@link invalidate} 保留，这样凭据变更（换了账号登录）
   * 依然会播报它替换掉的那份目录。单纯的 token 刷新会清缓存但不碰它，
   * 所以目录没变就什么都不播报。
   */
  private lastFingerprint: string | undefined
  /**
   * 变更观察者，在内容不同于上一次的读取**之后**触发。由插件注册，
   * 让服务端编辑无需重启就能到达客户端；session 自己保持纯传输层，不懂 cordis 事件。
   */
  private readonly catalogListeners = new Set<() => void>()

  constructor(private readonly ctx: Context) {}

  /**
   * 观察目录内容变化。
   * @param listener - 在内容变化的读取之后被调用。
   * @returns 停止观察的 disposer。
   */
  onCatalogChange(listener: () => void): () => void {
    this.catalogListeners.add(listener)
    return () => { this.catalogListeners.delete(listener) }
  }

  private emitCatalogChange(): void {
    for (const listener of [...this.catalogListeners]) {
      try {
        listener()
      } catch (error) {
        // 一个坏观察者不能弄挂播报它的那次读取。
        this.ctx.logger.warn(`${PACKAGE_NAME}: a model-catalog change listener failed`)
        this.ctx.logger.warn(error)
      }
    }
  }

  /**
   * 播报「各方手里的目录已不再权威」。
   *
   * 用于**账号**变化而非内容变化——登录/登出整份替换了模型，没有内容 diff 可观察，
   * 所以必须直接让客户端丢掉上一个账号的列表，而不是等到某次读取碰巧内容不同。
   */
  announceCatalogChange(): void {
    this.emitCatalogChange()
  }

  invalidate(): void {
    this.catalog = undefined
  }

  async isLoggedIn(): Promise<boolean> {
    return await readGrant(this.ctx) !== undefined
  }

  async identity(): Promise<CodeBuddyIdentity> {
    const stored = await readGrant(this.ctx)
    if (stored === undefined) {
      throw new NotLoggedInError('CodeBuddy is not signed in; store a grant record under plugin-llm-codebuddy/codebuddy.')
    }
    const now = Date.now()
    if (now < stored.expiresAt - REFRESH_SKEW_MS) return identityOf(stored)
    if (now >= stored.refreshExpiresAt) {
      throw new NotLoggedInError('The CodeBuddy session has expired; sign in again.')
    }
    const credentials = this.ctx.get('credentials')
    if (credentials === undefined) {
      throw new LlmError(`${PACKAGE_NAME}: no credentials service to refresh the session`, 'NO_CREDENTIAL_STORE')
    }
    const next = await credentials.modifyRecord(recordKey(), async (current) => {
      const currentGrant = current?.kind === 'grant' ? current.payload as CodeBuddyGrant : undefined
      if (currentGrant === undefined) return undefined
      const insideNow = Date.now()
      if (insideNow < currentGrant.expiresAt - REFRESH_SKEW_MS) return undefined // 未到期：零写盘
      if (insideNow >= currentGrant.refreshExpiresAt) return undefined
      const result = await refreshAccessToken(identityOf(currentGrant), currentGrant.refreshToken)
      if (!result.ok) {
        // 刷新失败：不删记录（避免静默登出），但必须 throw 而非 return undefined——
        // modifyRecord 在 mutate 返回 undefined 时会返回「当前旧 grant」，若这里 return undefined
        // 会把已过期的 accessToken 交回调用方（拿到过期 token 去打，再 401）。
        //
        // 被拒是这份凭据的终态；服务不可达不是，它不能带上「请重新登录」的 remedy。
        throw result.reason === 'rejected'
          ? new NotLoggedInError('Refreshing the CodeBuddy session failed; sign in again.')
          : new SessionUnavailableError(
            'Could not reach CodeBuddy to refresh the session; the stored credential was not rejected.'
            + ' Check the network and retry.',
          )
      }
      const refreshed = result.token
      return {
        kind: 'grant',
        payload: {
          accessToken: refreshed.accessToken,
          expiresAt: Date.now() + refreshed.expiresIn * 1000,
          refreshToken: refreshed.refreshToken,
          refreshExpiresAt: Date.now() + refreshed.refreshExpiresIn * 1000,
          domain: refreshed.domain,
          ...currentGrant.uid === undefined ? {} : { uid: currentGrant.uid },
          ...currentGrant.enterpriseId === undefined ? {} : { enterpriseId: currentGrant.enterpriseId },
        },
      }
    })
    const result = next?.kind === 'grant' ? next.payload as CodeBuddyGrant : undefined
    if (result === undefined) {
      throw new NotLoggedInError('Refreshing the CodeBuddy session failed; sign in again.')
    }
    return identityOf(result)
  }

  /**
   * 磁盘上的凭据**是否还能认证**一个请求。
   *
   * 「有凭据文件」不等于「会话可用」：access token 过期且 refresh token 也过期时，
   * 凭据读起来是已登录，但每个请求都会失败。凡是上报登录态的surface都用它，
   * 而不是 {@link isLoggedIn}，才不会一边显示「已登录」一边模型列表是空的。
   *
   * access token 还新鲜时解析身份是**纯本地检查**（不发网络），只有临近过期才花
   * refresh token——这份工作下一步请求本来也要做，而且是单飞的。
   * 服务不可达时返回 `true`：凭据并没有被拒绝，因为网络闪一下就把用户翻成
   * 「未登录」是错的。
   * @returns 能认证则为 true（或服务只是不可达时，当作可能可以）。
   */
  async isUsable(): Promise<boolean> {
    try {
      await this.identity()
      return true
    } catch (error) {
      if (error instanceof NotLoggedInError) return false
      // 服务不可达说明不了凭据的有效性。
      return true
    }
  }

  async authHeaders(): Promise<Record<string, string>> {
    const identity = await this.identity()
    const headers: Record<string, string> = {
      // 客户端身份头：服务端「使用记录」据此把本插件认成 VSCode。
      ...codeBuddyIdentityHeaders(),
      'Authorization': `Bearer ${identity.accessToken}`,
      'X-Domain': identity.domain,
    }
    if (identity.uid !== undefined) headers['X-User-Id'] = identity.uid
    if (identity.enterpriseId !== undefined) headers['X-Enterprise-Id'] = identity.enterpriseId
    return headers
  }

  async models(signal?: AbortSignal): Promise<readonly CodeBuddyModel[]> {
    return (await this.catalogDataWith(signal, false)).models
  }

  /**
   * 读目录，可选绕过 TTL，让服务端编辑立即可见而不必等满一个 TTL。
   *
   * `force` 是让一个**用户主动动作**（打开模型菜单，或设置页要列表）看到服务现状的
   * 开关，受 {@link CATALOG_FORCE_FLOOR_MS} 限流：落在该窗口内的强制读退化为缓存副本，
   * 因为目录不可能有实质变化，而每次读取都是一次服务往返。
   *
   * 内容不同于上次时，所有变更观察者触发——插件据此重发 `llm/adapters-updated`，
   * 让客户端丢掉它缓存的分组。
   */
  private async catalogDataWith(signal: AbortSignal | undefined, force: boolean): Promise<CatalogSnapshot> {
    const cached = this.catalog
    if (cached !== undefined) {
      const age = Date.now() - cached.readAt
      if (age < CATALOG_TTL_MS && !(force && age >= CATALOG_FORCE_FLOOR_MS)) return cached
    }
    // 仅当没有在飞时才单飞；一次已落定的读取之后的强制读会重新起一次，
    // 而不是加入一个已经过期的响应。
    this.catalogRead ??= this.readModels(signal).finally(() => { this.catalogRead = undefined })
    return this.catalogRead
  }

  private async readModels(signal?: AbortSignal): Promise<CatalogSnapshot> {
    const identity = await this.identity()
    let config: Awaited<ReturnType<typeof getConfig>>
    try {
      config = await getConfig(identity, signal)
    } catch (error) {
      // 对齐 chat 路径：401/403 表示 token 被明确拒绝，丢掉缓存让下次调用重读文件
      // （可能已有并发登录写入了新凭据），而不是继续重试一个已知被拒的 token。
      // 否则目录读取会一直拿着已吊销的 token，直到某次 chat 请求碰巧 401 才纠正。
      if (error instanceof ConfigRequestError && (error.status === 401 || error.status === 403)) {
        this.invalidate()
      }
      throw error
    }
    const models = config.models.filter(model => typeof model.id === 'string' && model.id.length > 0)
    const fingerprint = catalogFingerprint(models)
    // 与「最近读过的那一份」比，而不只是与活缓存比：换账号登录会清掉缓存，
    // 而它替换掉的那份目录仍须播报，选择器才能停止显示上一个账号的模型。
    // 挂载后的第一次读取是静默的——客户端那边还没有任何东西需要失效。
    const changed = this.lastFingerprint !== undefined && this.lastFingerprint !== fingerprint
    this.lastFingerprint = fingerprint
    this.catalog = { models, readAt: Date.now(), fingerprint }
    // 在微任务里播报，绝不同步：本次读取的 promise 仍是 session 共享的在飞那一个，
    // 若同步播报，一个「收到通知就去再读目录」的观察者会加入一个
    // 在本函数返回前不可能 settle 的 promise。
    if (changed) queueMicrotask(() => { this.emitCatalogChange() })
    return this.catalog
  }

  async modelsOrEmpty(signal?: AbortSignal): Promise<readonly CodeBuddyModel[]> {
    return (await this.modelsOrEmptyWith(signal, false, true)).models
  }

  /**
   * 为面向用户的surface强制刷新目录，且不抛。
   *
   * 绕过 TTL（受下限约束），让一个明确动作看到服务当前目录。与
   * {@link modelsOrEmpty} 不同，**读取失败时返回上一份好副本而不是空列表**：
   * 这喂给选择器的展示富化，一次瞬时抖动绝不许把每一行的标签和积分倍率
   * 都清空成光秃秃的名字。只有未登录、或从未成功读过，才给空列表。
   */
  async refreshCatalog(signal?: AbortSignal): Promise<readonly CodeBuddyModel[]> {
    return (await this.modelsOrEmptyWith(signal, true, true)).models
  }

  /**
   * 共享的咨询式读取。`force` 绕过 TTL；`fallbackToLastGood` 决定失败时
   * 是喂上一份快照还是空列表。
   */
  private async modelsOrEmptyWith(
    signal: AbortSignal | undefined,
    force: boolean,
    fallbackToLastGood: boolean,
  ): Promise<{ models: readonly CodeBuddyModel[] }> {
    try {
      const snapshot = await this.catalogDataWith(signal, force)
      return { models: snapshot.models }
    } catch (error) {
      if (error instanceof NotLoggedInError) return { models: [] }
      this.ctx.logger.warn(`${PACKAGE_NAME}: could not read the model catalog`)
      this.ctx.logger.warn(error)
      // 失败的读取不许清空一份仍然完全可用的目录：它会退化成本插件存在的意义
      // 所要改善的「裸名字/裸倍率」行，一次抖动看起来就像「所有模型都丢了元数据」。
      // 下一次成功读取会替换它，并播报任何真实变化。
      const cached = fallbackToLastGood ? this.catalog : undefined
      return { models: cached?.models ?? [] }
    }
  }
}
