import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { Context } from '@deepseek-ai/cordis'
import { readGrant, recordKey } from './auth.js'
import type { CodeBuddyGrant } from './auth.js'
import { fetchUsage, UsageAuthExpiredError } from './usage.js'
import { decodeJwtPayload, resolveIdentity } from './jwt.js'
import { requestAuthState } from './codebuddy.js'
import { completeLogin } from './login-flow.js'
import type { CodeBuddySession } from './session.js'
import { readSettings, updateSettings } from './settings-ns.js'
import type { CodeBuddySettings } from './settings-ns.js'
import type { LoginPoll, LoginStart, SearchBackendState, SettingsView, StatusView, UsageResult } from './remote-types.js'

export interface CodeBuddyRemoteOptions {
  session: CodeBuddySession
  /**
   * 当前权威设置（showUsage / webSearch）。
   *
   * Remote 方法经 traceable 代理调用时 `this.ctx` 绑定的是**调用方**的上下文，
   * 读不到本插件 fiber 的 config——所以由 index.ts 在 apply 时捕获 live config
   * 句柄（volatile 引用与 fiber.config 共享同一实例，loader 提交后两边同步），
   * 再从这里传入。
   */
  settings?: () => CodeBuddySettings
  /**
   * 当前 web_search / web_fetch 实际生效的后端（读 seam 的选择字段）。
   * 由 index.ts 注入 webSync.backendState；headless／无 web 编排器时缺省，
   * status() 随即省略该字段，客户端据此不渲染徽标。
   *
   * 允许返回 Promise：实现方先做一次自愈对账再读，因为启动瞬间读到的登录态
   * 可能是错的，而且不会有任何事件来纠正它。
   */
  searchBackend?: () => SearchBackendState | Promise<SearchBackendState>
}

export class CodeBuddyRemoteService extends TypertRemoteService {
  private pending = new Map<string, Promise<CodeBuddyGrant | undefined>>()

  constructor(ctx: Context, private readonly options: CodeBuddyRemoteOptions) {
    super(ctx, 'codebuddy')
  }

  @Remote
  async status(): Promise<StatusView> {
    // 与登录态无关地如实上报：status 是 wire 契约，不替客户端做展示决策。
    // （设置卡在未登录时整行隐藏搜索开关与徽标——见 CodeBuddyTab。）
    const searchBackend = this.options.searchBackend === undefined
      ? undefined
      : await this.options.searchBackend()
    const backend = searchBackend === undefined ? {} : { searchBackend }
    const grant = await readGrant(this.ctx)
    if (grant === undefined) return { loggedIn: false, ...backend }
    // 磁盘上有凭据文件 ≠ 能登录：access 与 refresh 双双过期时，凭据读起来是已登录
    // 却打不通任何请求——设置页显示着账号、模型列表却是空的，而且不报错。
    // 所以这里探测可用性；不可用的报 loggedIn: false + expired: true，让页面
    // 给出重新登录的入口。服务不可达仍算已登录——凭据并没有被拒绝。
    if (!(await this.options.session.isUsable())) return { loggedIn: false, expired: true, ...backend }
    const payload = decodeJwtPayload(grant.accessToken)
    const identity = resolveIdentity(payload)
    return {
      loggedIn: true,
      ...identity.userId.length > 0 ? { userId: identity.userId } : {},
      ...identity.tenantId.length > 0 ? { tenantId: identity.tenantId } : {},
      ...identity.enterpriseId.length > 0 ? { enterpriseId: identity.enterpriseId } : {},
      ...backend,
    }
  }

  @Remote
  async usage(): Promise<UsageResult> {
    const grant = await readGrant(this.ctx)
    if (grant === undefined) return { loggedIn: false }
    const identity = await this.options.session.identity()
    try {
      const view = await fetchUsage(identity)
      return view === undefined ? { loggedIn: false } : { loggedIn: true, view }
    } catch (error) {
      // 401/403：token 已失效，触发一次刷新后重试；刷新失败则回落「未登录」
      if (error instanceof UsageAuthExpiredError) {
        try {
          const refreshed = await this.options.session.identity()
          const view = await fetchUsage(refreshed)
          return view === undefined ? { loggedIn: false } : { loggedIn: true, view }
        } catch {
          return { loggedIn: false }
        }
      }
      throw error
    }
  }

  @Remote
  async startLogin(): Promise<LoginStart> {
    const handshake = await requestAuthState()
    const promise = completeLogin(this.ctx, handshake.state, this.options.session)
    this.pending.set(handshake.state, promise)
    void promise.finally(() => { if (this.pending.get(handshake.state) === promise) this.pending.delete(handshake.state) })
    return { authUrl: handshake.authUrl, state: handshake.state }
  }

  @Remote
  async pollLogin(state: string): Promise<LoginPoll> {
    const p = this.pending.get(state)
    if (p === undefined) return { done: false }
    const grant = await p
    return { done: grant !== undefined }
  }

  @Remote
  async logout(): Promise<void> {
    const credentials = this.ctx.get('credentials')
    if (credentials !== undefined) await credentials.deleteRecord(recordKey())
    this.options.session.invalidate()
    // 选择器里的模型列表属于刚离开的那个账号；播报让客户端丢掉它，
    // 而不是继续给一个已登出的用户看他的模型。
    this.options.session.announceCatalogChange()
  }

  @Remote
  async getSettings(): Promise<SettingsView> {
    // 0.1.7 的 settings 命名空间就是 profile entry id：权威值在本插件 fiber 的
    // live config 里（volatile 字段被 loader 的 _commitVolatile 就地提交）。不能读
    // this.ctx.fiber——traceable 代理把方法里的 this.ctx 绑到调用方上下文——
    // 所以读 apply 时捕获的 config 句柄；句柄缺失（独立实例化）时按默认值。
    const settings = this.options.settings?.() ?? readSettings(undefined)
    return { ...settings }
  }

  @Remote
  async setSettings(patch: { showUsage?: boolean; webSearch?: boolean }): Promise<void> {
    await updateSettings(this.ctx, patch)
  }
}
