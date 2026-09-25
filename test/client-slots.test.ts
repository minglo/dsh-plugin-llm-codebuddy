import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'

// apply() 经 CodeBuddyTab/UsageIndicator 间接拉入 UI primitives；这些测试只关心
// 槽位注册，mock 掉真实组件库（与其它组件测试同款做法）即可。
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: ({ children, ...rest }: { children?: unknown }) => createElement('button', rest, children),
  Tooltip: ({ children }: { children?: unknown }) => createElement('span', null, children),
}))

import { apply, inject } from '../src/client/index.js'
import { PACKAGE_NAME } from '../src/constants.js'

/**
 * 客户端槽位注册的契约测试。
 *
 * 回归点：本插件是 profile 里的一个 **bundle**，配置必须注册到
 * `plugins.bundle.config`（key = 包名）。0.1.7 的属性页契约把 `plugins.item`
 * 保留给官方伴生页（原文：OCCUPIED by the official settings pages … a bundle's
 * configuration belongs in `plugins.bundle.config` or `plugins.row.config`
 * instead）。注册到 plugins.item 时，Plugins 页详情页的 `configured` 判据
 * （`ledger.bundles.has(pkg.name)`，bundle 集合来自 plugins.bundle.config 的 key）
 * 永远不成立——表现就是「列表里能看到本插件，点进详情却没有配置区块」。
 */

interface Registration {
  name: string
  key?: string
  locale?: string
}

/** 收集一次 apply() 的全部槽位注册。注册发生在 async effect 里（要等 $mount），
 * 所以调用方必须 await settle() 之后才能断言。 */
function mountHarness(served = true): { registered: Registration[]; settle: () => Promise<void> } {
  const registered: Registration[] = []
  const t = (key: string): string => key
  const pending: Array<Promise<unknown>> = []

  const makeCtx = () => ({
    effect: (fn: () => unknown) => {
      const result = fn()
      if (result instanceof Promise) pending.push(result.catch(() => undefined))
      return () => undefined
    },
    on: () => () => undefined,
    get: () => ({
      setSettings: async () => ({ ok: true, value: undefined }),
    }),
    remote: { $mount: async () => () => undefined },
    locale: { register: () => () => undefined, bind: () => t },
    configForms: {
      // whileServed：served 时立即以「已服务」的集合调用注册回调。
      whileServed: (
        _namespaces: readonly string[],
        register: (servedNamespaces: ReadonlySet<string>) => () => void,
      ) => (served ? register(new Set(['plugin-llm-codebuddy'])) : () => undefined),
      get: () => ({ getSnapshot: () => ({}), mutate: async () => undefined }),
    },
    slots: {
      inject: (_name: string, fn: () => unknown) => { void fn(); return () => undefined },
      register: (options: Registration) => { registered.push(options); return () => undefined },
    },
  })

  apply(makeCtx() as never)
  const settle = async (): Promise<void> => {
    // effect 里的 async 体要等 $mount 的微任务链跑完。
    for (let i = 0; i < 5; i += 1) await Promise.resolve()
    await Promise.all(pending)
  }
  return { registered, settle }
}

describe('client slot registration', () => {
  it('declares configForms alongside the services it uses', () => {
    // apply() 直接读 ctx.configForms；未声明的服务访问在 cordis 里会抛
    // `cannot get property … without inject`，所以它必须在 inject 里。
    expect(inject).toContain('configForms')
    expect(inject).toContain('slots')
    expect(inject).toContain('locale')
  })

  it('registers the configuration into plugins.bundle.config keyed by the package name', async () => {
    const { registered, settle } = mountHarness()
    await settle()
    const config = registered.find(entry => entry.name === 'plugins.bundle.config')
    expect(config).toBeDefined()
    // key 必须是包名：Plugins 页正是用 pkg.name 去 ledger.bundles 命中。
    expect(config?.key).toBe(PACKAGE_NAME)
  })

  it('does not register into plugins.item, which the official companion pages occupy', async () => {
    const { registered, settle } = mountHarness()
    await settle()
    expect(registered.some(entry => entry.name === 'plugins.item')).toBe(false)
  })

  it('still contributes the sidebar usage indicator', async () => {
    // 迁移只应改配置槽；侧栏用量指示器不能因此丢失。
    const { registered, settle } = mountHarness()
    await settle()
    expect(registered.some(entry => entry.name === 'sidebar.footer.action')).toBe(true)
  })

  it('withholds the config entry when the host does not serve the settings namespace', async () => {
    // whileServed 守卫只针对配置槽：宿主没暴露本 entry 的 settings 命名空间时，
    // 不注册那块永远渲染不出的配置；侧栏用量指示器与本 entry 无关，照常注册。
    const { registered, settle } = mountHarness(false)
    await settle()
    expect(registered.some(entry => entry.name === 'plugins.bundle.config')).toBe(false)
    expect(registered.some(entry => entry.name === 'sidebar.footer.action')).toBe(true)
  })
})

// vi 仅用于保持与其他组件测试一致的导入面；此处不需要 spy。
void vi
