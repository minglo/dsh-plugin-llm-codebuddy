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
}

export interface SettingsView {
  showUsage: boolean
  /** 是否用 CodeBuddy 后端接管 dsh 的 web_search / web_fetch。 */
  webSearch: boolean
}

export type { UsageView }
