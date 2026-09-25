import { Context, Service } from '@deepseek-ai/cordis'
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
  it('declares showUsage true and webSearch false as volatile fields', () => {
    // toJSON 的 refs 表里每个字段的 meta.volatile / meta.default（schemastery 3.18.4）。
    const json = SettingsSchema.toJSON() as { refs: Record<string, { type: string; meta?: { volatile?: boolean; default?: unknown } }> }
    const fields = Object.values(json.refs).filter(node => node.type === 'boolean')
    const showUsage = fields.find(node => node.meta?.default === true)
    const webSearch = fields.find(node => node.meta?.default === false)
    expect(showUsage?.meta?.volatile).toBe(true)
    expect(webSearch?.meta?.volatile).toBe(true)
  })

  it('resolves missing config to volatile refs carrying the schema defaults', () => {
    // resolveConfig 后每个字段是 Volatile 引用；展开后即官方入口默认。
    expect(DEFAULT_SETTINGS.webSearch).toBe(false)
    const resolved = readSettings(SettingsSchema({}))
    expect(resolved).toEqual({ showUsage: true, webSearch: false })
  })
})

describe('SETTINGS_NS', () => {
  it('is the profile entry id declared in cordis.patch.yml', () => {
    // 0.1.7 的 settings 命名空间就是 profile entry id，必须与 patch 行 id 一致。
    expect(SETTINGS_NS).toBe('plugin-llm-codebuddy')
  })
})

describe('readSettings', () => {
  it('reads plain config values with schema-default fallbacks', () => {
    expect(readSettings({ showUsage: false, webSearch: true })).toEqual({ showUsage: false, webSearch: true })
    expect(readSettings({})).toEqual({ showUsage: true, webSearch: false })
    expect(readSettings(undefined)).toEqual({ showUsage: true, webSearch: false })
  })

  it('unwraps volatile references (cosmokit Volatile 的 .get() 快照)', () => {
    const config = {
      showUsage: { get: () => false },
      webSearch: { get: () => true },
    }
    expect(readSettings(config)).toEqual({ showUsage: false, webSearch: true })
  })

  it('ignores non-boolean garbage instead of propagating it', () => {
    expect(readSettings({ showUsage: 'yes', webSearch: null })).toEqual({ showUsage: true, webSearch: false })
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

    await updateSettings(ctx, { showUsage: false, webSearch: true })

    const settings = ctx.get('settings') as FakeSettings
    expect(settings.calls[0]?.ops).toEqual([
      { op: 'set', path: ['showUsage'], value: false },
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
