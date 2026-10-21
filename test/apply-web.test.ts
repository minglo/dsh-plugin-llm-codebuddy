import { Context, Service } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import { WebRuntime } from '@deepseek-ai/dsh-web'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../src/index.js'
import { writeGrant } from '../src/auth.js'
import type { CodeBuddyGrant } from '../src/auth.js'
import { SETTINGS_NS } from '../src/settings-ns.js'

const scratchDirs: string[] = []

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* best-effort cleanup */ }
  }
})

/** llm seam 的最小替身：apply() 需要 registerAdapter。 */
class FakeLlm extends Service {
  static inject: string[] = []
  constructor(ctx: Context) { super(ctx, 'llm') }
  registerAdapter(): () => void { return () => {} }
}

/**
 * web entry 的 settings 替身 + loader 提交的替身（0.2.1-rc.2 语义）。
 *
 * 生产环境里，`ctx.settings.mutate('web', ops)` 把选择写进该 entry 的 settings
 * 文档，loader 再提交进 `web.config` 的 Volatile 引用（宿主独占写入，插件只读）。
 * 这里 cell 就是 loader 拥有的那一份引用背后的值：mutate 写 cell，
 * `WebRuntime` 的 `config.searchProvider.get()` 读 cell——提交是即时的，
 * 与「loader 就地提交后读到新值」的可见效果一致。
 *
 * 本插件只调 `get()` 与 `settings.mutate`，两者都是被认可的读/写入口；
 * 替身没有碰任何 Volatile 内部。
 */
class FakeWebEntrySettings extends Service {
  static inject: string[] = []

  constructor(
    ctx: Context,
    private readonly searchCell: { value: string | undefined },
    private readonly fetchCell: { value: string | undefined },
  ) {
    super(ctx, 'settings')
  }

  async mutate(ns: string, ops: readonly SettingsPathOp[]): Promise<void> {
    if (ns !== 'web') return
    for (const op of ops) {
      const [field] = op.path
      const cell = field === 'searchProvider' ? this.searchCell
        : field === 'fetchProvider' ? this.fetchCell
        : undefined
      if (cell === undefined) continue
      cell.value = op.op === 'set' ? op.value as string | undefined : undefined
    }
  }
}

type SettingsPathOp =
  | { op: 'set'; path: readonly string[]; value: unknown }
  | { op: 'unset'; path: readonly string[] }

/** 模拟 loader 的 volatile 提交：更新 apply config 的引用值并发事件。 */
function commitVolatile(ctx: Context, config: Record<string, unknown>, patch: { showUsage?: boolean; webSearch?: boolean }): void {
  Object.assign(config, patch)
  ctx.emit('loader/volatile-update', [Object.keys(patch)])
}

function grant(): CodeBuddyGrant {
  const now = Date.now()
  return {
    accessToken: 'acc', expiresAt: now + 3_600_000,
    refreshToken: 'ref', refreshExpiresAt: now + 2_592_000_000, domain: 'tencent',
  }
}

/**
 * web 服务栈的替身：loader 创建 Volatile 引用并交给 WebRuntime（生产环境里
 * 这些引用由 loader 创建、随 entry 组合挂载；config 本体是宿主私有的，这里
 * 只是把「loader 拥有引用」这一事实摆到明面上），settings.mutate 即提交。
 */
function mountWebStack(ctx: Context): {
  settings: FakeWebEntrySettings
  searchCell: { value: string | undefined }
  fetchCell: { value: string | undefined }
} {
  const searchCell = { value: undefined as string | undefined }
  const fetchCell = { value: undefined as string | undefined }
  const web = new WebRuntime(ctx, {
    searchProvider: { get: () => searchCell.value },
    fetchProvider: { get: () => fetchCell.value },
  })
  ;(ctx as unknown as { set(name: string, value: unknown): void }).set('web', web)
  const settings = new FakeWebEntrySettings(ctx, searchCell, fetchCell)
  ;(ctx as unknown as { set(name: string, value: unknown): void }).set('settings', settings)
  return { settings, searchCell, fetchCell }
}

async function compose(options: { loggedIn: boolean; webSearch: boolean }): Promise<{
  ctx: Context
  config: Record<string, unknown>
  settings: FakeWebEntrySettings
  searchCell: { value: string | undefined }
  fetchCell: { value: string | undefined }
}> {
  const dir = mkdtempSync(join(tmpdir(), 'cb-apply-'))
  scratchDirs.push(dir)
  const ctx = new Context()
  await ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), watch: false })
  if (options.loggedIn) await writeGrant(ctx, grant())
  const { settings, searchCell, fetchCell } = mountWebStack(ctx)
  await ctx.plugin(FakeLlm)
  const config: Record<string, unknown> = { showUsage: true, webSearch: options.webSearch }
  return { ctx, config, settings, searchCell, fetchCell }
}

