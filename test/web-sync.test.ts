import { Context, Service } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach } from 'vitest'
import { CodeBuddyWebSync, gatewayRootOf } from '../src/web-sync.js'
import { CodeBuddySession } from '../src/session.js'
import { writeGrant } from '../src/auth.js'
import type { CodeBuddyGrant } from '../src/auth.js'

const scratchDirs: string[] = []

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* best-effort cleanup */ }
  }
})

/**
 * ctx.web 的最小替身：真实 dsh-web 把选择存在**私有实例字段**上（运行时是普通
 * 属性），本替身如实复刻这一点，并记录 provider 注册表内容。
 */
class FakeWeb extends Service {
  static inject: string[] = []
  searchProviders = new Map<string, { available(): boolean }>()
  fetchProviders = new Map<string, { available(): boolean }>()
  searchProviderId: string | undefined
  fetchProviderId: string | undefined
  dupeIds = false

  constructor(ctx: Context) {
    super(ctx, 'web')
  }

  registerSearchProvider(provider: { id: string; available(): boolean }): () => void {
    if (this.dupeIds || this.searchProviders.has(provider.id)) throw new Error(`duplicate provider ${provider.id}`)
    this.searchProviders.set(provider.id, provider)
    return () => { this.searchProviders.delete(provider.id) }
  }

  registerFetchProvider(provider: { id: string; available(): boolean }): () => void {
    if (this.dupeIds || this.fetchProviders.has(provider.id)) throw new Error(`duplicate provider ${provider.id}`)
    this.fetchProviders.set(provider.id, provider)
    return () => { this.fetchProviders.delete(provider.id) }
  }
}

function grant(accessToken = 'acc'): CodeBuddyGrant {
  const now = Date.now()
  return {
    accessToken,
    expiresAt: now + 3_600_000,
    refreshToken: 'ref',
    refreshExpiresAt: now + 2_592_000_000,
    domain: 'tencent',
  }
}

async function harness(options: { loggedIn?: boolean; enabled?: boolean } = {}): Promise<{
  ctx: Context
  web: FakeWeb
  sync: CodeBuddyWebSync
  warnings: string[]
  warn: (m: string) => void
}> {
  const dir = mkdtempSync(join(tmpdir(), 'cb-websync-'))
  scratchDirs.push(dir)
  const ctx = new Context()
  await ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), watch: false })
  if (options.loggedIn === true) await writeGrant(ctx, grant())
  const web = new FakeWeb(ctx)
  // Service 需真实 mount 才进 ctx.get（同项目其余测试的既有模式）。
  await ctx.plugin({ apply: () => {}, name: 'noop' })
  ;(ctx as unknown as { set(name: string, value: unknown): void }).set('web', web)

  const warnings: string[] = []
  // 用真实 CodeBuddySession.isLoggedIn：它读的正是 credentials 里的 grant 记录，
  // 登出/登录后的行为才与生产一致（桩函数会把这条链路测没了）。
  const session = new CodeBuddySession(ctx)
  const sync = new CodeBuddyWebSync(
    ctx,
    {
      session,
      gatewayRoot: () => 'https://copilot.tencent.com',
      warn: (m) => warnings.push(m),
    },
    options.enabled ?? true,
  )
  return { ctx, web, sync, warnings, warn: (m) => warnings.push(m) }
}

describe('gatewayRootOf', () => {
  it('strips the chat-plane /v2 suffix', () => {
    expect(gatewayRootOf('https://copilot.tencent.com/v2')).toBe('https://copilot.tencent.com')
  })

  it('tolerates trailing slashes', () => {
    expect(gatewayRootOf('https://copilot.tencent.com/v2/')).toBe('https://copilot.tencent.com')
  })

  it('leaves a custom base without /v2 untouched', () => {
    expect(gatewayRootOf('https://internal.example')).toBe('https://internal.example')
  })
})

