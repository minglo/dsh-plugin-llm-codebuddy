import { Context, Service } from '@deepseek-ai/cordis'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SETTINGS,
  SETTINGS_NS,
  SettingsSchema,
  readSettings,
  updateSettings,
} from '../src/settings-ns.js'

// 0.1.7：不再有 SettingsProvider/installSection。开关是本插件 Config 的
// volatile 字段；读 = 展开值；写 = settings.mutate(ns=entry id, ops)。
// Service 子类经 ctx.get('settings') 提供（属性赋值桩不进 ctx.get，必须真实 mount）。
class FakeSettings extends Service {
  static inject: string[] = []
  calls: Array<{ ns: string; ops: Array<{ op: string; path: readonly string[]; value: unknown }> }> = []

  constructor(ctx: Context) {
    super(ctx, 'settings')
  }

  async mutate(ns: string, ops: Array<{ op: 'set'; path: readonly string[]; value: unknown }>): Promise<void> {
    this.calls.push({ ns, ops })
  }
}

describe('SettingsSchema (volatile fields)', () => {
  it('declares every switch as a volatile field with its default', () => {
    // toJSON 的 refs 表里每个字段的 meta.volatile / meta.default（schemastery 3.18.4）。
    const json = SettingsSchema.toJSON() as { refs: Record<string, { type: string; meta?: { volatile?: boolean; default?: unknown } }> }
    const fields = Object.values(json.refs).filter(node => node.type === 'boolean')
    // 所有开关都必须 volatile：切换要走 loader 的就地提交，不能重挂插件。
    // 默认值：showUsage 关、showComposerUsage 开、waitOnRateLimit 关、webSearch 关。
    const defaults = fields.map(node => node.meta?.default).sort()
    expect(defaults).toEqual([false, false, false, true])
    for (const node of fields) expect(node.meta?.volatile).toBe(true)
  })

  it('gives the two entries opposite defaults: composer pill on, sidebar off', () => {
    // 两处入口分成两个字段：只开其中一个的用户不该被迫接受另一个。
    // 输入框胶囊默认**开**（只在选中 CodeBuddy 模型时出现的上下文入口，不占常驻
    // 界面），侧栏指示器默认**关**（侧栏底部是常驻状态区，加进度条改变默认界面）。
    expect(SettingsSchema({}).showComposerUsage.get()).toBe(true)
    expect(SettingsSchema({}).showUsage.get()).toBe(false)
  })

  it('resolves missing config to volatile refs carrying the schema defaults', () => {
    // resolveConfig 后每个字段是 Volatile 引用；展开后即官方入口默认。
    expect(DEFAULT_SETTINGS.waitOnRateLimit).toBe(false)
    const resolved = readSettings(SettingsSchema({}))
    expect(resolved).toEqual({ showUsage: false, showComposerUsage: true, waitOnRateLimit: false, webSearch: false })
  })
})

describe('SETTINGS_NS', () => {
  it('is the profile entry id actually declared in cordis.patch.yml', () => {
    // 0.1.7 的 settings 命名空间就是 profile entry id。这里**真去读**发布产物里的
    // patch 文件，而不是把常量再抄一遍——原先两处测试都叫「declared in
    // cordis.patch.yml」，却没有一处打开过那个文件，改了 patch id 也不会红。
    // vitest 下 import.meta.url 不是 file: URL，按仓库根（vitest 的 cwd）解析。
    const patch = readFileSync(resolve(process.cwd(), 'cordis.patch.yml'), 'utf8')
    const ids = [...patch.matchAll(/^\s*-?\s*id:\s*['"]?([^'"\s]+)['"]?/gm)].map(m => m[1])
    expect(ids).toContain(SETTINGS_NS)
    // entry id 同时也必须是包导入名所指向的那一行，不能是别的行凑巧同名。
    expect(ids).toEqual([SETTINGS_NS])
    // 顺带钉住字面量：改名要同时改 patch、这里、以及客户端硬编码（见 client-slots）。
    expect(SETTINGS_NS).toBe('plugin-llm-codebuddy')
  })
})

describe('readSettings', () => {
  it('reads plain config values with schema-default fallbacks', () => {
    expect(readSettings({ showUsage: false, showComposerUsage: false, webSearch: true, waitOnRateLimit: true }))
      .toEqual({ showUsage: false, showComposerUsage: false, waitOnRateLimit: true, webSearch: true })
    expect(readSettings({})).toEqual({ showUsage: false, showComposerUsage: true, waitOnRateLimit: false, webSearch: false })
    expect(readSettings(undefined)).toEqual({ showUsage: false, showComposerUsage: true, waitOnRateLimit: false, webSearch: false })
  })

  it('unwraps volatile references (cosmokit Volatile 的 .get() 快照)', () => {
    const config = {
      showUsage: { get: () => false },
      showComposerUsage: { get: () => false },
      webSearch: { get: () => true },
      waitOnRateLimit: { get: () => true },
    }
    expect(readSettings(config)).toEqual({ showUsage: false, showComposerUsage: false, waitOnRateLimit: true, webSearch: true })
  })

  it('ignores non-boolean garbage instead of propagating it', () => {
    // 非布尔垃圾值一律回落到 schema 默认，而不是把垃圾透传出去。
    expect(readSettings({ showUsage: 'yes', showComposerUsage: 1, webSearch: null, waitOnRateLimit: 'true' }))
      .toEqual({ showUsage: false, showComposerUsage: true, waitOnRateLimit: false, webSearch: false })
  })
})

describe('updateSettings', () => {
  it('writes a partial patch as path ops through settings.mutate(ns=entry id)', async () => {
    const ctx = new Context()
    await ctx.plugin(FakeSettings)

    await updateSettings(ctx, { webSearch: true })

    const settings = ctx.get('settings') as FakeSettings
    expect(settings.calls).toEqual([{
      ns: 'plugin-llm-codebuddy',
      ops: [{ op: 'set', path: ['webSearch'], value: true }],
    }])
  })

  it('writes both fields when both are given', async () => {
    const ctx = new Context()
    await ctx.plugin(FakeSettings)

    await updateSettings(ctx, { waitOnRateLimit: true, webSearch: true })

    const settings = ctx.get('settings') as FakeSettings
    expect(settings.calls[0]?.ops).toEqual([
      { op: 'set', path: ['waitOnRateLimit'], value: true },
      { op: 'set', path: ['webSearch'], value: true },
    ])
  })

  it('is a no-op when no settings seam is mounted (headless)', async () => {
    const ctx = new Context()
    await expect(updateSettings(ctx, { webSearch: true })).resolves.toBeUndefined()
  })

  it('skips the wire entirely for an empty patch', async () => {
    const ctx = new Context()
    await ctx.plugin(FakeSettings)

    await updateSettings(ctx, {})

    const settings = ctx.get('settings') as FakeSettings
    expect(settings.calls).toEqual([])
  })
})
