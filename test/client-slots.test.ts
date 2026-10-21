import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'

// apply() 经 CodeBuddyTab/UsageIndicator 间接拉入 UI primitives；这些测试只关心
// 槽位注册，mock 掉真实组件库（与其它组件测试同款做法）即可。
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: ({ children, ...rest }: { children?: unknown }) => createElement('button', rest, children),
  Tooltip: ({ children }: { children?: unknown }) => createElement('span', null, children),
  // ModelLabel 经 apply() 的引入链拉进来后还需要 Tag；少了它整个测试文件在
  // import 阶段就因「缺少导出」失败，而不是断言失败。
  Tag: ({ children }: { children?: unknown }) => createElement('span', null, children),
}))

import { apply, inject } from '../src/client/index.js'
import { PACKAGE_NAME } from '../src/constants.js'
import { SETTINGS_NS as HOST_SETTINGS_NS } from '../src/settings-ns.js'

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
  id?: string
  order?: number
  locale?: string
  /** single/keyed/list 的格子遮蔽名次（默认 0，数值最小者渲染）。 */
  priority?: number
}

/** 收集一次 apply() 的全部槽位注册。注册发生在 async effect 里（要等 $mount），
 * 所以调用方必须 await settle() 之后才能断言。 */
function mountHarness(served = true): { registered: Registration[]; servedNamespaces: string[]; settle: () => Promise<void> } {
  const registered: Registration[] = []
  // 记录客户端**实际请求**的命名空间：客户端半区把 SETTINGS_NS 又硬编码了一份
  // （src/client/index.ts），此前没有任何测试把它与 host 侧的常量绑在一起——
  // 改了一处忘了另一处，开关就会在真实环境里静默失效。
  const servedNamespaces: string[] = []
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
        namespaces: readonly string[],
        register: (servedNamespaces: ReadonlySet<string>) => () => void,
      ) => {
        servedNamespaces.push(...namespaces)
        return served ? register(new Set(namespaces)) : () => undefined
      },
      get: () => ({ getSnapshot: () => ({}), mutate: async () => undefined }),
    },
    slots: {
      inject: (_name: string, fn: () => unknown) => { void fn(); return () => undefined },
      register: (options: Registration) => { registered.push(options); return () => undefined },
    },
  })

  const ctx = makeCtx()
  apply(ctx as never)
  const settle = async (): Promise<void> => {
    // effect 里的 async 体要等 $mount 的微任务链跑完。
    for (let i = 0; i < 5; i += 1) await Promise.resolve()
    await Promise.all(pending)
  }
  return { registered, servedNamespaces, settle }
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

  it('contributes the composer allowance pill to the standard conversation.input.right list slot', async () => {
    // `conversation.input.right` 是 ui-conversation 声明的 list 槽（replaceRisk: none），
    // 渲染在 composer 的 standardControls 里、模型选择器**之前**。注册必须
    // 带自己的 id：复用别人的 id 会把那个 occupant 顶掉（官方契约原文），
    // 而本插件只是又一个用量胶囊，没有理由遮蔽 opencode-go 之类的同伴。
    const { registered, settle } = mountHarness()
    await settle()
    const pill = registered.find(entry => entry.name === 'conversation.input.right')
    expect(pill).toBeDefined()
    expect(pill?.id).toBe('llm-codebuddy-usage')
    // 侧栏指示器用 id 10；胶囊排在其后，两者互不干扰（不同 slot，order 只在槽内比较）。
    expect(pill?.order).toBe(20)
  })

  it('claims the composer model label cell at priority -1', async () => {
    // `conversation.input.model.label` 是 single 槽，宿主自带的
    // `ui-deepseek-model-label-1017` 插件占着这一格（默认 priority 0）。
    // single 槽的同优先级二次注册会**抛错**（整个客户端 fiber 随之失败，输入框
    // 所有控件一起消失），不是静默覆盖；所以必须显式 -1——数值最小者渲染，
    // 我们赢下这一格，官方角标改由 ModelLabel 自己复刻（组件规则 2）。
    const { registered, settle } = mountHarness()
    await settle()
    const label = registered.find(entry => entry.name === 'conversation.input.model.label')
    expect(label).toBeDefined()
    expect(label?.priority).toBe(-1)
  })

  it('never claims a single-kind composer seat, which would shadow shipped UI', async () => {
    // conversation.input.model / .plan / .permission / .activity 都是 kind: single：
    // 注册进去等于替换官方控件（replaceRisk: shadows-shipped-ui）。用量胶囊是增量
    // 装饰，不属于任何这些座位。`conversation.input.model.label` 是模型座位里的
    // **子槽**、不是这四席之一：它由独立用例单独覆盖（见上一条）。
    const { registered, settle } = mountHarness()
    await settle()
    for (const key of ['conversation.input.model', 'conversation.input.plan',
      'conversation.input.permission', 'conversation.input.activity'] as const) {
      expect(registered.some(entry => entry.name === key), key).toBe(false)
    }
  })

  it('asks the host for the same settings namespace the host half declares', async () => {
    // 跨半区绑定：客户端 bundle 里的字面量必须等于 host 的 SETTINGS_NS。
    // 两者漂移时，whileServed 永远不会回调 → 详情页配置区块整个消失，且没有任何报错。
    const { servedNamespaces, settle } = mountHarness()
    await settle()
    expect(servedNamespaces).toContain(HOST_SETTINGS_NS)
    // 客户端只该请求这一个命名空间，多请求一个不存在的同样会让配置静默不渲染。
    expect(new Set(servedNamespaces)).toEqual(new Set([HOST_SETTINGS_NS]))
  })

  it('withholds the config entry when the host does not serve the settings namespace', async () => {
    // whileServed 守卫只针对配置槽：宿主没暴露本 entry 的 settings 命名空间时，
    // 不注册那块永远渲染不出的配置；侧栏用量指示器与本 entry 无关，照常注册。
    const { registered, settle } = mountHarness(false)
    await settle()
    expect(registered.some(entry => entry.name === 'plugins.bundle.config')).toBe(false)
    expect(registered.some(entry => entry.name === 'sidebar.footer.action')).toBe(true)
    // 输入框胶囊与 settings 命名空间无关：宿主不服务配置页时它照样注册。
    expect(registered.some(entry => entry.name === 'conversation.input.right')).toBe(true)
  })
})

// vi 仅用于保持与其他组件测试一致的导入面；此处不需要 spy。
void vi
