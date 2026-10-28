// host 与 client 共享的 wire 类型，唯一来源
import type { FingerprintGuess } from './channel-fingerprint.js'
import type { UsageView } from './usage.js'

/**
 * web_search / web_fetch 当前**生效**的后端——读 seam 的实际选择字段，而不是
 * 设置开关的意图（两者会不一致：开关开着但未登录、或接管失败时，意图都是「开」）：
 *   · 'codebuddy'   —— 选择字段确指向本插件：搜索真的走 CodeBuddy 网关；
 *   · 'default'     —— 走别人／未接管：开关关闭、未登录，或选择字段被第三方持有；
 *   · 'unavailable' —— 开关与登录都满足，但接管没能成立（无 web seam、host 未暴露
 *                      选择字段、provider id 冲突…）；此时搜索同样不是 CodeBuddy。
 */
export type SearchBackendState = 'codebuddy' | 'default' | 'unavailable'

export interface StatusView {
  loggedIn: boolean
  /**
   * 凭据在磁盘上，但已经无法再认证。与 `loggedIn: false` 的区别是：
   * 前者是「从没登过」，这里是「登过但过期了」——客户端据此说「请重新登录」，
   * 而不是冷冰冰的「未登录」（后者读起来像什么都没发生过，掩盖了缺的是重新登录）。
   */
  expired?: boolean
  userId?: string
  tenantId?: string
  enterpriseId?: string
  /**
   * 缺省表示该组合里根本没有 web 接管编排器（headless／无 web seam 注入），
   * 客户端据此不渲染徽标——与「读到 default」是两回事。
   */
  searchBackend?: SearchBackendState
}

export interface LoginStart {
  authUrl: string
  state: string
}

export interface LoginPoll {
  done: boolean
}

export interface UsageResult {
  loggedIn: boolean
  view?: UsageView
  /**
   * 该读数的**抓取时刻**（宿主时钟，毫秒）。
   *
   * 由宿主给而不是客户端 `Date.now()`：宿主缓存会让一次抓取服务多个入口与
   * 多次重挂，各客户端各自打时间戳会把同一份读数标成不同时间。可选——旧宿主
   * 不发它，客户端回落到「本次读到」的时刻。
   */
  fetchedAt?: number
}

/**
 * 今日签到态（宿主与客户端共享的 wire 类型，唯一来源）。
 *
 * `available` 与 `active` 是两件事：**接口读得到**（available）与**账号参与这个
 * 活动**（active）。前者为假时客户端连签到入口都不给（省一次无谓外呼），
 * 后者为假时入口在、但点了会失败。
 */
export interface CheckinStatusView {
  /** 宿主是否成功读到了签到态（未登录 / 接口不可读时为 false）。 */
  available: boolean
  /** 活动是否开启。 */
  active: boolean
  /** 今日是否已签到。 */
  checkedIn: boolean
  /** 连签天数（0 = 无从得知）。 */
  streakDays: number
  /** 今日签到可得积分。 */
  dailyCredit: number
  /** 今日已得积分。 */
  todayCredit: number
}

/**
 * 一次签到的结果（宿主与客户端共享的 wire 类型，唯一来源）。
 *
 * `message` 是服务端原文（可能是「今日已签到」「活动未开启」），**不翻译**：
 * 客户端只在确实失败时把它当作补充说明，主文案仍用本地化的那一句。
 */
export interface CheckinResultView {
  success: boolean
  /** 失败原因（成功时缺省）。 */
  message?: string
  /** 本次签到得到的积分。 */
  credit: number
  /** 签到后的连签天数。 */
  streakDays: number
}

export interface SettingsView {
  showUsage: boolean
  /**
   * 提示输入框工具行里的额度胶囊（模型选择器左侧）。
   *
   * optional 是刻意的：host 与 client 是两个独立产物（浏览器 bundle 可经 HMR
   * 单独替换），旧 host 不发这个字段时客户端必须能 decode 成功并按默认值处理，
   * 而不是让整张配置卡片因解码失败而消失。见 status.searchBackend 的同款取舍。
   */
  showComposerUsage?: boolean
  /**
   * 遇到 429（频率限制）是否等待到重置时刻再自动重试。默认关。
   *
   * 与 showComposerUsage 同款取舍：optional。host 与 client 是两个独立产物，
   * 旧 host 不发这个字段时客户端必须能 decode 并按默认值（关）处理。
   */
  waitOnRateLimit?: boolean
  /** 是否用 CodeBuddy 后端接管 dsh 的 web_search / web_fetch。 */
  webSearch: boolean
}

