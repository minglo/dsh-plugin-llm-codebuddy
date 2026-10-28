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
import type { CodeBuddySettings } from './settings-ns.js'
import { CodeBuddyWebSync, gatewayRootOf } from './web-sync.js'
import { recordChannelBlock } from './channel-health.js'
import { registerCodeBuddyFlow } from './login-flow.js'
import { CODEBUDDY_CHAT_BASE, CODEBUDDY_PROVIDER, DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS, DEFAULT_STREAM_IDLE_TIMEOUT_MS, PACKAGE_NAME, PLUGIN_NAME, RATE_LIMIT_WAIT_CAP_MS } from './constants.js'

export const name = PLUGIN_NAME
export const inject = ['llm']

export interface Config {
  baseURL?: string
  defaultContextWindow?: number
  defaultMaxTokens?: number
  streamIdleTimeoutMs?: number
  /**
   * provider 自持的重试策略。
   *
   * 省略时**不是**宿主的默认策略，而是本插件的一份默认：可重试集合、重试次数、
   * 初始退避与抖动都与宿主 normal 默认逐项相同，只把 `backoff.maxDelayMs` 抬高。
   * 原因见 {@link DEFAULT_RETRY_MAX_DELAY_MS}：`providerRetryAfterMs` 只在
   * ≤ `maxDelayMs` 时才被采纳，而服务给出的重置时刻常在几十分钟之后。
   */
  retryPolicy?: RetryPolicyConfig
  /**
   * 侧边栏底部用量指示器。0.1.7 起声明为本插件自己的 volatile Config 字段。
   * 默认 **false**：侧栏底部是常驻状态区，加一条进度条会改变默认界面。
   */
  showUsage?: boolean
  /**
   * 输入框工具行里的额度胶囊（模型选择器左侧）。
   * 默认 **true**：只在选中 CodeBuddy 模型时出现，属按需出现的上下文入口。
   *
   * 必须与 {@link SettingsSchema} 的默认值一致：loader 用本 schema 校验并在
   * `readSettings` 之前填好缺省，两处不一致会让界面默认值与设置页显示分裂。
   */
  showComposerUsage?: boolean
  /**
   * 遇到 429（频率限制）是否等待到报文给出的重置时刻再自动重试。
   *
   * **默认 false（不等）**：429 与普通失败同路——可重试、快速重试几次后抛出，
   * 报文里的重置时刻随错误消息保留，主 agent 据此切换模型继续。开启后最多也只
   * 等 5 小时（适配器硬上限 `RATE_LIMIT_WAIT_CAP_MS`，见 constants.ts）。
   *
   * volatile：切换不重挂插件，每次请求现读。
   */
  waitOnRateLimit?: boolean
  /**
   * 用 CodeBuddy 网关的搜索/抓取后端接管 web_search / web_fetch。
   * 默认 false：装了插件即静默抢走别人的默认搜索位是破坏性默认值。
   */
  webSearch?: boolean
}

export const Config = z.object({
  // 默认值复用常量本身：这里曾把值重抄一遍，而同一文件第 15 行就 import 了
  // CODEBUDDY_CHAT_BASE、第 125 行还在用它——常量一改，默认值就悄悄对不上了。
  baseURL: z.string().default(CODEBUDDY_CHAT_BASE),
  defaultContextWindow: z.number().default(DEFAULT_CONTEXT_WINDOW),
  defaultMaxTokens: z.number().default(DEFAULT_MAX_TOKENS),
  streamIdleTimeoutMs: z.number().default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  // schemastery 的对象字段默认可选，无需 .optional()。省略**不等于**宿主默认策略：
  // resolveConnectionOptions 会补上本插件那份默认（见 defaultRetryPolicyConfig）。
  retryPolicy: RetryPolicySchema,
  // 三个用户开关都是 volatile：loader 的 _commitVolatile 在不重挂插件的前提下
  // 就地提交变更（并发 loader/volatile-update），webSync 据此实时注册/注销
  // provider，切开关不再打断进行中的会话。
  //
  // 这三个字段是本插件配置面的**权威来源**：`updateSettings` 把 `set` op 写进
  // profile patch 后由 loader 用本 schema 校验回灌，`readSettings` 再从句柄取值。
  // 因此字段一旦漏在这里，写入会被 loader 丢弃、读取永远落到兜底值——设置页的
  // 开关看起来能切，实际不生效。默认值也必须与 settings-ns.ts 的 DEFAULT_SETTINGS
  // 一致（见那里的说明）。
  showUsage: z.boolean().default(false).volatile(),
  showComposerUsage: z.boolean().default(true).volatile(),
  waitOnRateLimit: z.boolean().default(false).volatile(),
  webSearch: z.boolean().default(false).volatile(),
})

