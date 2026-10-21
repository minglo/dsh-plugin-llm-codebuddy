import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { Context } from '@deepseek-ai/cordis'
import { readGrant, recordKey } from './auth.js'
import type { CodeBuddyGrant } from './auth.js'
import { fetchCheckinStatus, performCheckin } from './checkin.js'
import { fetchUsage, UsageAuthExpiredError } from './usage.js'
import { UsageCache, usageCacheKey } from './usage-cache.js'
import { decodeJwtPayload, resolveIdentity } from './jwt.js'
import { requestAuthState } from './codebuddy.js'
import { completeLogin } from './login-flow.js'
import type { CodeBuddySession } from './session.js'
import { readSettings, updateSettings } from './settings-ns.js'
import type { CodeBuddySettings } from './settings-ns.js'
import { effectiveRate, promotionFor, tierFor, windowTextOf } from './promotions.js'
import type { CodeBuddyPromotion, CodeBuddyTier } from './types.js'
import type { CodeBuddyModelEntry, CodeBuddyModelsResult, CheckinResultView, CheckinStatusView, LocalizedText, LoginPoll, LoginStart, PromotionView, SearchBackendState, SettingsView, StatusView, TierView, UsageResult } from './remote-types.js'
import { USAGE_CACHE_TTL_MS } from './constants.js'

/**
 * 「签到态读不到」的回执。
 *
 * 全字段是常量而非每次新建：wire 上它是普通对象，客户端只读字段，不需要引用
 * 稳定；但复用同一个对象可以让「读不到」这一态在多次调用间是**同一个值**，
 * 客户端的快照比对不会因为每次返回新对象而误判成「变了」。
 */
const UNAVAILABLE_CHECKIN: CheckinStatusView = {
  available: false,
  active: false,
  checkedIn: false,
  streakDays: 0,
  dailyCredit: 0,
  todayCredit: 0,
}

/**
 * 徽标缺颜色时的兜底：中性灰。
 *
 * 浏览器只管按 `color` 画徽章，空颜色会画出一枚看不见的药丸——与其丢掉
 * 整条促销，不如给它一个看得见的默认色。
 */