describe('CodeBuddyWebSync · registration invariants', () => {
  it('does not register anything while the switch is off, even when signed in', async () => {
    const { sync, web } = await harness({ loggedIn: true, enabled: false })
    sync.start()
    await sync.refreshLogin()

    expect(web.searchProviders.size).toBe(0)
    expect(web.fetchProviders.size).toBe(0)
    expect(web.searchProviderId).toBeUndefined()
  })

  it('does not register while signed out, and never claims the provider slots', async () => {
    const { sync, web } = await harness({ loggedIn: false, enabled: true })
    sync.start()
    await sync.refreshLogin()

    expect(web.searchProviders.size).toBe(0)
    expect(web.fetchProviders.size).toBe(0)
    // 关键不变式：未注册却占着字段会让 seam 对所有 web_search 抛
    // WEB_PROVIDER_CONFIGURED_MISSING，把别人的搜索一起弄坏。
    expect(web.searchProviderId).toBeUndefined()
    expect(web.fetchProviderId).toBeUndefined()
  })

  it('registers both providers and takes over both slots once signed in and enabled', async () => {
    const { sync, web } = await harness({ loggedIn: true, enabled: true })
    sync.start()
    await sync.refreshLogin()

    expect([...web.searchProviders.keys()]).toEqual(['codebuddy'])
    expect([...web.fetchProviders.keys()]).toEqual(['codebuddy'])
    expect(web.searchProviderId).toBe('codebuddy')
    expect(web.fetchProviderId).toBe('codebuddy')
  })

  it('exposes provider availability only while live', async () => {
    const { sync, web } = await harness({ loggedIn: true, enabled: true })
    sync.start()
    await sync.refreshLogin()
    const provider = web.searchProviders.get('codebuddy')
    expect(provider?.available()).toBe(true)

    sync.setEnabled(false)
    expect(provider?.available()).toBe(false)
  })
})

describe('CodeBuddyWebSync · backendState (what the badge reports)', () => {
  it('reports codebuddy only once the selection field actually points at us', async () => {
    const { sync, web } = await harness({ loggedIn: true, enabled: true })
    sync.start()
    await sync.refreshLogin()

    expect(web.searchProviderId).toBe('codebuddy')
    expect(sync.backendState()).toBe('codebuddy')
  })

  it('reports default while the switch is off, even when signed in', async () => {
    const { sync } = await harness({ loggedIn: true, enabled: false })
    sync.start()
    await sync.refreshLogin()

    expect(sync.backendState()).toBe('default')
  })

  it('reports default when signed out with the switch on (intent without effect)', async () => {
    // 开关是「意图」，字段是「效果」：未登录时不注册、不占位，故为 default 而非
    // unavailable——这是正常的让出，不是故障。
    const { sync } = await harness({ loggedIn: false, enabled: true })
    sync.start()
    await sync.refreshLogin()

    expect(sync.backendState()).toBe('default')
  })

  it('reports unavailable when enabled and signed in but the takeover did not happen', async () => {
    // host 未暴露选择字段 → 不注册（见 acquire 的降级）。此时开关与登录都满足，
    // 却没能接管：必须与「开关关着」区分开，否则用户看不出开关失效了。
    const { ctx, sync, web } = await harness({ loggedIn: true, enabled: true })
    const bare = {
      registerSearchProvider: (p: { id: string; available(): boolean }) => web.registerSearchProvider(p),
      registerFetchProvider: (p: { id: string; available(): boolean }) => web.registerFetchProvider(p),
    }
    ;(ctx as unknown as { set(name: string, value: unknown): void }).set('web', bare)

    sync.start()
    await sync.refreshLogin()

    expect(sync.backendState()).toBe('unavailable')
  })

  it('reports unavailable when registration failed and the switch is still on', async () => {
    const { sync, web } = await harness({ loggedIn: true, enabled: true })
    web.dupeIds = true

    sync.start()
    await sync.refreshLogin()

    expect(sync.backendState()).toBe('unavailable')
  })

  it('stops reporting codebuddy when a third party takes the field back', async () => {
    // 判据必须读字段本身而非 isLive()：isLive() 仍为 true，但 seam 已经不会
    // 再分派给我们了——徽标若跟着 isLive() 走就会撒谎。
    const { sync, web } = await harness({ loggedIn: true, enabled: true })
    sync.start()
    await sync.refreshLogin()
    expect(sync.backendState()).toBe('codebuddy')

    web.searchProviderId = 'exa'

    expect(sync.isLive()).toBe(true)
    expect(sync.backendState()).toBe('unavailable')
  })

  it('reports default after dispose, not a stale codebuddy', async () => {
    const { ctx, sync, web } = await harness({ loggedIn: true, enabled: true })
    sync.start()
    await sync.refreshLogin()
    expect(sync.backendState()).toBe('codebuddy')

    // 释放整个 fiber。字段本身不必还原：根 fiber 一 dispose，web 服务也随之
    // 卸载，字段已无人可读。这里要钉的是「不残留过期状态」。
    await ctx.fiber.dispose()

    expect(sync.backendState()).toBe('default')
    expect(web.searchProviders.size).toBe(0)
  })
})

