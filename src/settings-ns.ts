import type { Context } from '@deepseek-ai/cordis'
// 类型增强（运行时零副作用）：settings 服务由 @deepseek-ai/dsh-settings 挂到 Context 上。
import type {} from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'

/**
 * 本插件在 profile patch 里的 entry id，也是 host settings 的 ns 与客户端
 * `ctx.configForms.get(id)` 的键——0.1.7 里 settings 命名空间就是 entry id，
 * 所以三者同名不是巧合，而是同一个东西。与 cordis.patch.yml 的 `id` 对齐。
 */
export const SETTINGS_NS = 'plugin-llm-codebuddy'

/** 本插件的配置面（与客户端卡片一一对应）。 */
export interface CodeBuddySettings {
  /**
   * 侧边栏底部指示器。
   *
   * **默认关**：侧栏底部是状态区，加一条常驻进度条会改变默认界面，
   * 应当是显式选择而不是既成事实。
   */
  showUsage: boolean
  /**
   * 提示输入框工具行里的额度胶囊（模型选择器左侧）。
   *
   * 与 `showUsage` 分成两个字段：两处入口的诉求不同——侧栏是常驻读数、
   * 输入框旁是随手可点的明细入口，用户常常只想要其中一个。
   *
   * **默认开**：只在选中 CodeBuddy 模型时出现，是「按需出现、随手可点」
   * 的上下文入口，不占常驻界面；因此默认提供。
   */
  showComposerUsage: boolean
  /**
   * 遇到 429（频率限制）是否等待到报文给出的重置时刻再自动重试。
   *
   * **默认关**：不等。429 按普通失败重试几次后抛出，报文里的重置时刻随错误
   * 消息原样保留，主 agent 可据此切换模型继续，而不是让一个回合挂住在一次
   * 可能长到隔夜的等待上。
   *
   * 开启后也**不超过 5 小时**（适配器侧的硬上限，见 `RATE_LIMIT_WAIT_CAP_MS`）：
   * 重置时刻更远时同样走「快速重试几次后抛出」。
   */
  waitOnRateLimit: boolean
  /**
   * 用 CodeBuddy 网关的搜索/抓取后端接管 dsh 的 web_search / web_fetch。
   * 默认 false：装了插件即静默抢走别人的默认搜索位是破坏性默认值。
   */
  webSearch: boolean
}

/**
 * 三个开关都是 `.volatile()`：可变字段由 loader 在**不重挂插件**的前提下就地
 * 提交（`cordis-plugin-loader` 的 `_commitVolatile` → `loader/volatile-update`），
 * 于是切换开关不会重启 session、不会丢掉 web provider 的接管态。
 *
 * 默认值写在 schema 上：`.volatile()` 不吞 default，缺省即 schema 默认。
 */
export const SettingsSchema = z.object({
  showUsage: z.boolean().default(false).volatile(),
  showComposerUsage: z.boolean().default(true).volatile(),
  waitOnRateLimit: z.boolean().default(false).volatile(),
  webSearch: z.boolean().default(false).volatile(),
})

/** 组合层缺省：schema 默认值之外的「官方入口默认」。 */
export const DEFAULT_SETTINGS: CodeBuddySettings = { showUsage: false, showComposerUsage: true, waitOnRateLimit: false, webSearch: false }

/**
 * 声明本插件在设置页的策略：不自动生成表单页。
 *
 * 卡片是手写的（`plugins.item` 槽），自动生成的 schema 表单会与它重复；
 * `auto: false` 同时也要求客户端卡片自己存在，缺页时就是没有入口。
 * 无 settings seam（headless）时静默跳过。
 */
export function configureSettingsPage(ctx: Context): void {
  ctx.inject(['settings'], (child) => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber))
  })
}

/**
 * 读当前权威值。
 *
 * volatile 字段在 host 侧是 `Volatile<T>` 引用（`.get()`），但在尚未经
 * loader 提交的组合里也可能是裸值，故两种形状都认。
 */
export function readSettings(config: unknown): CodeBuddySettings {
  const section = (config ?? {}) as Record<string, unknown>
  return {
    showUsage: booleanOr(section.showUsage, DEFAULT_SETTINGS.showUsage),
    showComposerUsage: booleanOr(section.showComposerUsage, DEFAULT_SETTINGS.showComposerUsage),
    waitOnRateLimit: booleanOr(section.waitOnRateLimit, DEFAULT_SETTINGS.waitOnRateLimit),
    webSearch: booleanOr(section.webSearch, DEFAULT_SETTINGS.webSearch),
  }
}

/** 取一个布尔字段：volatile 引用先 `.get()`，缺失或非布尔按兜底值。 */
function booleanOr(value: unknown, fallback: boolean): boolean {
  return typeof plain(value) === 'boolean' ? plain(value) as boolean : fallback
}

/** 展开 volatile 引用：有 `.get()` 就取快照，否则原样返回。 */
function plain(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  const candidate = value as { get?: () => unknown }
  return typeof candidate.get === 'function' ? candidate.get() : value
}

/** host settings 服务的最小写面（SettingsForms.mutate）。 */
interface SettingsWriteFace {
  mutate(ns: string, ops: readonly { op: 'set'; path: readonly string[]; value: unknown }[], expectedRevision?: number): Promise<void>
}

/**
 * 持久化局部更新：把布尔字段写进 profile patch 的 volatile 层。
 *
 * 走 `settings.mutate(ns, …)`（0.1.7 的 ns = profile entry id）：ConfigEditor 把
 * 编辑写进 profile patch YAML 并经 loader 回灌——volatile-only 的变化被
 * `_commitVolatile` 就地提交（不重挂插件），并发 `loader/volatile-update`。
 * 无 settings seam（headless）时静默 no-op。
 *
 * 不传 expectedRevision：写的是单字段标量，最后写入胜出即可；并发冲突由
 * ConfigEditor 的文件锁串行化。
 */
export async function updateSettings(ctx: Context, patch: Partial<CodeBuddySettings>): Promise<void> {
  const settings = ctx.get('settings') as SettingsWriteFace | undefined
  if (settings === undefined) return
  const ops = Object.entries(patch)
    .filter((entry): entry is [keyof CodeBuddySettings, boolean] => typeof entry[1] === 'boolean')
    .map(([field, value]) => ({ op: 'set' as const, path: [field], value }))
  if (ops.length === 0) return
  await settings.mutate(SETTINGS_NS, ops)
}