/** 读当前钉选（即 loader 已提交进 Volatile 的值，也就是 seam 分派时读的值）。 */
function searchPin(composed: { searchCell: { value: string | undefined } }): string | undefined {
  return composed.searchCell.value
}

function fetchPin(composed: { fetchCell: { value: string | undefined } }): string | undefined {
  return composed.fetchCell.value
}

/** 第三方占位：经 settings 把钉选写成别人（与宿主设置页的手动钉选同路）。 */
async function pinAs(
  settings: FakeWebEntrySettings,
  pin: { search?: string; fetch?: string },
): Promise<void> {
  const ops: SettingsPathOp[] = []
  if (pin.search !== undefined) ops.push({ op: 'set', path: ['searchProvider'], value: pin.search })
  if (pin.fetch !== undefined) ops.push({ op: 'set', path: ['fetchProvider'], value: pin.fetch })
  await settings.mutate('web', ops)
}

/** 测试内省：读 WebRuntime 私有的 provider 注册表（断言「注册了没有」用）。 */
function registeredSearchIds(ctx: Context): string[] {
  const web = ctx.web as unknown as { searchProviders: Map<string, unknown> }
  return [...web.searchProviders.keys()]
}

const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 100))

describe('apply() · web search wiring', () => {
  it('leaves the search slot untouched with the default switch state', async () => {
    const composed = await compose({ loggedIn: true, webSearch: false })
    const { ctx, config, settings } = composed
    // 模拟别人先占位（free-search 的 ddg / base 的 deepseek-official）
    await pinAs(settings, { search: 'ddg', fetch: 'http' })

    apply(ctx, config as never)
    await settle()

    expect(searchPin(composed)).toBe('ddg')
    expect(fetchPin(composed)).toBe('http')
  })

  it('takes over both slots when the stored switch is on and the user is signed in', async () => {
    const composed = await compose({ loggedIn: true, webSearch: true })
    const { ctx, config, settings } = composed
    await pinAs(settings, { search: 'ddg', fetch: 'http' })

    apply(ctx, config as never)
    await settle()

    expect(searchPin(composed)).toBe('codebuddy')
    expect(fetchPin(composed)).toBe('codebuddy')
  })

  it('does not register when the switch is on but the user is signed out', async () => {
    const composed = await compose({ loggedIn: false, webSearch: true })
    const { ctx, config, settings } = composed
    await pinAs(settings, { search: 'ddg', fetch: 'http' })

    apply(ctx, config as never)
    await settle()

    // 未登录：装开关也不接管，更不能占着字段把别人的搜索弄坏。
    expect(searchPin(composed)).toBe('ddg')
    expect(fetchPin(composed)).toBe('http')
    expect(registeredSearchIds(ctx)).toEqual([])
  })

  it('takes over on a volatile commit that flips the switch on, and releases on flip off', async () => {
    const composed = await compose({ loggedIn: true, webSearch: false })
    const { ctx, config, settings } = composed
    await pinAs(settings, { search: 'ddg', fetch: 'http' })

    apply(ctx, config as never)
    await settle()
    expect(searchPin(composed)).toBe('ddg')

    // 用户在设置卡打开开关：settings.mutate 落盘 → loader 就地提交 volatile 值。
    commitVolatile(ctx, config, { webSearch: true })
    await settle()
    expect(searchPin(composed)).toBe('codebuddy')

    // 再关掉：必须还回原来的 provider，而不是留空。
    commitVolatile(ctx, config, { webSearch: false })
    await settle()
    expect(searchPin(composed)).toBe('ddg')
    expect(fetchPin(composed)).toBe('http')
  })
})

/**
 * 徽标数据源：设置卡读的是 status().searchBackend，它必须如实反映 seam 的
 * 选择字段——否则徽标会在「开关开着但没生效」时撒谎。
 *
 * host 侧的服务键就是 'codebuddy'（TypertRemoteService 的 super(ctx, 'codebuddy')）；
 * 'remote.codebuddy' 是 client 侧 $mount 装的网关别名，host 上不存在。
 */
