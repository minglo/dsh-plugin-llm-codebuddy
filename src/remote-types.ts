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
  /** 是否用 CodeBuddy 后端接管 dsh 的 web_search / web_fetch。 */
  webSearch: boolean
}

export type { UsageView }
