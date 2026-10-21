/**
 * 输入框模型标签（以及后续任何读同一份目录的入口）**共用的唯一轮询器**。
 *
 * 为什么要有这一层：标签要显示促销徽标、分层与积分倍率，这些元数据全在
 * `remote.models()` 的返回里。让每个渲染入口各自 `setInterval`，同一账号、同一
 * 时刻会对宿主（进而对腾讯网关）发出多份完全相同的目录读取；收敛成「一个
 * remote 一个 feed」后，订阅者共享同一份快照与同一次在途请求，标签与目录菜单
 * 也不会显示对不上的倍率。
 *
 * 周期取 60 秒，而不是用量入口的 10 秒：目录里的促销带**时间窗**（例如 23:00
 * 开夜场、08:00 收），而宿主是每次调用现判「此刻是否生效」。也就是说，客户端
 * 的轮询间隔本身就是徽标对时间窗边界可能滞后的上限——60 秒足够让换场后的徽标
 * 在一分钟内出现；用量数字变化快，目录不是。
 *
 * 失败策略与 `usage-feed` **刻意不同**：用量读取失败意味着「没有额度可显示」，
 * 清空是诚实的；目录读取失败意味着「暂时拿不到促销/倍率」，清空会让每一行瞬间
 * 退化成裸名字——这正是宿主侧会话层花力气避免的那种抖动。所以这里失败时保留
 * 上一份好快照，等下一轮或登录态变化再修。
 *
 * 快照对象只在内容真正变化时替换引用：`useSyncExternalStore` 靠引用判等，
 * 每 tick 新建对象会让所有订阅者无谓重渲染。
 */
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { CodeBuddyModelEntry, CodeBuddyModelsResult } from '../remote-types.js'
import { subscribeLoginChange } from './notifiers.js'
import { unwrap, withTimeout } from './shared.js'

/** 轮询周期。见文件头：60 秒是徽标对促销时间窗边界（23:00 / 08:00）的滞后上限。 */
export const MODEL_REFRESH_MS = 60_000

/**
 * 单次外呼硬超时；网关挂住时不能让单飞标志永远不解除。
 *
 * 取 30 秒＝**短于**轮询周期（60 秒）。超时若长于周期，一次挂住的读取会横跨
 * 多个 tick，单飞把后续每一轮都挡掉，轮询就此静默死掉——界面上的倍率停在某一
 * 刻不再变，却看不出已经停止更新。短于周期时，最坏只是那一轮落空、下一 tick
 * 立刻重试。
 */
export const MODEL_READ_TIMEOUT_MS = 30_000

/** 一份目录快照。两个字段要么整组来自同一次成功读取，要么整组保持上一次。 */
export interface ModelFeedSnapshot {
  /** 是否已登录。false 表示「未登录」或「还没读到」——两者都不该有目录。 */
  loggedIn: boolean
  /** 完整目录（不是过滤子集）：没有富化的模型也在列，客户端按 id 匹配。 */
  models: readonly CodeBuddyModelEntry[]
}

const EMPTY: ModelFeedSnapshot = { loggedIn: false, models: [] }

/**
 * 空态用的稳定对象。必须是**同一个实例**：`useSyncExternalStore` 用
 * `Object.is` 比较快照，每次新建空对象会被判成「变了」，触发无限重渲染。
 */
export const EMPTY_MODEL_SNAPSHOT: ModelFeedSnapshot = EMPTY

/** 目录远端面：与 `ctx.remote.codebuddy` 的 `models()` 同形，只取 feed 需要的方法。 */
export interface ModelRemote {
  models(): Promise<RemoteResult<CodeBuddyModelsResult>>
}

/** 一个 remote 对应一个 feed；订阅者拿到的读写面。 */
export interface ModelFeed {
  subscribe(listener: () => void): () => void
  getSnapshot(): ModelFeedSnapshot
  /** 立即重读一次（登录态变化时用；不改变订阅计数）。 */
  refresh(): void
}

/**
 * 一个 feed = 一个 remote 的一份共享目录。
 *
 * 订阅者归零时**不丢弃快照**：它是「上一份好目录」，重挂时先拿它占位、再等
 * 立即重读的结果，比先闪一帧空标签更稳。真正的失效判定在宿主侧（促销按调用
 * 时刻现判），客户端保留的只是最后一次读到的内容。
 *
 * 但这份保留只对**同一账号**成立：登录态一翻转，目录的归属就换了主人，旧账号
 * 的模型/徽章/倍率哪怕多留一帧也是串号。所以登录监听是**常驻**的（stop 时不
 * 取消订阅，见 stop 上的注释），翻转瞬间先同步落成空态、再重读新账号的目录。
 * 代价是切换账号那一刻在线的订阅者会闪一帧空态——这是故意的：空一帧比把 A
 * 账号的促销亮给 B 账号看诚实。
 *
 * 与 `usage-feed` 的区别正在这里：用量 feed 在 stop 时直接清空快照（它的空态
 * 本来就是诚实的「没有额度」），我们保留快照是为了同账号重挂不闪空；保留的
 * 代价由这份常驻监听兜底——无人订阅时发生的登出/切换照样把快照清掉，后来者
 * 首帧只能看到空态，不会看到上一个账号的东西。
 */