describe('apply() · search backend reported to the badge', () => {
  async function backendOf(ctx: Context): Promise<unknown> {
    const remote = ctx.get('codebuddy') as unknown as { status(): Promise<{ searchBackend?: unknown }> }
    return (await remote.status()).searchBackend
  }

  it('reports codebuddy once the live takeover happened', async () => {
    const composed = await compose({ loggedIn: true, webSearch: true })
    const { ctx, config, settings } = composed
    await pinAs(settings, { search: 'ddg' })

    apply(ctx, config as never)
    await settle()

    expect(await backendOf(ctx)).toBe('codebuddy')
  })

  it('reports default while the switch is off', async () => {
    const { ctx, config } = await compose({ loggedIn: true, webSearch: false })

    apply(ctx, config as never)
    await settle()
    expect(await backendOf(ctx)).toBe('default')
  })

  it('reports default when the switch is on but the user is signed out', async () => {
    // 意图为「开」、效果为「未接管」：未登录属正常让出，故是 default 而非 unavailable。
    const { ctx, config } = await compose({ loggedIn: false, webSearch: true })

    apply(ctx, config as never)
    await settle()

    expect(await backendOf(ctx)).toBe('default')
  })

  it('follows a volatile commit from off to on without a restart', async () => {
    const composed = await compose({ loggedIn: true, webSearch: false })
    const { ctx, config, settings } = composed
    await pinAs(settings, { search: 'ddg' })

    apply(ctx, config as never)
    await settle()
    expect(await backendOf(ctx)).toBe('default')

    commitVolatile(ctx, config, { webSearch: true })
    await settle()
    expect(await backendOf(ctx)).toBe('codebuddy')

    commitVolatile(ctx, config, { webSearch: false })
    await settle()
    expect(await backendOf(ctx)).toBe('default')
  })

  it('stops claiming codebuddy when a third party reclaims the slot', async () => {
    const composed = await compose({ loggedIn: true, webSearch: true })
    const { ctx, config, settings } = composed
    await pinAs(settings, { search: 'ddg' })

    apply(ctx, config as never)
    await settle()
    expect(await backendOf(ctx)).toBe('codebuddy')

    // 别人后来居上：provider 仍注册着、available() 仍为 true，但 seam 不会再
    // 分派给我们——徽标必须跟着字段走，不能跟着「已注册」走。
    await pinAs(settings, { search: 'exa' })

    expect(await backendOf(ctx)).toBe('unavailable')
  })
})

/**
 * 自愈回归：真实部署里 credentials 服务（乃至 grant 文件）完全可能晚于本插件
 * 就绪，而**磁盘上原本就存在的 grant 不会发出任何 credentials/record-updated**
 * ——该事件只覆盖写入/删除/外部编辑。启动瞬间读一次登录态，读到「无凭据」就把
 * loggedIn 钉死为 false 的话，随后 setEnabled/reconcile 全部静默早退——
 * 「开关开着、人也登录着」却永远显示「未接管」。
 */
describe('apply() · self-heals after a late login state', () => {
  async function backendOf(ctx: Context): Promise<unknown> {
    const remote = ctx.get('codebuddy') as unknown as { status(): Promise<{ searchBackend?: unknown }> }
    return (await remote.status()).searchBackend
  }

  it('takes over on the next status() read when credentials appeared after apply()', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cb-late-'))
    scratchDirs.push(dir)
    const ctx = new Context()
    const { settings, searchCell } = mountWebStack(ctx)
    await pinAs(settings, { search: 'ddg' })
    await ctx.plugin(FakeLlm)
    const config: Record<string, unknown> = { showUsage: true, webSearch: true }

    // 关键：apply() 时 credentials 尚不存在，isLoggedIn() 只能返回 false。
    apply(ctx, config as never)
    await settle()
    expect(await backendOf(ctx)).toBe('default')

    // 凭据服务随后就绪，且 grant 早已在盘上（不会触发任何事件）。
    await ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), watch: false })
    await writeGrant(ctx, grant())

    // 不重启、不切换开关：仅一次 status() 读取就该自愈。
    expect(await backendOf(ctx)).toBe('codebuddy')
    expect(searchCell.value).toBe('codebuddy')
  })

  it('keeps the authoritative switch value even if it arrives while unwired', async () => {
    // 开关值先到、web 接线后到：权威值不能被丢掉，start() 时必须按它接管。
    const composed = await compose({ loggedIn: true, webSearch: false })
    const { ctx, config, settings } = composed
    await pinAs(settings, { search: 'ddg' })

    apply(ctx, config as never)
    await settle()
    commitVolatile(ctx, config, { webSearch: true })
    await settle()

    expect(await backendOf(ctx)).toBe('codebuddy')
    expect(searchPin(composed)).toBe('codebuddy')
  })
})

/**
 * 0.1.7 entry id 契约：写入方（设置卡 RPC）用的 ns 必须与 settings-ns.ts 的
 * SETTINGS_NS 一致（评审要求恢复本断言；是否与 settings-ns.test.ts 重复由
 * controller 裁决，见任务报告）。
 */
describe('apply() · settings namespace', () => {
  it('uses the entry id declared in cordis.patch.yml', () => {
    expect(SETTINGS_NS).toBe('plugin-llm-codebuddy')
  })
})