const PROMOTION_FALLBACK_COLOR = '#8A8F99'

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
  /**
   * 额度读数的宿主侧缓存。**一次抓取服务所有客户端入口与所有重挂**：
   * 侧栏指示器、输入框胶囊、插件配置页读的是同一份，刷新页面或 HMR 重挂
   * 也命中缓存而不是重打一轮多页外呼。
   */
  private readonly usageCache = new UsageCache({ ttlMs: USAGE_CACHE_TTL_MS })

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
    if (grant === undefined) {
      // 未登录：丢弃缓存，避免登出后仍把上一个账号的额度发出去。
      this.usageCache.clear()
      return { loggedIn: false }
    }
    // 身份解析（可能触发 token 刷新）只做一次：它同时给出账号身份键与本次
    // 外呼要用的凭据。用 uid + 企业 id 当键，**不用 token**——token 会随刷新
    // 轮换，拿它当键会让每次正常刷新都判定成「换了账号」。
    const identity = await this.options.session.identity()
    const key = usageCacheKey(identity)
    const snapshot = await this.usageCache.read(key, async () => {
      try {
        return await fetchUsage(identity)
      } catch (error) {
        if (!(error instanceof UsageAuthExpiredError)) throw error
        // 401/403：token 已失效，刷新后再试一次。刷新失败按「本次不可读」处理
        // （undefined），而不是把错误抛给客户端——额度读不到不该让整卡片报错。
        try {
          return await fetchUsage(await this.options.session.identity())
        } catch {
          return undefined
        }
      }
    })
    if (snapshot.view === undefined) return { loggedIn: false }
    return {
      loggedIn: true,
      view: snapshot.view,
      // 抓取时刻取缓存的原始时间，而不是「本次返回」的时间：陈旧缓存被后台
      // 刷新时，这个值必须如实反映数据有多旧。
      ...(snapshot.at === undefined ? {} : { fetchedAt: snapshot.at }),
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
    // 额度读数属于刚离开的那个账号：立刻丢弃，否则重新登录后、下一次真实抓取
    // 落地之前，缓存里的旧账号额度会被当成新账号的显示出来。
    this.usageCache.clear()
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
  async setSettings(patch: { showUsage?: boolean; showComposerUsage?: boolean; waitOnRateLimit?: boolean; webSearch?: boolean }): Promise<void> {
    await updateSettings(this.ctx, patch)
  }

  /**
   * 读今日签到态。
   *
   * 未登录 / 接口读不到时返回 `available: false`——**读不到**与**活动没开**是
   * 两回事，客户端据此决定要不要给签到入口。
   */
  @Remote
  async checkinStatus(): Promise<CheckinStatusView> {
    const grant = await readGrant(this.ctx)
    if (grant === undefined) return UNAVAILABLE_CHECKIN
    const identity = await this.options.session.identity()
    const status = await fetchCheckinStatus(identity)
    if (status === undefined) return UNAVAILABLE_CHECKIN
    return {
      available: true,
      active: status.active,
      checkedIn: status.checkedIn,
      streakDays: status.streakDays,
      dailyCredit: status.dailyCredit,
      todayCredit: status.todayCredit,
    }
  }

  /**
   * 执行今日签到。
   *
   * 失败时把服务端的原因原样带回（客户端只在失败时用它做补充说明），
   * 成功时带回本次得到的积分与连签天数。
   */
  @Remote
  async checkin(): Promise<CheckinResultView> {
    const grant = await readGrant(this.ctx)
    if (grant === undefined) return { success: false, message: 'not signed in', credit: 0, streakDays: 0 }
    const identity = await this.options.session.identity()
    const outcome = await performCheckin(identity)
    return {
      success: outcome.success,
      ...(outcome.message === undefined ? {} : { message: outcome.message }),
      credit: outcome.credit,
      streakDays: outcome.streakDays,
    }
  }

  /**
   * 读富化后的整份模型目录：每个条目带上当前展示价、可选的双语描述，
   * 以及此刻生效的一条促销与命中的分层。
   *
   * 促销清单走目录缓存（5 分钟 TTL），但「此刻有没有生效」每次调用现算——
   * 缓存还没过期、每日时间窗也可能已经翻页（比如 23:00 切夜场），所以
   * 生效判定不能在读缓存时一次算死，只能在这里按调用时刻判定。
   */
  @Remote
  async models(): Promise<CodeBuddyModelsResult> {
    // 登录态判定与 status() 同一套：磁盘上有凭据文件 ≠ 能认证（见 status()
    // 的注释），两边不会对「登没登录」给出矛盾答案。
    const grant = await readGrant(this.ctx)
    if (grant === undefined) return { loggedIn: false, models: [] }
    if (!(await this.options.session.isUsable())) return { loggedIn: false, models: [] }
    // 三个读取口共用同一份缓存快照：一次抓取，三边一致。
    const models = await this.options.session.modelsOrEmpty()
    const promotions = await this.options.session.promotionsOrEmpty()
    const tiers = await this.options.session.tiersOrEmpty()
    // 同一次调用共用同一个 now：同一份返回里的条目不能一半按旧窗口算、
    // 一半按新窗口算。
    const now = Date.now()
    const entries: CodeBuddyModelEntry[] = models.map((model) => {
      // 同一个模型、同一个 now：选出来的那条促销同时决定徽标与现价，
      // 两边不能各算一次（两次 Date.now() 可能落在窗口的两侧）。
      const active = promotionFor(promotions, model.id, now)
      const promotion = toPromotionView(active)
      const tier = toTierView(tierFor(tiers, model.id))
      const description = localizedOf(model.descriptionZh, model.descriptionEn)
      const rate = effectiveRate(model.credits, active)
      return {
        id: model.id,
        name: model.name,
        // 没有数字价就不下发 rate 字段：目录里没 credits 的模型（如 auto、
        // codewise-*、nes-gf）照样有条目，但它是裸条目——wire 字段本就是
        // optional 的，客户端把「缺字段」当没有倍率处理（面板整行省略），
        // 而不是在气泡里打出 `倍率: undefined`。
        ...(rate.base === undefined && rate.current === undefined ? {} : { rate }),
        ...(description === undefined ? {} : { description }),
        ...(promotion === undefined ? {} : { promotion }),
        ...(tier === undefined ? {} : { tier }),
      }
    })
    return { loggedIn: true, models: entries }
  }
}

/**
 * 两版文案拼成 wire 上的双语对：有一版算一版，两版都没有就不下发这个字段。
 *
 * 宿主不知道浏览器的语言（`locale.preference` 只在用户手选后才有值），
 * 所以两份都留在 wire 上，由客户端按当前语言挑选。
 */
function localizedOf(zh: string | undefined, en: string | undefined): LocalizedText | undefined {
  if (zh === undefined && en === undefined) return undefined
  return {
    ...(zh === undefined ? {} : { zh }),
    ...(en === undefined ? {} : { en }),
  }
}

/**
 * 服务端促销条目投影成 wire 上的展示事实。
 *
 * `promotionFor` 已经按 priority 选出此刻生效的一条（没有就直接不挂）；
 * 这里只做形状转换：label 缺省时同样不挂——wire 上没有「空徽章」的位置。
 */
function toPromotionView(promotion: CodeBuddyPromotion | undefined): PromotionView | undefined {
  if (promotion === undefined) return undefined
  const label = promotion.badge?.label
  if (label === undefined) return undefined
  const text = localizedOf(promotion.hover?.textZh, promotion.hover?.textEn)
  const window = windowTextOf(promotion.schedule)
  return {
    label,
    color: promotion.badge?.color ?? PROMOTION_FALLBACK_COLOR,
    ...(text === undefined ? {} : { text }),
    ...(window === undefined ? {} : { window }),
  }
}

/**
 * 服务端分层条目投影成 wire 上的展示事实：label 缺省时不挂。
 */
function toTierView(tier: CodeBuddyTier | undefined): TierView | undefined {
  if (tier === undefined) return undefined
  const label = tier.badge?.label
  if (label === undefined) return undefined
  const text = localizedOf(tier.hover?.textZh, tier.hover?.textEn)
  return {
    label,
    ...(text === undefined ? {} : { text }),
  }
}