export type { UsageView }

/**
 * 一次真实请求被上游渠道校验拒收（`code=11128`）的现场（宿主与客户端共享的
 * wire 类型，唯一来源）。
 *
 * 放在这里而不是 channel-health 里：`adapter` 只能 import 类型、不能 import 那个
 * 实现，否则适配器就要依赖落盘模块，两条边会成环。
 *
 * 这组字段是规则再收紧时唯一的证据——用户下次报障，`recentBlocks` 直接说明
 * 「什么时候开始拦的、拦的是什么形状的提示」。
 */
export interface ChannelBlockRecord {
  /** 被拒收的时刻（宿主时钟，毫秒）。 */
  at: number
  /** 上游回执里的 `x-request-id`；没有时缺省。 */
  requestId?: string
  /**
   * 这次请求**发出**的 `X-User-Id`（值来自凭据 JWT），不是服务端回执——响应里
   * 没有这个头。
   *
   * 可选：旧记录、以及不带 uid 的凭据都没有它。`$DSH_HOME` 可能被多个账号共用，
   * 缺了它，文件就说不清是哪一次登录被拦；字段名写死为 `sentUserId`，避免读的人
   * 以为它是服务端回显。
   */
  sentUserId?: string
  /** 请求打到的网关地址，用来区分官方站点与自建代理。 */
  endpoint: string
  /**
   * 该次请求 system 正文的**原始**长度。
   *
   * 记宿主交来的那一份，不是改写后发出去的那一份：改写保证发出去的正文不再含
   * 整句指纹，按它判定永远得到 `unknown`，字段就退化成常量。
   */
  systemLength: number
  /** 已确立的指纹在原始 system 里的位置（见 channel-fingerprint.ts）。 */
  fingerprintGuess: FingerprintGuess
}

/**
 * 探针对渠道校验的结论（宿主与客户端共享的 wire 类型，唯一来源）。
 *
 * 前 5 个是本插件自己算出来的判断：规则在且改写有效（healthy）、
 * 规则已经不拦了（rule-gone）、改写是否还管用（neutralization-broken）、
 * 证据自相矛盾（inconsistent）、探针自身没跑完（stage-failed）。
 * 后 6 个是把上游的拒绝原样归类：渠道拒收（channel-rejected）、认证失败（auth）、
 * 限流（rate-limited）、额度用尽（quota）、服务不可用（unavailable）、
 * 根本连不上（unreachable）。
 *
 * 分成两段是刻意的：客户端对「我们测出来的」和「服务端说的」给的是不同文案，
 * 混成一个枚举会让「渠道没问题但这次探测被限流」被误报成渠道故障。
 *
 * 声明成运行时常量而非纯类型：宿主要在下发前按同一份闭集复验读盘内容，
 * client descriptor 的 z.enum 也从这里取值——两处各列一份迟早会漂移，
 * 而漂移的后果是一份旧文件让整张卡片 decode 失败。
 */
export const CHANNEL_VERDICTS = [
  'healthy', 'rule-gone', 'neutralization-broken', 'inconsistent', 'stage-failed',
  'channel-rejected', 'auth', 'rate-limited', 'quota', 'unavailable', 'unreachable',
] as const

export type ChannelVerdict = typeof CHANNEL_VERDICTS[number]

/**
 * 探针三阶段里某一阶段的观察值（宿主与客户端共享的 wire 类型，唯一来源）。
 *
 * 只记事实、不记判断：HTTP 状态、上游信封里的 code、回执 id、以及这次响应
 * 是不是在说额度用尽。判定表吃这组事实得出 verdict，因此判定不需要网络也不需要
 * 读文案——可以逐行测。
 */
export interface ProbeStage {
  stage: 'A' | 'B' | 'C'
  status?: number
  code?: number
  requestId?: string
  /**
   * 该阶段响应是否在说「额度用尽」。由探针读取响应体时用宿主的
   * `isQuotaExceededError(text)` 算好填进来，判定函数因此不碰文案、不碰网络。
   */
  quota?: boolean
}

/**
 * 一次探针的结果（宿主与客户端共享的 wire 类型，唯一来源）。
 *
 * `stages` 全量下发而不只是 verdict：用户报障时「哪一阶段、什么状态码」是唯一
 * 能复查的东西，只留一个结论等于把证据扔掉。
 */
