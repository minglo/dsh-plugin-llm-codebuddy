// 把 CodeBuddy 的搜索/抓取后端接上 ctx.web，并管理「接管/让出」。
//
// 为什么不学上游官方包那样「只注册、不接管」：seam 的选择规则是
//   ① 有钉选 → 只认钉选的那个；② 无钉选 → 唯一 available() 者；多于一个抛
//   WEB_PROVIDER_AMBIGUOUS。而 dsh-base（deepseek-official）与 dsh-free-search
//   （ddg）都会写 `web.config.searchProvider`，实际部署里钉选几乎恒存在，
//   「只注册」的 provider 永远轮不到被选中——官方 exa 包在我们这套 profile 里
//   就是这样：注册了，但 web_search 一直走别人的后端。
//
// 为什么也不在 cordis.patch.yml 里钉 web.searchProvider：patch 的语义是
// **整行替换 config**（dsh 0.1.2+）。一旦本插件钉死 searchProvider，就会连同
// 其他 bundle 已写入的字段一起抹掉，并永久抢走 free-search 等第三方的默认位，
// 且无法运行时开关。改为运行时接管：注册前记住当前值，关闭时**仅当我们仍是
// 占用者**才原样还原。
//
// 这样对任意第三方 provider（ddg / exa / bing / deepseek-official / http…）
// 都成立，不硬编码任何 id。

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-web'
import type {} from '@deepseek-ai/dsh-settings'
import type { SettingsPathOp } from '@deepseek-ai/dsh-settings'
import { credentialKeyId, credentialKeyScope } from '@deepseek-ai/dsh-credentials'
import { type CodeBuddySession } from './session.js'
import { CODEBUDDY_WEB_PROVIDER_ID } from './constants.js'
import type { SearchBackendState } from './remote-types.js'
import { recordKey } from './auth.js'
import { CodeBuddyFetchProvider, CodeBuddySearchProvider } from './web-providers.js'

/**
 * dsh-web 的 provider 选择存在**私有只读**字段里（源码 `private readonly
 * searchProviderId`）。`readonly` 只约束 TypeScript 编译期、运行时不冻结，
 * 所以赋值确实生效——但这是**明确绕过类型系统的越权写入**，不是被上游背书
 * 的写法：上游 web-search-exa / -deepseek / -perplexity / web-fetch-http /
 * tool-web 全都只调 registerXxxProvider，从不读写这两个字段（0 处）。
 * 本插件是 JS 转译产物 + 运行时鸭子类型，因此躲过了编译期检查。
 *
 * 为什么非这么做不可：seam 的选择规则是「有钉选 → 只认钉选的那个；无钉选 →
 * 唯一 available() 者，多于一个直接抛 WEB_PROVIDER_AMBIGUOUS」。而 dsh-base
 * 与 dsh-free-search 都会写 `web.config.searchProvider`，所以实际部署里钉选
 * 几乎恒存在。「只注册、不接管」在这样的组合里永远轮不到本 provider——它既
 * 不可能被选中，也无从实现「运行时开关」。接管是把选择权拿回来、并在关闭时
 * 原样还回去的唯一途径。
 *
 * 字段不存在（未来版本真正封起来/改名）时的降级：**不注册**。降级成「注册但
 * 不接管」在**未钉选**的组合里会让可用 provider 多于一个，从而让 seam 对
 * **所有人**的 web_search 抛 WEB_PROVIDER_AMBIGUOUS——把自己的无效变成全局
 * 故障。不注册则在任何组合下都不伤及他人，代价只是本后端在该组合里不可用，
 * 而那本就是它在无钉选组合里的唯一结局。
 *
 * 两个字段都是类字段声明（无初值），因此**恒存在**且值可能为 undefined——
 * 故用 `string | undefined` 而非可选属性，还原时才谈得上「写回 undefined」。
 */
interface MutableWebSelection {
  searchProviderId: string | undefined
  fetchProviderId: string | undefined
}

