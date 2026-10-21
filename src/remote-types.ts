// host 与 client 共享的 wire 类型，唯一来源
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
