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
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { TYPERT_REMOTE } from '../remote-descriptors.js'
import { PACKAGE_NAME } from '../constants.js'
import type { LoginPoll, LoginStart, SettingsView, StatusView, UsageResult } from '../remote-types.js'
import { en, zh, type LocaleKey } from './locales.js'
import { CodeBuddyTab, type CodeBuddyTabInjected } from './CodeBuddyTab.jsx'
import { UsageIndicator, type UsageIndicatorInjected } from './UsageIndicator.jsx'

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
  setSettings(patch: { showUsage?: boolean; webSearch?: boolean }): Promise<RemoteResult<void>>
}

export const NS = 'settings.codebuddy'

/** host settings 命名空间（= profile entry id，见 src/settings-ns.ts SETTINGS_NS）。 */
const SETTINGS_NS = 'plugin-llm-codebuddy'

/**
 * `plugins.bundle.config` 是**按包名寻址**的 keyed 槽：owner（Plugins 页）用
 * `pkg.name` 去 `ledger.bundles` 里命中，命中才在 bundle 自己的详情页渲染配置区块
 * （见 ui-plugin-manager 的 `configured ? renderSlot('plugins.bundle.config', …) : null`）。
 * 所以这里的 key 必须是本包名，不能是任意 id。
 */
const BUNDLE_KEY = PACKAGE_NAME

export const inject = ['slots', 'locale', 'remote', 'configForms'] as const

export function apply(ctx: ClientContext): void {
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
    } catch (error) {
      // mount 或槽位注册失败：先释放已注册资源，再抛出让 fiber 进入 FAILED。
      for (const dispose of disposers.reverse()) dispose()
      throw error
    }
    return () => { for (const dispose of disposers.reverse()) dispose() }
  }, 'codebuddy: client remote mount + slots')
}
