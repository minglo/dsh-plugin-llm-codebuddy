import { describe, expect, it } from 'vitest'
import { Config } from '../src/index.js'
import { DEFAULT_SETTINGS, SettingsSchema } from '../src/settings-ns.js'
import { CODEBUDDY_CHAT_BASE } from '../src/constants.js'

/**
 * `index.ts` 的 `Config` 与 `settings-ns.ts` 的 `SettingsSchema` 是同一份配置面
 * 的两处声明，必须完全一致：
 *
 * - loader 用 `Config` 校验 `updateSettings` 写出的 `set` op（字段漏了 → 写入被
 *   丢弃，设置页的开关看起来能切、实际不生效）；
 * - `readSettings` 从 loader 回灌后的句柄取值，缺省由 `Config` 填好（默认值不一致
 *   → 界面默认与设置页显示分裂）。
 *
 * 这两条都不会让任何单个模块的测试失败，只会在真实运行时表现为「开关是坏的」，
 * 所以在这里显式钉住。
 */
describe('Config 与 SettingsSchema 的一致性', () => {
  /** volatile 字段在不重挂的组合里是 `{ get() }` 引用，裸值是另一种形状。 */
  const unwrap = (value: unknown): unknown =>
    (typeof value === 'object' && value !== null && typeof (value as { get?: unknown }).get === 'function'
      ? (value as { get: () => unknown }).get()
      : value)

  it('declares exactly the same switch fields', () => {
    // 字段名一致性用「空配置实例化后有哪些布尔键」判定，不看 toJSON——
    // 键名才是 loader 校验 `set` op 时真正匹配的东西。
    const keysOf = (shape: Record<string, unknown>): string[] =>
      Object.entries(shape)
        .filter(([, value]) => typeof unwrap(value) === 'boolean')
        .map(([key]) => key)
        .sort()

    const configKeys = keysOf(Config({} as never) as unknown as Record<string, unknown>)
    const settingsKeys = keysOf(SettingsSchema({} as never) as unknown as Record<string, unknown>)

    expect(configKeys).toEqual(['showComposerUsage', 'showUsage', 'waitOnRateLimit', 'webSearch'])
    expect(configKeys).toEqual(settingsKeys)
  })

  it('declares exactly the same defaults', () => {
    // 默认值：showUsage 关、showComposerUsage 开、waitOnRateLimit 关、webSearch 关。
    // 两个 schema 各自的缺省集合必须相同（用 multiset 表示，避免只比对键名）。
    const config = Config({} as never) as unknown as Record<string, unknown>
    const settings = SettingsSchema({} as never) as unknown as Record<string, unknown>

    const defaultsOf = (shape: Record<string, unknown>): boolean[] =>
      Object.values(shape)
        .map(unwrap)
        .filter((value): value is boolean => typeof value === 'boolean')
        .sort()

    expect(defaultsOf(config)).toEqual([false, false, false, true])
    expect(defaultsOf(config)).toEqual(defaultsOf(settings))
  })

  it('keeps the baseURL schema default equal to CODEBUDDY_CHAT_BASE', () => {
    // 回归：这个默认值曾在 index.ts 里被写成字面量 'https://copilot.tencent.com/v2'，
    // 而同一文件既 import 了 CODEBUDDY_CHAT_BASE、又用它兜底（config.baseURL ?? …）。
    // 于是改网关地址时，显式配置跟随、schema 默认值却静默留在旧地址——
    // 跑起来看着正常，只是打到了老域名。这里把两边绑死。
    const config = Config({} as never) as unknown as { baseURL?: unknown }
    const value = typeof config.baseURL === 'object' && config.baseURL !== null
      && typeof (config.baseURL as { get?: unknown }).get === 'function'
      ? (config.baseURL as { get: () => unknown }).get()
      : config.baseURL
    expect(value).toBe(CODEBUDDY_CHAT_BASE)
  })

  it('keeps DEFAULT_SETTINGS aligned with both schemas', () => {
    // 组合层缺省（无 loader 句柄时的兜底）也必须同值，否则 headless 形态与
    // 正常形态会给出不同的默认界面。
    expect(DEFAULT_SETTINGS).toEqual({ showUsage: false, showComposerUsage: true, waitOnRateLimit: false, webSearch: false })
  })
})
