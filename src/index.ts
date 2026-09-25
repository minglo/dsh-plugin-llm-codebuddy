import { resolveRetryPolicy, RetryPolicySchema } from '@deepseek-ai/dsh-llm'
import type { RetryPolicyConfig } from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
// 类型增强（运行时零副作用）：loader 提供 `ctx.loader` 与 'loader/volatile-update' 事件。
import type {} from '@deepseek-ai/cordis-plugin-loader'
import z from '@deepseek-ai/schemastery'
import { CodeBuddyAdapter } from './adapter.js'
import type { CodeBuddyConnectionOptions } from './adapter.js'
import { CodeBuddySession } from './session.js'
import { CodeBuddyRemoteService } from './remote.js'
import { configureSettingsPage, readSettings } from './settings-ns.js'
import { CodeBuddyWebSync, gatewayRootOf } from './web-sync.js'
import { registerCodeBuddyFlow } from './login-flow.js'
import { CODEBUDDY_CHAT_BASE, CODEBUDDY_PROVIDER, DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS, DEFAULT_STREAM_IDLE_TIMEOUT_MS, PACKAGE_NAME, PLUGIN_NAME } from './constants.js'

export const name = PLUGIN_NAME
export const inject = ['llm']

export interface Config {
  baseURL?: string
  defaultContextWindow?: number
  defaultMaxTokens?: number
  streamIdleTimeoutMs?: number
  /** provider 自持的重试策略；省略即宿主默认。 */
  retryPolicy?: RetryPolicyConfig
  /** 侧边栏用量指示器。0.1.7 起声明为本插件自己的 volatile Config 字段。 */
  showUsage?: boolean
  /**
   * 用 CodeBuddy 网关的搜索/抓取后端接管 web_search / web_fetch。
   * 默认 false：装了插件即静默抢走别人的默认搜索位是破坏性默认值。
   */
  webSearch?: boolean
}

export const Config = z.object({
  baseURL: z.string().default('https://copilot.tencent.com/v2'),
  defaultContextWindow: z.number().default(DEFAULT_CONTEXT_WINDOW),
  defaultMaxTokens: z.number().default(DEFAULT_MAX_TOKENS),
  streamIdleTimeoutMs: z.number().default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  // schemastery 的对象字段默认可选，无需 .optional()；省略即宿主默认策略。
  retryPolicy: RetryPolicySchema,
  // 两个用户开关都是 volatile：loader 的 _commitVolatile 在不重挂插件的前提下
  // 就地提交变更（并发 loader/volatile-update），webSync 据此实时注册/注销
  // provider，切开关不再打断进行中的会话。
  showUsage: z.boolean().default(true).volatile(),
  webSearch: z.boolean().default(false).volatile(),
})

export function resolveConnectionOptions(config: Config = {}): CodeBuddyConnectionOptions {
  const positiveInteger = (value: number | undefined, field: string, fallback: number): number => {
    if (value === undefined) return fallback
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`${PACKAGE_NAME}: ${field} must be a positive integer`)
    }
    return value
  }
  const streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS
  if (!Number.isFinite(streamIdleTimeoutMs) || streamIdleTimeoutMs <= 0) {
    throw new Error(`${PACKAGE_NAME}: streamIdleTimeoutMs must be a positive finite number`)
  }
  const baseURL = config.baseURL ?? CODEBUDDY_CHAT_BASE
  if (baseURL.length === 0) {
    throw new Error(`${PACKAGE_NAME}: baseURL must not be empty`)
  }
  return {
    baseURL: baseURL.replace(/\/+$/, ''),
    defaultContextWindow: positiveInteger(config.defaultContextWindow, 'defaultContextWindow', DEFAULT_CONTEXT_WINDOW),
    defaultMaxTokens: positiveInteger(config.defaultMaxTokens, 'defaultMaxTokens', DEFAULT_MAX_TOKENS),
    streamIdleTimeoutMs,
    retryPolicy: resolveRetryPolicy(config.retryPolicy, `${PACKAGE_NAME}: retryPolicy`),
  }
}

/** 多久重读一次目录以发现服务端编辑，毫秒。 */
const CATALOG_POLL_INTERVAL_MS = 5 * 60 * 1000

/**
 * 当前界面语言的宿主可读来源。
 *
 * 0.1.7 不再有 `settings.get('locale')`：语言偏好由 dsh-client-locale 声明为
 * 它自己的 volatile Config 字段（entry id `locale`，字段 `preference`），落在本
 * profile patch 的该 entry 上。这里读 loader 里那个 entry 的 live config——
 * 与客户端实际生效的是同一份值。entry 未组合（headless 等）时返回 undefined，
 * 错误文案按英文上报。每次失败重新读，故用户切语言无需重启或重新注册路由。
 */