/**
 * 省略 `retryPolicy` 时的等待上限：与 429 等待硬上限同数（5 小时）。
 *
 * 为什么不沿用宿主的 10 秒默认：`providerRetryAfterMs` 只在 ≤ `maxDelayMs` 时才被
 * 采纳（裁决在 @deepseek-ai/dsh-llm-retry），而 CodeBuddy 在用量被限流时给出的重置
 * 时刻常在几十分钟之后——2026-09-27 实测：16:20 的 429 让等到 17:30，约 70 分钟。
 * 用宿主默认，这个读数会被直接丢弃 → 立刻失败；而这里要的是「到点再试」。
 *
 * 为什么是 5 小时而不是更大：一个回合为一个可能长到隔夜的重置默默挂住，代价远大于
 * 收益。读取数超过它的等待由适配器**直接不挂**（见 constants.ts 的
 * {@link RATE_LIMIT_WAIT_CAP_MS}，与 `retryPolicy` 配多大无关）；这里同步取同一个
 * 数，是让默认策略与适配器口径一致——用户单独抬高 `backoff.maxDelayMs` 时不会
 * 出现「策略说收、适配器说不等」的分裂。
 *
 * 对**本地**退避没有影响：次数默认 5、初始 500ms，第 5 次也只有 500ms×2⁴ ≈ 8 秒，
 * 远低于这个上限，所以普通抖动的行为与宿主默认逐字相同。
 */
const DEFAULT_RETRY_MAX_DELAY_MS = RATE_LIMIT_WAIT_CAP_MS

/**
 * 省略 `retryPolicy` 时本插件自持的默认策略。
 *
 * 逐项照搬宿主 normal 默认（而不是照抄一份常量）：宿主的可重试集合若在某次升级里
 * 变化，这里跟着变，不会悄悄落后。宿主契约里省略配置就是 normal，`always` 分支只为
 * 让类型收得住。
 *
 * `CHANNEL_BLOCKED`（渠道校验拒收）不在 `retryableCodes` 里是**有意的**：11128 是
 * 确定性失败，重发只是把一次失败拖成几十秒。`mode:'always'` 会重试一切——那是用户
 * 显式改策略后的选择，插件不再拦（同样不再替他判断该不该重试）。
 * @returns 一份可直接交给 {@link resolveRetryPolicy} 的配置。
 */
function defaultRetryPolicyConfig(): RetryPolicyConfig {
  const base = resolveRetryPolicy(undefined, `${PACKAGE_NAME}: retryPolicy`)
  const backoff = {
    initialDelayMs: base.initialDelayMs,
    maxDelayMs: DEFAULT_RETRY_MAX_DELAY_MS,
    jitterRatio: base.jitterRatio,
  }
  return base.mode === 'always'
    ? { mode: 'always', backoff }
    : { mode: 'normal', maxRetries: base.maxRetries, retryableCodes: [...base.retryableCodes], backoff }
}

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
    retryPolicy: resolveRetryPolicy(config.retryPolicy ?? defaultRetryPolicyConfig(), `${PACKAGE_NAME}: retryPolicy`),
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

  // 设置开关的权威值读 apply 收到的 config：它与 fiber.config 是**同一个对象**
  //（volatile 引用也共享同一实例，loader 提交后两边同步），而 Remote 方法里的
  // this.ctx 绑到调用方上下文，读不到本插件 fiber——所以从这里把句柄传下去。
  // 适配器也走同一个句柄：429 开关每次请求现读，切换不必等下一次请求之后才生效。
  const settingsOf = (): CodeBuddySettings => readSettings(config)

  const session = new CodeBuddySession(ctx)
  const adapter = new CodeBuddyAdapter({
    session,
    options: () => resolved,
    language: currentLanguage(ctx),
    waitOnRateLimit: () => settingsOf().waitOnRateLimit,
    // 诊断出口接宿主日志：适配器只在「服务说稍后再试却没说什么时候」时用一次。
    warn: (message) => { ctx.logger.warn(message) },
    // 真实请求被判 11128 时把现场写进 $DSH_HOME 的健康文件。
    // **不 await**：写盘失败（权限、磁盘满）绝不能让一次请求的结果变成错误，
    // 诊断是旁路，请求本身才是主线。
    recordBlock: (record) => {
      void recordChannelBlock(record).catch((error: unknown) => {
        ctx.logger.warn(`${PACKAGE_NAME}: recording a channel block failed: ${String(error)}`)
      })
    },
  })
  ctx.llm.registerAdapter([CODEBUDDY_PROVIDER], adapter)

  // 设置页策略：不自动生成本 entry 的表单页（卡片是手写的 plugins.item 槽）。
  configureSettingsPage(ctx)

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
    // 探针与渠道指纹判定都按**聊天面**地址：gatewayRoot 是给 /agenttool 的，
    // 刻意去掉了 /v2，拿它拼 /chat/completions 会打错地方。
    chatBaseURL: () => resolved.baseURL,
    // 探针结果写盘失败只记日志：结论已经算出来了，不能因为旁路文件丢了。
    warn: (message) => { ctx.logger.warn(message) },
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