class Feed implements ModelFeed {
  private snapshot: ModelFeedSnapshot = EMPTY
  private readonly listeners = new Set<() => void>()
  private timer: number | undefined
  /**
   * 登录监听常驻、不随订阅者归零取消：最后一个人离开后发生的登出/切换账号，
   * 也要有人把上一份快照作废，否则后来者首帧会看到上一个账号的目录。
   * 常驻的代价只是一次空转的同步置空（refresh 在无人订阅时直接早退，不外呼）。
   */
  private loginUnsubscribe: (() => void) | undefined
  private busy = false
  private disposed = false

  constructor(private readonly remote: ModelRemote) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    if (this.listeners.size === 1) this.start()
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size === 0) this.stop()
    }
  }

  getSnapshot = (): ModelFeedSnapshot => this.snapshot

  refresh = (): void => { void this.readOnce() }

  private start(): void {
    this.disposed = false
    // 登录/退出成功后立即重读：不重读就要等满一个周期才看到新账号的目录，
    // 那段时间标签会拿旧目录去匹配新账号的模型 id。
    // 监听只建一次、stop 时不拆（见 loginUnsubscribe 上的注释）：重读本身在
    // 无人订阅时早退，但翻转瞬间的同步置空必须有人执行。
    if (this.loginUnsubscribe === undefined) {
      this.loginUnsubscribe = subscribeLoginChange(this.handleLoginChange)
    }
    void this.readOnce()
    this.timer = window.setInterval(() => { void this.readOnce() }, MODEL_REFRESH_MS)
  }

  /**
   * 登录态翻转（登录/退出/切换账号成功）时旧账号的目录立刻作废：先同步落成
   * 空态，再重读。同步这一步不能省——只靠重读覆盖的话，无人订阅时重读会早退，
   * 后来者首帧看到的还是上一个账号的模型/徽章/倍率。
   */
  private handleLoginChange = (): void => {
    this.publish(EMPTY)
    this.refresh()
  }

  private stop(): void {
    this.disposed = true
    // 快照与登录监听都保留：快照留给同账号重挂时占位（免得闪一帧空标签）；
    // 监听留给翻转瞬间作废快照。两者配合：同账号重挂无闪烁，换账号重挂无串号。
    if (this.timer !== undefined) window.clearInterval(this.timer)
    this.timer = undefined
  }

  /**
   * 单飞：上一轮没回来就跳过这一轮。网关慢于周期时，排队等着的请求会在恢复后
   * 一次性倾泻，而它们读的是同一份目录——跳过不丢信息。
   *
   * 出站成本也不完全由这里的频率决定：宿主侧目录缓存会吸收重复读取，轮询快
   * 只是「问得勤」，让界面更快看到宿主已经刷出来的新促销。
   */
  private async readOnce(): Promise<void> {
    if (this.busy || this.disposed || this.listeners.size === 0) return
    this.busy = true
    try {
      const result = await withTimeout(unwrap(this.remote.models()), MODEL_READ_TIMEOUT_MS)
      if (this.disposed) return
      // 未登录是**成功的读数**：目录确实为空，发布共享空态而不是留着上一次的。
      this.publish(result.loggedIn ? { loggedIn: true, models: result.models } : EMPTY)
    } catch {
      // 与 usage-feed 刻意相反：失败时**保留上一份好快照**，不清空。
      // 一次抖动绝不许把每一行的标签和积分倍率都抹掉；下一 tick 或登录态
      // 变化会再试，成功时自然覆盖。
    } finally {
      this.busy = false
    }
  }

  /** 只在内容变化时换引用：`useSyncExternalStore` 靠引用判等，避免无谓重渲染。 */
  private publish(next: ModelFeedSnapshot): void {
    if (sameContent(this.snapshot, next)) return
    this.snapshot = next
    for (const listener of this.listeners) listener()
  }
}

/**
 * 按内容判等，而不是按引用：宿主每次 `models()` 都会解码出全新的对象/数组，
 * 引用永远不同；靠引用判等会让每个 tick 都通知所有订阅者重渲染。
 *
 * 用序列化而不是手写逐字段比较：wire 快照是纯 JSON（没有函数、Symbol、循环
 * 引用），一次序列化就是精确的结构比较；目录规模几十到几百条、60 秒一次，
 * 成本可忽略。手写比较则要覆盖 `rate` / `description` / `promotion` / `tier`
 * 里每一个字段，漏一个的后果就是该字段的变化不上屏。键序不同会被判成变化，
 * 代价只是一次多余重渲染，不会显示错内容。
 */
function sameContent(a: ModelFeedSnapshot, b: ModelFeedSnapshot): boolean {
  return a.loggedIn === b.loggedIn && JSON.stringify(a.models) === JSON.stringify(b.models)
}

/**
 * 按 remote 身份取 feed。
 *
 * WeakMap 而不是单例：测试里每个用例都会新建一个 remote 桩，按键隔离能让用例
 * 之间不串状态（否则上一个用例的定时器会把读数带进下一个用例），同时前一个
 * remote 被回收后 feed 也随之回收，无需手工清理。
 */
const feeds = new WeakMap<ModelRemote, ModelFeed>()

export function modelFeed(remote: ModelRemote): ModelFeed {
  let feed = feeds.get(remote)
  if (feed === undefined) {
    feed = new Feed(remote)
    feeds.set(remote, feed)
  }
  return feed
}