/**
 * 自愈回归。真实部署里，第一次读登录态完全可能早于凭据就绪，而**盘上已有的
 * grant 不会发出 credentials/record-updated**；旧实现把那一刻的 false 钉死后，
 * 就再也回不到「已登录」，界面上只剩「未接管」，刷新页面也救不回来。
 */
describe('CodeBuddyWebSync · self-healing resync', () => {
  it('takes over on resync when the grant became readable after start()', async () => {
    // 启动时读不到凭据（凭据服务/文件尚未就绪）→ 落 loggedIn=false。
    const { ctx, sync } = await harness({ loggedIn: false, enabled: true })
    sync.start()
    await sync.refreshLogin()
    expect(sync.backendState()).toBe('default')

    // 凭据随后可用；注意**不会有任何事件**来通知我们（盘上原有的 grant）。
    await writeGrant(ctx, grant())
    await sync.resync()

    expect(sync.backendState()).toBe('codebuddy')
  })

  it('is a cheap no-op once live (no needless re-acquire)', async () => {
    const { sync, web } = await harness({ loggedIn: true, enabled: true })
    sync.start()
    await sync.refreshLogin()
    expect(sync.isLive()).toBe(true)

    await sync.resync()

    expect(sync.backendState()).toBe('codebuddy')
    // 不重复注册：注册表里仍然只有一个 codebuddy。
    expect([...web.searchProviders.keys()]).toEqual(['codebuddy'])
  })

  it('lets a reloaded plugin fiber take over again (new instance, new ctx)', async () => {
    // 真实重载模型：插件行卸载 → 旧 fiber 的效应全部销毁（注册被撤、字段还原）；
    // 重新加载会再跑一次 apply()，从而得到**新 ctx + 新实例**。这里两代都用
    // ctx.plugin 承载，才等价于宿主真实的装卸方式（ctx.extend() 不产生新 fiber）。
    const { ctx, web } = await harness({ loggedIn: true, enabled: true })
    // 接管前有第三方占位，卸载后应原样还回去。
    web.searchProviderId = 'ddg'

    const mountRow = (): Promise<unknown> => ctx.plugin({
      name: 'fake-codebuddy-row',
      apply(rowCtx: Context) {
        const sync = new CodeBuddyWebSync(rowCtx, {
          session: new CodeBuddySession(rowCtx),
          gatewayRoot: () => 'https://copilot.tencent.com',
        }, true)
        rowCtx.inject(['web'], () => { sync.start() })
      },
    } as never) as unknown as Promise<unknown>

    const firstFiber = await mountRow()
    await vi.waitFor(() => { expect(web.searchProviderId).toBe('codebuddy') })

    // 卸载第一代：效应销毁，让出字段。
    await (firstFiber as { dispose(): Promise<void> }).dispose()
    expect(web.searchProviderId).toBe('ddg')

    // 第二代（新 fiber、新实例）必须能重新接管。
    await mountRow()
    await vi.waitFor(() => { expect(web.searchProviderId).toBe('codebuddy') })
    expect([...web.searchProviders.keys()]).toEqual(['codebuddy'])
  })

  it('keeps the authoritative switch value when it changes while unwired', async () => {
    const { sync } = await harness({ loggedIn: true, enabled: false })
    sync.start()
    await sync.refreshLogin()
    expect(sync.backendState()).toBe('default')

    // 开关值先到：必须被记住并立即生效，不能被「不可用」窗口吞掉。
    sync.setEnabled(true)
    expect(sync.backendState()).toBe('codebuddy')
  })
})