function currentLanguage(ctx: Context): () => string | undefined {
  return () => {
    let config: unknown
    for (const entry of ctx.loader.entries()) {
      if (entry.options.id === LOCALE_ENTRY_ID) { config = entry.fiber?.config; break }
    }
    const section = config as Record<string, unknown> | undefined
    const preference = section?.preference
    return typeof preference === 'string' && preference.length > 0 ? preference : undefined
  }
}

/** dsh-client-locale 在 base/web bundle 里的 profile entry id（`id: locale`）。 */
const LOCALE_ENTRY_ID = 'locale'

export function apply(ctx: Context, config: Config = {}): void {
  const resolved = resolveConnectionOptions(config)
  const session = new CodeBuddySession(ctx)
  const adapter = new CodeBuddyAdapter({ session, options: () => resolved, language: currentLanguage(ctx) })
  ctx.llm.registerAdapter([CODEBUDDY_PROVIDER], adapter)

  // 设置页策略：不自动生成本 entry 的表单页（卡片是手写的 plugins.item 槽）。
  configureSettingsPage(ctx)

  // 设置开关的权威值读 apply 收到的 config：它与 fiber.config 是**同一个对象**
  //（volatile 引用也共享同一实例，loader 提交后两边同步），而 Remote 方法里的
  // this.ctx 绑到调用方上下文，读不到本插件 fiber——所以从这里把句柄传下去。
  const settingsOf = (): { showUsage: boolean; webSearch: boolean } => readSettings(config)

  // 目录编辑会改变本路由对外宣称的模型。Web 客户端据以渲染 provider 分组的
  // harness 目录是**客户端侧缓存**的，只在 `llm/adapters-updated`（或设置与凭据事件）
  // 时才重拉；不重发这个事件，服务端新增/删除的模型会一直留在选择器里——
  // 删掉的还能选（选中即 400），新增的则渲染成裸行（按 id 索引的富化表没有它的条目）。
  // session 报的是内容变化，这里是唯一把它翻译成宿主拓扑事件的地方。
  ctx.effect(() => session.onCatalogChange(() => {
    ctx.emit('llm/adapters-updated')
  }), `${PACKAGE_NAME}: catalog change announcements`)

  // 给一个从不重开菜单的长开 Web 客户端兜底：按它自己 TTL 的节奏重读目录并播报变化。
  // 读取是咨询式的（失败只记日志并解析为空），内容没变就不发任何东西，
  // 所以闲置的 harness 每个周期只花一次 config 读，客户端零 churn。
  // `unref` 让这个维护定时器不至于自己把进程撑住。
  ctx.effect(() => {
    const timer = setInterval(() => {
      void session.refreshCatalog()
    }, CATALOG_POLL_INTERVAL_MS)
    timer.unref?.()
    return () => { clearInterval(timer) }
  }, `${PACKAGE_NAME}: catalog change polling`)
  // web 接管的编排器：常驻（开关关闭时它自身不注册任何东西）。
  // baseURL 每次解析，跟随组合层配置；gatewayRoot 去掉 chat 面的 /v2 段。
  // 初值来自组合层 config（volatile 字段已在 fiber.config 上，含 schema 默认）。
  const webSync = new CodeBuddyWebSync(
    ctx,
    {
      session,
      gatewayRoot: () => gatewayRootOf(resolved.baseURL),
      warn: (message) => { ctx.logger.warn(message) },
    },
    settingsOf().webSearch,
  )
  // volatile 开关被 loader 就地提交时（loader/volatile-update），对账一次接管态。
  ctx.on('loader/volatile-update', () => { webSync.setEnabled(settingsOf().webSearch) })
  // 远端能力：gateway 的 Typert 服务，复用同一 session（remote.ts 的 refresh 走它）。
  // searchBackend 把「搜索此刻实际走谁」报给设置卡片徽标：先做一次自愈对账
  // （启动那一刻可能读不到凭据，而磁盘上原有的 grant 不会发事件来纠正），
  // 再读实时状态。必须返回 Promise——对账要读凭据，是异步的。
  new CodeBuddyRemoteService(ctx, {
    session,
    settings: settingsOf,
    searchBackend: async () => {
      await webSync.resync()
      return webSync.backendState()
    },
  })
  // settings 命名空间：showUsage + webSearch 现在是本插件 Config 的 volatile 字段
  // （声明见上方 Config），持久化走 settings.mutate（见 settings-ns.updateSettings）。
  // web provider 的注册/注销与登录态联动（未登录不注册）。
  ctx.inject(['web'], () => { webSync.start() })
  // authorization 登录 flow（headless 无 authorization seam 时静默跳过）
  ctx.inject(['authorization'], (authCtx) => {
    registerCodeBuddyFlow(authCtx as Context)
  })
}