function selectionOf(web: unknown): MutableWebSelection | undefined {
  if (web === null || typeof web !== 'object') return undefined
  const candidate = web as Record<string, unknown>
  return 'searchProviderId' in candidate && 'fetchProviderId' in candidate
    ? candidate as unknown as MutableWebSelection
    : undefined
}

/**
 * 新 cohort（dsh-web 0.2.1-rc.2 起）的选择形状：`web.config.searchProvider` /
 * `web.config.fetchProvider` 是 Volatile 引用——**只有 `get()`，没有 `set()`**，
 * 引用由宿主的 loader 独占更新，任何绕过它直接改内部快照的写法都是错的。
 * 被认可的写入口是 settings 服务：`ctx.settings.mutate('web', ops)`。
 *
 * 探测顺序必须是**先新后旧**：旧 cohort 的 web 实例上根本没有 `config` 字段，
 * 而新 cohort 删掉了平铺字段——两者不会同时成立，先看哪个都不会误判。
 * 这里只认「带 `get()` 函数的对象」，读到非字符串一律按未钉选处理。
 */
interface VolatileWebSelection {
  searchProvider: { get(): unknown }
  fetchProvider: { get(): unknown }
}

function isVolatileRef(value: unknown): value is { get(): unknown } {
  return value !== null && typeof value === 'object'
    && typeof (value as { get?: unknown }).get === 'function'
}

function volatileSelectionOf(web: unknown): VolatileWebSelection | undefined {
  if (web === null || typeof web !== 'object') return undefined
  const config = (web as Record<string, unknown>).config
  if (config === null || typeof config !== 'object') return undefined
  const { searchProvider, fetchProvider } = config as Record<string, unknown>
  return isVolatileRef(searchProvider) && isVolatileRef(fetchProvider)
    ? { searchProvider, fetchProvider }
    : undefined
}