describe('CodeBuddyWebSync · takeover and release', () => {
  it('restores whatever provider occupied the search slot before us (any third party)', async () => {
    const { sync, web } = await harness({ loggedIn: true, enabled: true })
    // 启动前已有别人占用：可能是 free-search(ddg)、exa、bing 或任何第三方。
    web.searchProviderId = 'ddg'
    web.fetchProviderId = 'http'

    sync.start()
    await sync.refreshLogin()
    expect(web.searchProviderId).toBe('codebuddy')

    sync.setEnabled(false)
    // 通用还原：不硬编码任何 provider id。
    expect(web.searchProviderId).toBe('ddg')
    expect(web.fetchProviderId).toBe('http')
  })

  it('restores an explicitly-unset slot back to unset', async () => {
    const { sync, web } = await harness({ loggedIn: true, enabled: true })
    web.searchProviderId = undefined
    web.fetchProviderId = 'http'

    sync.start()
    await sync.refreshLogin()
    expect(web.searchProviderId).toBe('codebuddy')

    sync.setEnabled(false)
    expect(web.searchProviderId).toBeUndefined()
    expect(web.fetchProviderId).toBe('http')
  })

  it('does not clobber a provider that took the slot over while we were live', async () => {
    const { sync, web } = await harness({ loggedIn: true, enabled: true })
    web.searchProviderId = 'ddg'
    sync.start()
    await sync.refreshLogin()
    expect(web.searchProviderId).toBe('codebuddy')

    // 我们在位期间，另一个插件（或用户）把选择改成了自己。
    web.searchProviderId = 'exa'
    sync.setEnabled(false)

    // 让出时只认「仍归我们所有」：改回去会覆盖别人刚建立的选择。
    expect(web.searchProviderId).toBe('exa')
  })

  it('releases when the user signs out, without any explicit toggle', async () => {
    const { ctx, sync, web } = await harness({ loggedIn: true, enabled: true })
    web.searchProviderId = 'ddg'
    sync.start()
    await sync.refreshLogin()
    expect(web.searchProviders.size).toBe(1)

    // 登出：删掉 grant 记录；credentials seam 会发出 record-updated。
    const credentials = ctx.get('credentials')
    expect(credentials).toBeDefined()
    const { recordKey } = await import('../src/auth.js')
    await credentials?.deleteRecord(recordKey())

    await vi.waitFor(() => { expect(web.searchProviders.size).toBe(0) })
    expect(web.searchProviderId).toBe('ddg')
    expect(web.fetchProviderId).toBeUndefined()
  })

  it('re-acquires when the user signs back in', async () => {
    const { ctx, sync, web } = await harness({ loggedIn: true, enabled: true })
    sync.start()
    await sync.refreshLogin()
    expect(web.searchProviders.size).toBe(1)

    const credentials = ctx.get('credentials')
    const { recordKey } = await import('../src/auth.js')
    await credentials?.deleteRecord(recordKey())
    await vi.waitFor(() => { expect(web.searchProviders.size).toBe(0) })

    await writeGrant(ctx, grant('acc2'))
    await vi.waitFor(() => { expect(web.searchProviders.size).toBe(1) })
    expect(web.searchProviderId).toBe('codebuddy')
  })
})

/**
 * 新 cohort（dsh-web 0.2.1-rc.2）形状的最小替身：选择存在 `config` 的 Volatile
 * 引用里（只有 `get()`，没有 `set()`），写选择走 settings 服务。
 *
 * 为什么 Volatile 背后是可写的 cell：生产环境里 loader 拥有这些引用的写入权，
 * 本替身的 cell 就是 loader 的那一份——FakeSettingsVolatile.mutate 模拟宿主
 * loader 的提交（读 settings 文档 → 写进 Volatile）。插件代码只调 `get()` 与
 * `settings.mutate`，两者都是被认可的读/写入口。
 */
class FakeVolatileCell {
  value: string | undefined
  constructor(initial?: string) { this.value = initial }
}

class FakeVolatileRef {
  constructor(private readonly cell: FakeVolatileCell) {}
  get(): string | undefined { return this.cell.value }
}

type SettingsMutateOp =
  | { op: 'set'; path: readonly string[]; value: unknown }
  | { op: 'unset'; path: readonly string[] }

class FakeWebVolatile extends Service {
  static inject: string[] = []
  searchProviders = new Map<string, { available(): boolean }>()
  fetchProviders = new Map<string, { available(): boolean }>()
  readonly config: { searchProvider: FakeVolatileRef; fetchProvider: FakeVolatileRef }
  dupeIds = false

  constructor(ctx: Context, searchCell: FakeVolatileCell, fetchCell: FakeVolatileCell) {
    super(ctx, 'web')
    this.config = {
      searchProvider: new FakeVolatileRef(searchCell),
      fetchProvider: new FakeVolatileRef(fetchCell),
    }
  }

  registerSearchProvider(provider: { id: string; available(): boolean }): () => void {
    if (this.dupeIds || this.searchProviders.has(provider.id)) throw new Error(`duplicate provider ${provider.id}`)
    this.searchProviders.set(provider.id, provider)
    return () => { this.searchProviders.delete(provider.id) }
  }