export interface ProbeResultView {
  verdict: ChannelVerdict
  at: number
  /** 探针使用的模型；未登录、或目录读不出而没有可用模型时为空串，客户端此时只显示 verdict。 */
  model: string
  stages: ProbeStage[]
}

/**
 * 渠道校验卡片要显示的全部内容（宿主与客户端共享的 wire 类型，唯一来源）。
 *
 * 与宿主落盘用的完整记录（见 `channel-health.ts` 的 `StoredHealth`）相比是刻意
 * 收窄的：磁盘上留的是完整拦截记录（排查用），下发给浏览器的只有「最近一次拦截的
 * 时刻与指纹位置」——请求 id 与 endpoint 属于机器内部信息，卡片不需要。
 */
export interface ChannelHealthView {
  /** 本部署是否跑渠道校验（仅官方端点）。为假时客户端整行隐藏。 */
  applicable: boolean
  lastProbe?: ProbeResultView
  lastBlock?: { at: number; fingerprintGuess: FingerprintGuess }
}

/**
 * 一条倍率读数（宿主与客户端共享的 wire 类型，唯一来源）。
 *
 * 归一化成 x 在前的 `xN`（见 src/rate.ts 的 normalizeCredits）：目录价与促销价
 * 在服务端是两种拼写，客户端只认这一种。`current` 缺省时与 `base` 相同；
 * `strikethrough` 为真时客户端把原价划线、并列展示现价。
 */
export interface RateView {
  base?: string
  current?: string
  strikethrough: boolean
  free: boolean
}

/**
 * 一段中英双语的展示文案（宿主与客户端共享的 wire 类型，唯一来源）。
 *
 * 两版都下发、由客户端按当前语言挑选：宿主侧读到的 `locale.preference` 只有
 * 在用户手动选过语言时才有值，从没手选过的用户宿主根本不知道浏览器是中文
 * 还是英文——在宿主侧拼本地化串会猜错，所以本地化发生在客户端。
 */
export interface LocalizedText {
  zh?: string
  en?: string
}

/**
 * 一条生效促销的展示投影（宿主与客户端共享的 wire 类型，唯一来源）。
 *
 * 只带展示事实：徽标文案与颜色、tooltip 文案、压好的一行时间窗。
 * 不带连接串、token、凭据或服务端内部 id——浏览器只需要知道画什么。
 */
export interface PromotionView {
  /** 服务端徽标原文（只有中文），原样透传、不猜译。 */
  label: string
  /** 服务端徽标颜色；缺省时宿主补中性灰，空颜色会渲染出隐形药丸。 */
  color: string
  /** tooltip 文案，取服务端 hover 的中英两版。 */
  text?: LocalizedText
  /** 宿主把 schedule 压成的一行（客户端不做日期运算）；无排期时缺省。 */
  window?: string
}

/**
 * 一条分层的展示投影（宿主与客户端共享的 wire 类型，唯一来源）。
 *
 * 分层没有时间表，只做匹配、不做生效判断；同样只带 label 与说明文案。
 */
export interface TierView {
  /** 服务端给的徽标文案，原样显示的中性色徽标。 */
  label: string
  /** 分层说明，取服务端 hover 的中英两版。 */
  text?: LocalizedText
}

/**
 * 目录里一个模型的富化条目（宿主与客户端共享的 wire 类型，唯一来源）。
 *
 * `rate` / `description` / `promotion` / `tier` 全是 optional：没有目录价、
 * 没有描述、没有命中促销／分层的模型照样在列（客户端按 id 匹配），缺谁省谁。
 */
export interface CodeBuddyModelEntry {
  id: string
  name: string
  /** 当前展示价：目录基础价与此刻生效的促销价。 */
  rate?: RateView
  /** 模型描述的中英两版（见 LocalizedText：语言由客户端挑）。 */
  description?: LocalizedText
  /** 此刻生效的一条促销（判定层已按 priority 选过）；没有则缺省。 */
  promotion?: PromotionView
  /** 命中的分层；没有则缺省。 */
  tier?: TierView
}

/**
 * `models()` 的返回（宿主与客户端共享的 wire 类型，唯一来源）。
 *
 * 未登录时就是 `{ loggedIn: false, models: [] }`——登录态判定与 `status()`
 * 同一套（有凭据文件 ≠ 能认证），两边不会对「登没登录」给出矛盾答案。
 */
export interface CodeBuddyModelsResult {
  loggedIn: boolean
  /** 完整目录（不是过滤子集）：没有富化的模型也要在列，客户端按 id 匹配。 */
  models: CodeBuddyModelEntry[]
}
