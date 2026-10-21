import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-augmentation imports (runtime-erased): each pulls in the `declare module`
// augmentation that types the corresponding ctx member / slot key in this file.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
// Type-only: pulls ui-conversation 的 SlotMap 合并（conversation.input.right 等键）。
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: 模型选择器声明的 `conversation.input.model.label` 子槽。
import type {} from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { TYPERT_REMOTE } from '../remote-descriptors.js'
import { PACKAGE_NAME, PLUGIN_NAME } from '../constants.js'
import type { CodeBuddyModelsResult, LoginPoll, LoginStart, SettingsView, StatusView, UsageResult } from '../remote-types.js'
import { en, zh, type LocaleKey } from './locales.js'
import { CodeBuddyTab, type CodeBuddyTabInjected } from './CodeBuddyTab.jsx'
import { UsageIndicator, type UsageIndicatorInjected } from './UsageIndicator.jsx'
import { ComposerUsage, type ComposerUsageInjected } from './ComposerUsage.jsx'
import { ModelLabel, type LocaleFace, type ModelLabelInjected } from './ModelLabel.jsx'
import { modelFeed } from './model-feed.js'
import { ensurePluginCss } from './CodeBuddyTab.jsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'settings.codebuddy': LocaleKey
  }
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteNamespaceMap {
    'codebuddy': CodeBuddyRemote
  }
}

/** `ctx.remote.codebuddy` 的静态面：网关 Client face，方法一律 RemoteResult 包装。 */
interface CodeBuddyRemote {
  status(): Promise<RemoteResult<StatusView>>
  usage(): Promise<RemoteResult<UsageResult>>
  startLogin(): Promise<RemoteResult<LoginStart>>
  pollLogin(state: string): Promise<RemoteResult<LoginPoll>>
  logout(): Promise<RemoteResult<void>>
  getSettings(): Promise<RemoteResult<SettingsView>>
  models(): Promise<RemoteResult<CodeBuddyModelsResult>>
  setSettings(patch: { showUsage?: boolean; showComposerUsage?: boolean; waitOnRateLimit?: boolean; webSearch?: boolean }): Promise<RemoteResult<void>>
}

export const NS = 'settings.codebuddy'

/**
 * host settings 命名空间（= profile entry id）。
 *
 * 值与 `src/settings-ns.ts` 的 `SETTINGS_NS` 相同，但**不能直接 import 那一份**：
 * settings-ns.ts 依赖 schemastery，而浏览器侧产物里没有它（dist/client.js 中
 * schemastery 出现 0 次）。这里改从零依赖的 constants.ts 取 `PLUGIN_NAME`——
 * 两边同源，不再各抄一份字面量。绑定关系由 test/client-slots.test.ts 断言。
 */
const SETTINGS_NS = PLUGIN_NAME

/**
 * `plugins.bundle.config` 是**按包名寻址**的 keyed 槽：owner（Plugins 页）用
 * `pkg.name` 去 `ledger.bundles` 里命中，命中才在 bundle 自己的详情页渲染配置区块
 * （见 ui-plugin-manager 的 `configured ? renderSlot('plugins.bundle.config', …) : null`）。
 * 所以这里的 key 必须是本包名，不能是任意 id。
 */
const BUNDLE_KEY = PACKAGE_NAME

export const inject = ['slots', 'locale', 'remote', 'configForms'] as const