  registerFetchProvider(provider: { id: string; available(): boolean }): () => void {
    if (this.dupeIds || this.fetchProviders.has(provider.id)) throw new Error(`duplicate provider ${provider.id}`)
    this.fetchProviders.set(provider.id, provider)
    return () => { this.fetchProviders.delete(provider.id) }
  }
}

/** settings 替身（新 cohort 语义）：`mutate('web', ops)` 即提交进 Volatile 的可见效果。 */
class FakeSettingsVolatile extends Service {
  static inject: string[] = []

  constructor(
    ctx: Context,
    private readonly searchCell: FakeVolatileCell,
    private readonly fetchCell: FakeVolatileCell,
  ) {
    super(ctx, 'settings')
  }

  async mutate(ns: string, ops: readonly SettingsMutateOp[]): Promise<void> {
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

async function harnessVolatile(options: { loggedIn?: boolean; enabled?: boolean; withSettings?: boolean; initialSearch?: string; initialFetch?: string } = {}): Promise<{
  ctx: Context
  web: FakeWebVolatile
  searchCell: FakeVolatileCell
  fetchCell: FakeVolatileCell
  sync: CodeBuddyWebSync
  warnings: string[]
}> {
  const dir = mkdtempSync(join(tmpdir(), 'cb-websync-new-'))
  scratchDirs.push(dir)
  const ctx = new Context()
  await ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), watch: false })
  if (options.loggedIn === true) await writeGrant(ctx, grant())
  const searchCell = new FakeVolatileCell(options.initialSearch)
  const fetchCell = new FakeVolatileCell(options.initialFetch)
  const web = new FakeWebVolatile(ctx, searchCell, fetchCell)
  await ctx.plugin({ apply: () => {}, name: 'noop' })
  ;(ctx as unknown as { set(name: string, value: unknown): void }).set('web', web)
  if (options.withSettings !== false) {
    const settings = new FakeSettingsVolatile(ctx, searchCell, fetchCell)
    ;(ctx as unknown as { set(name: string, value: unknown): void }).set('settings', settings)
  }

  const warnings: string[] = []
  const session = new CodeBuddySession(ctx)
  const sync = new CodeBuddyWebSync(
    ctx,
    {
      session,
      gatewayRoot: () => 'https://copilot.tencent.com',
      warn: (m) => warnings.push(m),
    },
    options.enabled ?? true,
  )
  return { ctx, web, searchCell, fetchCell, sync, warnings }
}

describe('CodeBuddyWebSync · new-cohort Volatile selection (0.2.1-rc.2)', () => {
  it('takes over via settings and reports codebuddy, then restores the previous pin on release', async () => {
    const { sync, web, searchCell, fetchCell } = await harnessVolatile({
      loggedIn: true, enabled: true, initialSearch: 'ddg', initialFetch: 'http',
    })
    sync.start()
    await sync.refreshLogin()

    expect([...web.searchProviders.keys()]).toEqual(['codebuddy'])
    expect([...web.fetchProviders.keys()]).toEqual(['codebuddy'])
    // 写选择走的是 settings 文档（新路径下「设置 → Web Search」里可见）。
    expect(searchCell.value).toBe('codebuddy')
    expect(fetchCell.value).toBe('codebuddy')
    expect(sync.backendState()).toBe('codebuddy')

    await sync.setEnabled(false)

    expect(searchCell.value).toBe('ddg')
    expect(fetchCell.value).toBe('http')
    expect(sync.backendState()).toBe('default')
  })

  it('restores an explicitly-unset slot back to unset (not to an empty pin)', async () => {
    const { sync, searchCell, fetchCell } = await harnessVolatile({
      loggedIn: true, enabled: true, initialFetch: 'http',
    })
    sync.start()
    await sync.refreshLogin()
    expect(sync.backendState()).toBe('codebuddy')

    await sync.setEnabled(false)

    expect(searchCell.value).toBeUndefined()
    expect(fetchCell.value).toBe('http')
  })

  it('does not clobber a provider that took the slot over while we were live', async () => {
    const { sync, searchCell } = await harnessVolatile({
      loggedIn: true, enabled: true, initialSearch: 'ddg',
    })
    sync.start()
    await sync.refreshLogin()
    expect(searchCell.value).toBe('codebuddy')

    // 我们在位期间，另一个插件（或用户）把选择改成了自己。
    searchCell.value = 'exa'
    expect(sync.backendState()).toBe('unavailable')
    await sync.setEnabled(false)

    // 让出时只认「仍归我们所有」：改回去会覆盖别人刚建立的选择。
    expect(searchCell.value).toBe('exa')
  })

  it('registers without pinning when the host exposes no settings seam (path B), and reports truthfully', async () => {
    const { sync, web, searchCell } = await harnessVolatile({
      loggedIn: true, enabled: true, initialSearch: 'ddg', withSettings: false,
    })
    sync.start()
    await sync.refreshLogin()

    // 退路：只注册、把钉选留给用户在设置页做。
    expect([...web.searchProviders.keys()]).toEqual(['codebuddy'])
    expect(searchCell.value).toBe('ddg')
    // 没选中我们：如实报 unavailable，而不是 default（开关开着却没生效要能看出来）。
    expect(sync.backendState()).toBe('unavailable')

    // 用户在设置页手动钉选我们后，徽标必须跟上。
    searchCell.value = 'codebuddy'
    expect(sync.backendState()).toBe('codebuddy')

    await sync.setEnabled(false)
    expect([...web.searchProviders.keys()]).toEqual([])
    // 不是我们钉的，释放时不动它。
    expect(searchCell.value).toBe('codebuddy')
  })
})