/** 读一个 Volatile 快照里的 provider id：读失败或非字符串都按未钉选处理。 */
function readVolatileId(ref: { get(): unknown }): string | undefined {
  try {
    const value = ref.get()
    return typeof value === 'string' ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * 两 cohort 的选择句柄。探测顺序：先看新的 Volatile 形状，再看旧的平铺字段
 *（两者不会同时成立，先看哪个都不会误判）。
 */
type SelectionHandle =
  | { kind: 'volatile'; sel: VolatileWebSelection }
  | { kind: 'legacy'; sel: MutableWebSelection }

function selectionHandleOf(web: unknown): SelectionHandle | undefined {
  const volatileSel = volatileSelectionOf(web)
  if (volatileSel !== undefined) return { kind: 'volatile', sel: volatileSel }
  const selection = selectionOf(web)
  return selection === undefined ? undefined : { kind: 'legacy', sel: selection }
}

/**
 * 网关根地址。会话的 baseURL 指的是 chat 面（默认 .../v2），而 /agenttool
 * 挂在同一网关根下；用户自定义 baseURL 时按同样的约定去掉尾部 chat 段。
 */
export function gatewayRootOf(baseURL: string): string {
  const trimmed = baseURL.replace(/\/+$/, '')
  return trimmed.endsWith('/v2') ? trimmed.slice(0, -'/v2'.length) : trimmed
}

export interface WebSyncOptions {
  session: CodeBuddySession
  /** 解析当前网关根地址（跟随会话 config 的 baseURL）。 */
  gatewayRoot: () => string
  /** 降级/异常时的告警出口；缺省静默（测试与无 host 场景）。 */
  warn?: (message: string) => void
}

/**
 * 保持「设置开关 + 登录态」与 ctx.web 上的实际注册状态一致。
 *
 * 不变式（三选一，任何时刻都成立）：
 *   · 关闭 或 未登录 → 未注册，且不占用选择字段；
 *   · 开启且已登录 → 已注册，且选择字段指向本插件；
 * 关键是"占用字段"与"已注册"同生共死：一旦占着字段却没有对应 provider，
 * seam 会对**所有** web_search 调用抛 WEB_PROVIDER_CONFIGURED_MISSING，
 * 把别人的搜索也一起弄坏。
 */
export class CodeBuddyWebSync {
  private registered = false
  private loggedIn = false
  private disposed = false
  /** start() 是否已武装（effect 在役）；卸载时复位，使实例可被重新武装。 */
  private started = false
  private disposers: Array<() => void> = []
  /** 接管前的原值；仅用于让出时还原。 */
  private previousSearch: string | undefined
  private previousFetch: string | undefined
  /**
   * 这次接管是不是我们亲手钉的。旧 cohort 注册即钉选，恒为 true；新 cohort 走
   * settings 时为 true，走路径 B（无 settings seam、只注册不钉选）时为 false。
   * 让出时只认这个标记——路径 B 下用户在设置页的手动钉选不是我们写的，还回去
   * 会覆盖用户刚建立的选择。
   */
  private pinnedByUs = false

  constructor(
    private readonly ctx: Context,
    private readonly options: WebSyncOptions,
    /** 当前是否希望接管（来自设置开关）。 */
    private enabled: boolean,
  ) {}

  /** 已登录且已注册——provider 的 available() 依据。 */
  isLive(): boolean {
    return this.registered && this.loggedIn && this.enabled && !this.disposed
  }

  /**
   * 当前 web_search / web_fetch **实际**会用的后端。读的是 seam 的选择字段
   * 本身，而不是「开关开着」这一意图——两者会不一致（开关开但未登录、或
   * 接管失败），而用户要确认的正是「搜索到底走了谁」。
   *
   * 判据用选择字段而非 isLive()：字段才是 seam 分派时真正读的东西。若第三方
   * 在我们之后抢走了字段，isLive() 仍为 true，但搜索已经不走我们了。
   */
  backendState(): SearchBackendState {
    if (this.disposed) return 'default'
    if (this.currentSearchId() === CODEBUDDY_WEB_PROVIDER_ID) return 'codebuddy'
    // 未接管：可能是开关关闭／未登录（正常让出），也可能是想接管而没能成立
    // （无 web seam、host 未暴露选择字段、注册失败）——后者要能区分出来，
    // 否则「开关开了却没生效」在界面上与「开关关着」无法分辨。
    return this.enabled && this.loggedIn ? 'unavailable' : 'default'
  }

  /**
   * 读 seam 当前选中的 search provider：新 cohort 读 Volatile 快照，旧 cohort
   * 读平铺字段——seam 分派时真正读的就是这一处，徽标必须跟着它走。
   */
  private currentSearchId(): string | undefined {
    const web = this.ctx.get('web')
    if (web === undefined) return undefined
    const handle = selectionHandleOf(web)
    if (handle?.kind === 'volatile') return readVolatileId(handle.sel.searchProvider)
    return handle?.kind === 'legacy' ? handle.sel.searchProviderId : undefined
  }

  /**
   * 读宿主的 settings 服务（新 cohort 下写选择的认可入口）。刻意**不**经 inject
   * 声明：settings 缺席时旧 cohort 照常走平铺字段、新 cohort 走路径 B（只注册
   * 不钉选）——一旦写进 inject，缺 settings 的宿主上连 start 都跑不起来，
   * 两条退路就全断了。
   */
  private settingsSeam(): { mutate(ns: string, ops: readonly SettingsPathOp[]): Promise<void> } | undefined {
    const settings = this.ctx.get('settings')
    if (settings === undefined || typeof settings.mutate !== 'function') return undefined
    return settings
  }

  private warn(message: string): void {
    this.options.warn?.(message)
  }

  /**
   * 启动：订阅登录态变化 + 首次对账。
   *
   * 可重复调用：effect 若因宿主重挂 `web`／插件行重载而被卸载，`started` 会在
   * 清理里复位，下一次调用重新注册。**不做成一次性**是必须的——否则同一个实例
   * 只要经历过一次卸载，就再也不会接管（旧实现把 `disposed` 永久点亮，于是
   * setEnabled/refreshLogin/reconcile 全部静默早退，界面上只剩「未接管」）。
   */
  start(): void {
    if (this.started) return
    this.started = true
    // 每次（重新）启动都清掉上一轮的卸载标记：本实例仍在服役。
    this.disposed = false
    this.ctx.effect(() => {
      // 登录/登出都会发出该事件（credentials-local 的 modifyRecord/deleteRecord
      // 各自 notifyRecordUpdated）；据此让"未登录不注册"成为自动行为。
      const off = this.ctx.on('credentials/record-updated', (key) => {
        if (credentialKeyScope(key) !== credentialKeyScope(recordKey())) return
        if (credentialKeyId(key) !== credentialKeyId(recordKey())) return
        void this.refreshLogin()
      })
      void this.refreshLogin()
      return () => {
        this.disposed = true
        this.started = false
        off()
        // release 内部已吞掉全部异常（warn），这里只消掉悬空 promise。
        void this.release()
      }
    }, 'codebuddy: web provider sync')
  }

  /**
   * 自愈对账。登录态只在启动瞬间读过一次，而那一刻凭据服务/凭据文件可能还没
   * 就绪——读不到就落一个 `loggedIn=false`；更关键的是**磁盘上原本就存在的
   * grant 不会发出任何 `credentials/record-updated`**（该事件只覆盖写入/删除/
   * 外部编辑），于是「开关开着、人也登录着，却永远不接管」。
   *
   * 另外，acquire() 也可能因为当时还没有 web 服务/选择字段而空手而归；这种情况下
   * 登录态并没有变化，靠 refreshLogin 的「值相同就早退」永远等不到重试。故这里
   * 无条件重读并重新对账（除非已生效），让设置卡片的一次刷新即可自愈。
   *
   * 已生效时是纯 no-op，不做任何额外 IO。
   */
  async resync(): Promise<void> {
    if (this.disposed || this.isLive()) return
    // 开关关着时不必自愈：目标态本来就是「不接管」，再去读凭据只是白费 IO。
    if (!this.enabled) return
    this.loggedIn = await this.readLoginState()
    if (this.disposed) return
    await this.reconcile()
  }

  /**
   * 设置开关变化时由 settings 的 onChange 调用。
   *
   * 返回 Promise：新 cohort 的钉选要走一次 settings.mutate（异步）。旧 cohort
   * 的整条路径仍是同步完成的——不 await 也不会错过状态，老测试照旧能直断言。
   *
   * 调用方审计（void → Promise 仍安全）：唯一的生产调用方是 index.ts 里
   * `loader/volatile-update` 的事件处理器，它本就不能 await——fire-and-forget
   * 是故意的：权威开关值在第一行就已同步落定，reconcile 幂等，且本方法永不
   * reject（所有异常都在 acquire/release 内部转 warn）。测试里需要确定性的
   * 新形状断言都已 await。
   */
  async setEnabled(enabled: boolean): Promise<void> {
    // 先进值、后对账：若此刻恰好处于「effect 已卸载、尚未重新武装」的窗口，
    // 也不能把权威的开关值丢掉——下一次 start() 会按它重新接管。
    if (this.enabled === enabled) return
    this.enabled = enabled
    if (this.disposed) return
    await this.reconcile()
  }

  /** 读一次登录态；失败（无 credentials seam 等）按未登录处理，绝不抛。 */
  private async readLoginState(): Promise<boolean> {
    try {
      return await this.options.session.isLoggedIn()
    } catch (error: unknown) {
      // 读凭据失败（无 credentials seam 等）按未登录处理，不注册。
      this.warn(`codebuddy web: could not read login state: ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }

  /** 重读登录态后对账。 */
  async refreshLogin(): Promise<void> {
    if (this.disposed) return
    const next = await this.readLoginState()
    if (this.disposed || next === this.loggedIn) return
    this.loggedIn = next
    await this.reconcile()
  }

  /** 按目标态注册或注销，并在需要时接管/让出选择字段。 */
  private async reconcile(): Promise<void> {
    if (this.disposed) return
    const want = this.enabled && this.loggedIn
    if (want === this.registered) return
    if (want) await this.acquire()
    else await this.release()
  }

  private async acquire(): Promise<void> {
    const web = this.ctx.get('web')
    if (web === undefined) {
      this.warn('codebuddy web: no web service in this composition; search/fetch backends not registered')
      return
    }
    // 先确认能不能接管，再决定要不要注册。顺序很重要：在未钉选的组合里
    // 「注册了但没接管」会让可用 provider 多于一个，seam 随即对**所有人**的
    // web_search 抛 WEB_PROVIDER_AMBIGUOUS。无法接管就干脆不注册。
    const handle = selectionHandleOf(web)
    if (handle === undefined) {
      this.warn('codebuddy web: this dsh-web build does not expose provider selection fields; not registering (register-only could make selection ambiguous for every other provider)')
      return
    }
    const options = {
      session: this.options.session,
      gatewayRoot: this.options.gatewayRoot(),
      isAvailable: () => this.isLive(),
    }
    try {
      this.disposers = [
        web.registerSearchProvider(new CodeBuddySearchProvider(options)),
        web.registerFetchProvider(new CodeBuddyFetchProvider(options)),
      ]
    } catch (error: unknown) {
      // 例如 id 已被占用（WEB_DUPLICATE_PROVIDER）：回滚已注册的一半，保持不变式。
      for (const dispose of this.disposers.reverse()) dispose()
      this.disposers = []
      this.warn(`codebuddy web: provider registration failed: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    this.registered = true

    if (handle.kind === 'volatile') {
      // 记住原值再覆盖——free-search 或任何其他 provider 的选择都能在让出时还原。
      this.previousSearch = readVolatileId(handle.sel.searchProvider)
      this.previousFetch = readVolatileId(handle.sel.fetchProvider)
      await this.pinVolatileSelection(handle.sel)
      return
    }
    // 旧 cohort：同步写平铺字段（原逻辑逐字保留）。
    this.previousSearch = handle.sel.searchProviderId
    this.previousFetch = handle.sel.fetchProviderId
    handle.sel.searchProviderId = CODEBUDDY_WEB_PROVIDER_ID
    handle.sel.fetchProviderId = CODEBUDDY_WEB_PROVIDER_ID
    this.pinnedByUs = true
  }

  /**
   * 新 cohort 的钉选：经 settings 服务把选择写进 web entry 的文档。
   *
   * 可见性差异是故意的：写 settings 文档会让钉选显示在「设置 → Web Search」
   * 里，而旧路径只改运行期字段、用户看不见。透明化——用户能看到搜索正走谁，
   * 也能亲手改回去（改回去后徽标跟着字段走，会如实报 unavailable）。
   */
  private async pinVolatileSelection(volatileSel: VolatileWebSelection): Promise<void> {
    const settings = this.settingsSeam()
    if (settings === undefined) {
      // 路径 B：宿主没有 settings seam，只注册、把钉选留给用户在设置页做。
      // 这是行为降级——backendState 会如实报 unavailable，直到用户亲手钉选我们。
      this.pinnedByUs = false
      this.warn('codebuddy web: this dsh-web build pins providers through settings, but no settings service is mounted; registered only (pin codebuddy in Settings → Web Search to use this backend)')
      return
    }
    // 闭包里再记一份旧值：在 mutate 在飞期间若被释放/关闭，字段会被 release
    // 清掉——事后回滚不能信字段，只能信这里。
    const previousSearch = this.previousSearch
    const previousFetch = this.previousFetch
    this.pinnedByUs = true
    try {
      // 两个 op 假设宿主一次 mutate 原子落盘：若 search 落了而 fetch 没落，
      // 会短暂出现「搜索走我们、抓取走别人」的分裂——宿主的 mutate 即单次
      // patch 应用，接受该假设（还原路径的单次 mutate 同理）。
      await settings.mutate('web', [
        { op: 'set', path: ['searchProvider'], value: CODEBUDDY_WEB_PROVIDER_ID },
        { op: 'set', path: ['fetchProvider'], value: CODEBUDDY_WEB_PROVIDER_ID },
      ])
    } catch (error: unknown) {
      // 钉选失败则回滚注册：占着位子却没钉上，在未钉选组合里同样制造
      // AMBIGUOUS——干脆都不占，保持「注册 ⟺ 已钉上」。
      for (const dispose of this.disposers.reverse()) dispose()
      this.disposers = []
      this.registered = false
      this.pinnedByUs = false
      this.warn(`codebuddy web: could not pin the provider selection via settings: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    // mutate 在飞期间若已被释放/关闭，刚写下的钉选已无人负责：用闭包里的旧值
    // 立即还回去，避免留下一个永远还不掉的钉选。
    if (this.disposed || !this.registered || !this.enabled || !this.loggedIn) {
      await this.writeVolatileSelection(volatileSel, { search: previousSearch, fetch: previousFetch })
      this.pinnedByUs = false
      this.previousSearch = undefined
      this.previousFetch = undefined
    }
  }

  /**
   * 经 settings 服务写新 cohort 的选择（钉选后的回滚与让出时的还原共用）。
   * 只写当前仍指向我们的那一半——期间若别人抢走了选择，改回去会破坏它的选择
   *（旧路径的守卫在这里同样成立）。失败只告警、不抛：调用方（reconcile 的
   * 两端与 effect 清理）都不适合把异常抛给宿主。
   */
  private async writeVolatileSelection(
    volatileSel: VolatileWebSelection,
    values: { search: string | undefined; fetch: string | undefined },
  ): Promise<void> {
    // 守卫（与旧路径相同）：只写当前仍指向我们的那一半。search/fetch 各自认领，
    // 一半被抢走不影响另一半的还原。
    const currentSearch = readVolatileId(volatileSel.searchProvider)
    const currentFetch = readVolatileId(volatileSel.fetchProvider)
    const ops: SettingsPathOp[] = []
    if (currentSearch === CODEBUDDY_WEB_PROVIDER_ID) {
      ops.push(values.search === undefined
        ? { op: 'unset', path: ['searchProvider'] }
        : { op: 'set', path: ['searchProvider'], value: values.search })
    }
    if (currentFetch === CODEBUDDY_WEB_PROVIDER_ID) {
      ops.push(values.fetch === undefined
        ? { op: 'unset', path: ['fetchProvider'] }
        : { op: 'set', path: ['fetchProvider'], value: values.fetch })
    }
    if (ops.length === 0) return
    const settings = this.settingsSeam()
    if (settings === undefined) return
    try {
      await settings.mutate('web', ops)
    } catch (error: unknown) {
      this.warn(`codebuddy web: could not write the provider selection via settings: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private async release(): Promise<void> {
    for (const dispose of this.disposers.reverse()) dispose()
    this.disposers = []
    const wasRegistered = this.registered
    this.registered = false
    if (!wasRegistered) return

    const web = this.ctx.get('web')
    if (web === undefined) return
    const handle = selectionHandleOf(web)
    if (handle?.kind === 'volatile') {
      // 路径 B（pinnedByUs 为 false）本来就没钉过：只注销、不碰选择，
      // 用户在设置页的手动钉选必须原样保留。
      if (!this.pinnedByUs) return
      await this.writeVolatileSelection(handle.sel, { search: this.previousSearch, fetch: this.previousFetch })
      this.pinnedByUs = false
      this.previousSearch = undefined
      this.previousFetch = undefined
      return
    }
    const selection = handle?.kind === 'legacy' ? handle.sel : undefined
    if (selection === undefined) return
    // 仅当我们仍是占用者才还原：期间若别人抢走了字段，改回去会破坏它的选择。
    if (selection.searchProviderId === CODEBUDDY_WEB_PROVIDER_ID) selection.searchProviderId = this.previousSearch
    if (selection.fetchProviderId === CODEBUDDY_WEB_PROVIDER_ID) selection.fetchProviderId = this.previousFetch
    this.pinnedByUs = false
    this.previousSearch = undefined
    this.previousFetch = undefined
  }
}