export function apply(ctx: ClientContext): void {
  // 样式在插件加载时就注入，而不是等某个组件挂载后的 effect——否则胶囊首次
  // 渲染会有一帧没有 .cb-pill（悬停底色/圆角/内距都还没生效）。注入是幂等的。
  ensurePluginCss()
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'codebuddy: dictionaries')
  const t = ctx.locale.bind(NS)

  // $mount 是异步的：把 mount 放进 effect，mount 完成后才注册卡片/指示器。
  // remote.codebuddy 是 $mount 安装的平级服务（key 字面量 'remote.codebuddy'），必须用
  // ctx.get('remote.codebuddy') 弱读：属性链 ctx.remote.codebuddy 会经 traceable associate
  // 转为对 dotted key 的 inject 校验（缺声明即抛）；而把 'remote.codebuddy' 写进顶层 inject
  // 又会造成自举死锁（fiber 等待自己 $mount 才安装的服务，pending 无法激活）。
  ctx.effect(async () => {
    const disposers: Array<() => void> = []
    try {
      disposers.push(await ctx.remote.$mount(TYPERT_REMOTE))

      const codebuddyRemote = (ctx as unknown as { get(name: string): unknown }).get('remote.codebuddy') as CodeBuddyRemote | undefined
      if (codebuddyRemote === undefined) throw new Error('remote.codebuddy unavailable after mount')
      const tabInject = (): CodeBuddyTabInjected => ({
        remote: codebuddyRemote,
        setShowUsage: async (showUsage) => {
          const result = await codebuddyRemote.setSettings({ showUsage })
          if (!result.ok) throw new Error(result.error.message)
        },
        setShowComposerUsage: async (showComposerUsage) => {
          const result = await codebuddyRemote.setSettings({ showComposerUsage })
          if (!result.ok) throw new Error(result.error.message)
        },
        setWaitOnRateLimit: async (waitOnRateLimit) => {
          const result = await codebuddyRemote.setSettings({ waitOnRateLimit })
          if (!result.ok) throw new Error(result.error.message)
        },
        setWebSearch: async (webSearch) => {
          const result = await codebuddyRemote.setSettings({ webSearch })
          if (!result.ok) throw new Error(result.error.message)
        },
        t: t as (k: string) => string,
      })

      // 侧栏 Plugins → 本插件详情页的配置区块。0.1.7 的属性页契约把配置面分成三类：
      // `plugins.item` 是**官方伴生页专用**（契约原文：OCCUPIED by the official
      // settings pages… a bundle's configuration belongs in `plugins.bundle.config`
      // or `plugins.row.config` instead），而本插件是 profile 里的一个 bundle，
      // 所以必须注册 `plugins.bundle.config`——注册到 plugins.item 时详情页的
      // `configured` 判据（ledger.bundles 按包名命中）永远不成立，表现为
      // 「卡片能看到、点进去却没有配置」。
      // key = 包名（owner 就是这么找的）；组件按 owner 的 view 分支渲染。
      // whileServed 守卫：宿主没暴露本 entry 的 settings 命名空间时不注册，
      // 而不是留一块永远渲染不出的配置。
      disposers.push(ctx.configForms.whileServed([SETTINGS_NS], () => ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
        name: 'plugins.bundle.config',
        key: BUNDLE_KEY,
        locale: NS,
        inject: tabInject,
      }, CodeBuddyTab))))

      const indicatorInject = (): UsageIndicatorInjected => ({
        remote: codebuddyRemote,
        t: t as (k: string) => string,
      })

      disposers.push(ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
        name: 'sidebar.footer.action',
        id: 'llm-codebuddy-usage',
        order: 10,
        locale: NS,
        inject: indicatorInject,
      }, UsageIndicator)))

      // 输入框工具行（模型选择器左侧）的额度胶囊。`conversation.input.right` 是
      // kind: list、replaceRisk: none 的标准槽：新 id 与既有 occupant（opencode-go
      // 之类的用量胶囊）并存，不遮蔽任何官方控件。owner 在 composer 的
      // standardControls 里先渲染本槽、再渲染 `conversation.input.model`。
      // 无需 `conversation.input.right` 出现在顶层 inject：注册经 slots.inject
      // 等待宿主声明，与 activation 顺序无关（同 sidebar.footer.action）。
      const composerInject = (): ComposerUsageInjected => ({
        remote: codebuddyRemote,
        t: t as (k: string) => string,
      })

      disposers.push(ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
        name: 'conversation.input.right',
        id: 'llm-codebuddy-usage',
        order: 20,
        locale: NS,
        inject: composerInject,
      }, ComposerUsage)))

      // 作曲家模型标签。`conversation.input.model.label` 是 single 槽，宿主自带的
      // `ui-deepseek-model-label-1017` 插件默认占着这一格（priority 0）。single 槽的
      // 同优先级二次注册会**抛错**，整个客户端 fiber 随之失败、输入框所有控件一起
      // 消失；所以必须显式 `priority: -1`——同格按优先级升序、数值最小者渲染，我们
      // 赢下这一格。代价是官方 1017 角标不再由它渲染，ModelLabel 已自行复刻。
      // `t` 走 inject 而**不**在注册里声明 `locale: NS`：两处都声明会让 props 变成
      // 两个函数类型的交叉，运行期谁胜出取决于 renderer 的组装顺序（同
      // ComposerUsage.tsx 的注释）。
      const localeFace: LocaleFace = {
        subscribe: (listener) => ctx.locale.subscribe(listener),
        getSnapshot: () => ctx.locale.getSnapshot(),
      }
      const labelInject = (): ModelLabelInjected => ({
        // modelFeed 按 remote 身份缓存：renderer 反复调用 inject 也只有一个轮询器，
        // 所有标签行共享同一份目录快照。
        feed: modelFeed(codebuddyRemote),
        locale: localeFace,
        t: t as (k: string) => string,
      })

      disposers.push(ctx.slots.inject('conversation.input.model.label', () => ctx.slots.register({
        name: 'conversation.input.model.label',
        priority: -1,
        inject: labelInject,
      }, ModelLabel)))
    } catch (error) {
      // mount 或槽位注册失败：先释放已注册资源，再抛出让 fiber 进入 FAILED。
      for (const dispose of disposers.reverse()) dispose()
      throw error
    }
    return () => { for (const dispose of disposers.reverse()) dispose() }
  }, 'codebuddy: client remote mount + slots')
}