describe('CodeBuddyWebSync · degradation', () => {
  it('does not register at all when the host exposes no selection fields', async () => {
    const { ctx, sync, web, warnings } = await harness({ loggedIn: true, enabled: true })
    // 未来 dsh-web 若把私有字段真正封起来/改名，我们退化为「不注册」。
    // 不能退化成「只注册不接管」：在**未钉选**的组合里那会让可用 provider
    // 多于一个，seam 随即对所有 web_search 抛 WEB_PROVIDER_AMBIGUOUS——
    // 把自己的无效变成全局故障。不注册则任何组合下都不伤及他人。
    const bare = {
      registerSearchProvider: (p: { id: string; available(): boolean }) => web.registerSearchProvider(p),
      registerFetchProvider: (p: { id: string; available(): boolean }) => web.registerFetchProvider(p),
    }
    ;(ctx as unknown as { set(name: string, value: unknown): void }).set('web', bare)

    sync.start()
    await sync.refreshLogin()

    expect(web.searchProviders.size).toBe(0)
    expect(web.fetchProviders.size).toBe(0)
    expect(warnings.some(w => w.includes('does not expose provider selection fields'))).toBe(true)
  })

  it('keeps other providers selectable when it cannot take over (no AMBIGUOUS regression)', async () => {
    // 反证：若降级成「注册但不接管」，未钉选的组合里就会出现两个可用 provider。
    // 这里用一个真实 WebRuntime 验证那条路径确实会全局抛 AMBIGUOUS，
    // 从而证明「不注册」是必要的而非过度保守。
    const { Context } = await import('@deepseek-ai/cordis')
    const { WebRuntime } = await import('@deepseek-ai/dsh-web')
    const probe = new Context()
    await probe.plugin(WebRuntime, {})
    probe.web.registerSearchProvider({ id: 'other', available: () => true, search: async () => ({ sources: [], truncated: false }) })
    probe.web.registerSearchProvider({ id: 'codebuddy', available: () => true, search: async () => ({ sources: [], truncated: false }) })

    await expect(probe.web.search({ query: 'q' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_AMBIGUOUS' })
  })

  it('warns and stays unregistered when no web service is mounted', async () => {
    const { ctx, sync, warnings } = await harness({ loggedIn: true, enabled: true })
    ;(ctx as unknown as { set(name: string, value: unknown): void }).set('web', undefined)

    sync.start()
    await sync.refreshLogin()

    expect(warnings.some(w => w.includes('no web service'))).toBe(true)
  })

  it('rolls back a partial registration when a provider id is already taken', async () => {
    const { sync, web, warnings } = await harness({ loggedIn: true, enabled: true })
    web.dupeIds = true

    sync.start()
    await sync.refreshLogin()

    // 注册抛错后不能留下「占着字段却没有 provider」的半状态。
    expect(web.searchProviders.size).toBe(0)
    expect(web.fetchProviders.size).toBe(0)
    expect(warnings.some(w => w.includes('registration failed'))).toBe(true)
  })
})
