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
 * settings seam 替身（0.1.7 语义）。复刻 SettingsForms.mutate 的可见效果：
 * 把 volatile-only 的字段写进 entry config 后，loader 的 _commitVolatile 会
 * 就地提交并发 loader/volatile-update——本插件靠该事件对账接管态。
 */
class FakeSettings extends Service {
  static inject: string[] = []
  /** entry id → volatile 段（真实环境里这是 profile patch + loader 提交的联合视图）。 */
  sections = new Map<string, { showUsage?: boolean; webSearch?: boolean }>()

  constructor(ctx: Context) { super(ctx, 'settings') }

  async mutate(ns: string, ops: Array<{ op: 'set'; path: readonly string[]; value: unknown }>): Promise<void> {
    const section = this.sections.get(ns) ?? {}
    for (const op of ops) {
      if (op.op !== 'set' || op.path.length !== 1) continue
      section[op.path[0] as 'showUsage' | 'webSearch'] = op.value as boolean
    }
    this.sections.set(ns, section)
  }
}

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

async function compose(options: { loggedIn: boolean; webSearch: boolean }): Promise<{ ctx: Context; config: Record<string, unknown> }> {
  const dir = mkdtempSync(join(tmpdir(), 'cb-apply-'))
  scratchDirs.push(dir)
  const ctx = new Context()
  await ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), watch: false })
  if (options.loggedIn) await writeGrant(ctx, grant())
  await ctx.plugin(WebRuntime, {})
  await ctx.plugin(FakeLlm)
  const config: Record<string, unknown> = { showUsage: true, webSearch: options.webSearch }
  return { ctx, config }
}

const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 100))

describe('apply() · web search wiring', () => {
  it('leaves the search slot untouched with the default switch state', async () => {
    const { ctx, config } = await compose({ loggedIn: true, webSearch: false })
    // 模拟别人先占位（free-search 的 ddg / base 的 deepseek-official）
    ctx.web.searchProviderId = 'ddg'
    ctx.web.fetchProviderId = 'http'

    apply(ctx, config as never)
    await settle()

    expect(ctx.web.searchProviderId).toBe('ddg')
    expect(ctx.web.fetchProviderId).toBe('http')
  })

  it('takes over both slots when the stored switch is on and the user is signed in', async () => {
    const { ctx, config } = await compose({ loggedIn: true, webSearch: true })
    ctx.web.searchProviderId = 'ddg'
    ctx.web.fetchProviderId = 'http'

    apply(ctx, config as never)
    await settle()

    expect(ctx.web.searchProviderId).toBe('codebuddy')
    expect(ctx.web.fetchProviderId).toBe('codebuddy')
  })

  it('does not register when the switch is on but the user is signed out', async () => {
    const { ctx, config } = await compose({ loggedIn: false, webSearch: true })
    ctx.web.searchProviderId = 'ddg'
    ctx.web.fetchProviderId = 'http'

    apply(ctx, config as never)
    await settle()

    // 未登录：装开关也不接管，更不能占着字段把别人的搜索弄坏。
    expect(ctx.web.searchProviderId).toBe('ddg')
    expect(ctx.web.fetchProviderId).toBe('http')
  })

  it('takes over on a volatile commit that flips the switch on, and releases on flip off', async () => {
    const { ctx, config } = await compose({ loggedIn: true, webSearch: false })
    ctx.web.searchProviderId = 'ddg'
    ctx.web.fetchProviderId = 'http'

    apply(ctx, config as never)
    await settle()
    expect(ctx.web.searchProviderId).toBe('ddg')

    // 用户在设置卡打开开关：settings.mutate 落盘 → loader 就地提交 volatile 值。
    commitVolatile(ctx, config, { webSearch: true })
    await settle()
    expect(ctx.web.searchProviderId).toBe('codebuddy')

    // 再关掉：必须还回原来的 provider，而不是留空。
    commitVolatile(ctx, config, { webSearch: false })
    await settle()
    expect(ctx.web.searchProviderId).toBe('ddg')
    expect(ctx.web.fetchProviderId).toBe('http')
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
    const { ctx, config } = await compose({ loggedIn: true, webSearch: true })
    ctx.web.searchProviderId = 'ddg'

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
    const { ctx, config } = await compose({ loggedIn: true, webSearch: false })
    ctx.web.searchProviderId = 'ddg'

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
    const { ctx, config } = await compose({ loggedIn: true, webSearch: true })
    ctx.web.searchProviderId = 'ddg'

    apply(ctx, config as never)
    await settle()
    expect(await backendOf(ctx)).toBe('codebuddy')

    // 别人后来居上：provider 仍注册着、available() 仍为 true，但 seam 不会再
    // 分派给我们——徽标必须跟着字段走，不能跟着「已注册」走。
    ctx.web.searchProviderId = 'exa'

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
    await ctx.plugin(WebRuntime, {})
    await ctx.plugin(FakeLlm)
    const config: Record<string, unknown> = { showUsage: true, webSearch: true }
    ctx.web.searchProviderId = 'ddg'

    // 关键：apply() 时 credentials 尚不存在，isLoggedIn() 只能返回 false。
    apply(ctx, config as never)
    await settle()
    expect(await backendOf(ctx)).toBe('default')

    // 凭据服务随后就绪，且 grant 早已在盘上（不会触发任何事件）。
    await ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), watch: false })
    await writeGrant(ctx, grant())

    // 不重启、不切换开关：仅一次 status() 读取就该自愈。
    expect(await backendOf(ctx)).toBe('codebuddy')
    expect(ctx.web.searchProviderId).toBe('codebuddy')
  })

  it('keeps the authoritative switch value even if it arrives while unwired', async () => {
    // 开关值先到、web 接线后到：权威值不能被丢掉，start() 时必须按它接管。
    const { ctx, config } = await compose({ loggedIn: true, webSearch: false })
    ctx.web.searchProviderId = 'ddg'

    apply(ctx, config as never)
    await settle()
    commitVolatile(ctx, config, { webSearch: true })
    await settle()

    expect(await backendOf(ctx)).toBe('codebuddy')
    expect(ctx.web.searchProviderId).toBe('codebuddy')
  })
})

/** 0.1.7 entry id 契约：写入方（设置卡 RPC）用的 ns 必须是 patch 行 id。 */
describe('apply() · settings namespace', () => {
  it('uses the entry id declared in cordis.patch.yml', () => {
    expect(SETTINGS_NS).toBe('plugin-llm-codebuddy')
  })
})
