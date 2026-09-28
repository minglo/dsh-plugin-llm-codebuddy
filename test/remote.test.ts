import { Context, Service } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CodeBuddyRemoteService } from '../src/remote.js'
import * as codebuddy from '../src/codebuddy.js'
import * as usage from '../src/usage.js'
import type { CodeBuddyIdentity } from '../src/codebuddy.js'
import type { CodeBuddyGrant } from '../src/auth.js'
import type { CodeBuddySession } from '../src/session.js'
import type { UsageView } from '../src/usage.js'
import { readGrant, recordKey, writeGrant } from '../src/auth.js'

const scratchDirs: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of scratchDirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* best-effort cleanup */ }
  }
})

async function setupScratch(): Promise<Context> {
  const dir = mkdtempSync(join(tmpdir(), 'cb-remote-'))
  scratchDirs.push(dir)
  const ctx = new Context()
  await ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), watch: false })
  return ctx
}

function sessionStub(
  overrides: { usable?: boolean } = {},
): { invalidate: ReturnType<typeof vi.fn>; identity: ReturnType<typeof vi.fn>; isUsable: ReturnType<typeof vi.fn>; announceCatalogChange: ReturnType<typeof vi.fn>; session: CodeBuddySession } {
  const invalidate = vi.fn()
  const identity = vi.fn(async () => ({ accessToken: 'acc', domain: 'tencent' } satisfies CodeBuddyIdentity))
  const isUsable = vi.fn(async () => overrides.usable ?? true)
  const announceCatalogChange = vi.fn()
  return {
    invalidate,
    identity,
    isUsable,
    announceCatalogChange,
    session: { invalidate, identity, isUsable, announceCatalogChange } as unknown as CodeBuddySession,
  }
}

function grant(overrides: Partial<CodeBuddyGrant> = {}): CodeBuddyGrant {
  const now = Date.now()
  return {
    accessToken: 'acc',
    expiresAt: now + 3_600_000,
    refreshToken: 'ref',
    refreshExpiresAt: now + 2_592_000_000,
    domain: 'd',
    ...overrides,
  }
}

function jwt(header: Record<string, unknown>, payload: unknown, signature = 'sig'): string {
  return [
    Buffer.from(JSON.stringify(header)).toString('base64url'),
    Buffer.from(JSON.stringify(payload)).toString('base64url'),
    signature,
  ].join('.')
}

const bucket = (expiring: number, used: number, size: number): UsageView['monthPool'] => ({
  expiring,
  used,
  size,
  usedRatio: size > 0 ? used / size : 0,
})

const view: UsageView = {
  totalBalance: 10,
  totalSize: 20,
  totalUsed: 10,
  totalUsedRatio: 0.5,
  monthPool: bucket(1, 1, 2),
  monthPoolRemain: 1,
  monthPoolExpiring: 1,
  tomorrowExpiring: 2,
  dayAfterExpiring: 3,
  weekExpiring: 4,
  tomorrow: bucket(2, 2, 4),
  dayAfter: bucket(3, 3, 6),
  week: bucket(4, 4, 8),
  details: [{ name: 'pkg', cycleEndTime: '2026-08-31 23:59:59', remain: 10, size: 20, used: 10 }],
}

function usageAccount(): { uid: string; nickname: string; enterpriseId: string } {
  return { uid: 'u1', nickname: 'Nick', enterpriseId: 'ent1' }
}

function authToken() {
  return {
    accessToken: 'login-acc',
    expiresIn: 7200,
    refreshToken: 'login-ref',
    refreshExpiresIn: 2592000,
    domain: 'tencent',
  }
}

describe('CodeBuddyRemoteService', () => {
  // 七方法契约已由 remote-descriptors.test.ts 从描述符层面钉定（更强）；
  // 这里不再重复 typeof 存在性断言（空壳类也通过）。

  describe('status', () => {
    it('returns exactly { loggedIn: false } when no grant is stored', async () => {
      const ctx = await setupScratch()
      const svc = new CodeBuddyRemoteService(ctx, { session: sessionStub().session })

      await expect(svc.status()).resolves.toEqual({ loggedIn: false })
    })

    it('decodes the grant token into userId/tenantId/enterpriseId', async () => {
      const ctx = await setupScratch()
      const token = jwt(
        { alg: 'none' },
        { sub: 'user-1', tenant_id: 'tenant-1', realm_access: { roles: ['user', 'group-admin:ent-1'] } },
      )
      await writeGrant(ctx, grant({ accessToken: token }))
      const svc = new CodeBuddyRemoteService(ctx, { session: sessionStub().session })

      await expect(svc.status()).resolves.toEqual({ loggedIn: true, userId: 'user-1', tenantId: 'tenant-1', enterpriseId: 'ent-1' })
    })

    it('reports loggedIn:false + expired:true when a stored credential can no longer authenticate', async () => {
      // 磁盘上有文件 ≠ 能登录：这才是「显示已登录但模型列表空的还不报错」的根因。
      const ctx = await setupScratch()
      await writeGrant(ctx, grant())
      const svc = new CodeBuddyRemoteService(ctx, { session: sessionStub({ usable: false }).session })

      await expect(svc.status()).resolves.toEqual({ loggedIn: false, expired: true })
    })

    it('does not report expired when nothing is stored at all', async () => {
      // 「从没登过」与「登过但过期」是两件事，客户端文案不同。
      const ctx = await setupScratch()
      const svc = new CodeBuddyRemoteService(ctx, { session: sessionStub({ usable: false }).session })

      const view = await svc.status()
      expect(view.expired).toBeUndefined()
    })

    it('still reports the backend badge for an expired session', async () => {
      const ctx = await setupScratch()
      await writeGrant(ctx, grant())
      const svc = new CodeBuddyRemoteService(ctx, {
        session: sessionStub({ usable: false }).session,
        searchBackend: () => 'default',
      })

      await expect(svc.status()).resolves.toEqual({ loggedIn: false, expired: true, searchBackend: 'default' })
    })

    it('returns { loggedIn: true } without identity keys when the token is not a JWT', async () => {
      const ctx = await setupScratch()
      await writeGrant(ctx, grant())
      const svc = new CodeBuddyRemoteService(ctx, { session: sessionStub().session })

      await expect(svc.status()).resolves.toEqual({ loggedIn: true })
    })

    it('omits searchBackend entirely when no probe is injected (headless)', async () => {
      // 无 web 编排器时不发该字段：客户端据此不渲染徽标，而不是猜一个状态。
      const ctx = await setupScratch()
      const svc = new CodeBuddyRemoteService(ctx, { session: sessionStub().session })

      const view = await svc.status()
      expect('searchBackend' in view).toBe(false)
    })

    it('reports the injected backend state alongside the signed-out view', async () => {
      // 未登录也要带徽标数据：此时正该显示「未接管」，而不是什么都不显示。
      const ctx = await setupScratch()
      const svc = new CodeBuddyRemoteService(ctx, {
        session: sessionStub().session,
        searchBackend: () => 'default',
      })

      await expect(svc.status()).resolves.toEqual({ loggedIn: false, searchBackend: 'default' })
    })

    it('reports the injected backend state alongside the signed-in view', async () => {
      const ctx = await setupScratch()
      await writeGrant(ctx, grant())
      const svc = new CodeBuddyRemoteService(ctx, {
        session: sessionStub().session,
        searchBackend: () => 'codebuddy',
      })

      await expect(svc.status()).resolves.toEqual({ loggedIn: true, searchBackend: 'codebuddy' })
    })

    it('calls the probe on every status read, so the badge never goes stale', async () => {
      const ctx = await setupScratch()
      const probe = vi.fn(() => 'default' as const)
      const svc = new CodeBuddyRemoteService(ctx, { session: sessionStub().session, searchBackend: probe })

      await svc.status()
      await svc.status()

      // 不缓存：开关/登录/接管的任何变化都必须在下一次读数里体现。
      expect(probe).toHaveBeenCalledTimes(2)
    })
  })

  describe('usage', () => {
    it('returns { loggedIn: false } without calling the session when no grant is stored', async () => {
      const ctx = await setupScratch()
      const { session, identity } = sessionStub()
      const svc = new CodeBuddyRemoteService(ctx, { session })

      await expect(svc.usage()).resolves.toEqual({ loggedIn: false })
      expect(identity).not.toHaveBeenCalled()
    })

    it('returns { loggedIn: true, view } with a grant and a successful fetch', async () => {
      const ctx = await setupScratch()
      await writeGrant(ctx, grant())
      const { session, identity } = sessionStub()
      const fetchSpy = vi.spyOn(usage, 'fetchUsage').mockResolvedValue(view)
      const svc = new CodeBuddyRemoteService(ctx, { session })

      // fetchedAt 由宿主给出（额度缓存让一次抓取服务多个入口与多次重挂），
      // 所以断言到字段而不是整对象相等。
      await expect(svc.usage()).resolves.toEqual({ loggedIn: true, view, fetchedAt: expect.any(Number) })

      expect(identity).toHaveBeenCalledTimes(1)
      expect(fetchSpy).toHaveBeenCalledTimes(1)
      expect(fetchSpy).toHaveBeenCalledWith({ accessToken: 'acc', domain: 'tencent' })
    })

    it('retries once after UsageAuthExpiredError and returns the refreshed view', async () => {
      const ctx = await setupScratch()
      await writeGrant(ctx, grant())
      const { session, identity } = sessionStub()
      identity.mockResolvedValueOnce({ accessToken: 'acc', domain: 'tencent' })
      identity.mockResolvedValueOnce({ accessToken: 'refreshed', domain: 'tencent' })
      const fetchSpy = vi.spyOn(usage, 'fetchUsage')
        .mockRejectedValueOnce(new usage.UsageAuthExpiredError())
        .mockResolvedValueOnce(view)
      const svc = new CodeBuddyRemoteService(ctx, { session })

      await expect(svc.usage()).resolves.toEqual({ loggedIn: true, view, fetchedAt: expect.any(Number) })

      expect(identity).toHaveBeenCalledTimes(2)
      expect(fetchSpy).toHaveBeenCalledTimes(2)
      expect(fetchSpy).toHaveBeenNthCalledWith(2, { accessToken: 'refreshed', domain: 'tencent' })
    })

    it('falls back to { loggedIn: false } when the retry still fails auth', async () => {
      const ctx = await setupScratch()
      await writeGrant(ctx, grant())
      const { session, identity } = sessionStub()
      identity.mockResolvedValue({ accessToken: 'acc', domain: 'tencent' })
      vi.spyOn(usage, 'fetchUsage')
        .mockRejectedValueOnce(new usage.UsageAuthExpiredError())
        .mockRejectedValueOnce(new usage.UsageAuthExpiredError())
      const svc = new CodeBuddyRemoteService(ctx, { session })

      await expect(svc.usage()).resolves.toEqual({ loggedIn: false })

      expect(identity).toHaveBeenCalledTimes(2)
    })

    it('rethrows a fetch error that is not auth-expired', async () => {
      const ctx = await setupScratch()
      await writeGrant(ctx, grant())
      const { session } = sessionStub()
      vi.spyOn(usage, 'fetchUsage').mockRejectedValue(new Error('boom'))
      const svc = new CodeBuddyRemoteService(ctx, { session })

      await expect(svc.usage()).rejects.toThrow('boom')
    })
  })

  describe('startLogin / pollLogin', () => {
    it('returns { done: false } for an unknown state', async () => {
      const ctx = await setupScratch()
      const svc = new CodeBuddyRemoteService(ctx, { session: sessionStub().session })

      await expect(svc.pollLogin('unknown-state')).resolves.toEqual({ done: false })
    })

    it('reports done:false once the pending login finishes without a grant', async () => {
      const ctx = await setupScratch()
      const { session } = sessionStub()
      vi.spyOn(codebuddy, 'requestAuthState').mockResolvedValue({ state: 'st-pending', authUrl: 'https://cb/login' })
      let resolveToken: ((value: unknown) => void) | undefined
      vi.spyOn(codebuddy, 'pollAuthToken').mockReturnValue(new Promise(resolve => { resolveToken = resolve }))
      const svc = new CodeBuddyRemoteService(ctx, { session })

      const start = await svc.startLogin()
      expect(start).toEqual({ authUrl: 'https://cb/login', state: 'st-pending' })
      const poll = svc.pollLogin(start.state)
      resolveToken?.(undefined)
      await expect(poll).resolves.toEqual({ done: false })
      await expect(readGrant(ctx)).resolves.toBeUndefined()
    })

    it('completes the login end to end and reports done:true', async () => {
      const ctx = await setupScratch()
      const { session, invalidate } = sessionStub()
      vi.spyOn(codebuddy, 'requestAuthState').mockResolvedValue({ state: 'st-ok', authUrl: 'https://cb/login' })
      vi.spyOn(codebuddy, 'pollAuthToken').mockResolvedValue(authToken())
      vi.spyOn(codebuddy, 'getLoginAccount').mockResolvedValue(usageAccount())
      const svc = new CodeBuddyRemoteService(ctx, { session })

      const start = await svc.startLogin()
      expect(start).toEqual({ authUrl: 'https://cb/login', state: 'st-ok' })
      await expect(svc.pollLogin(start.state)).resolves.toEqual({ done: true })

      const stored = await readGrant(ctx)
      expect(stored).toMatchObject({ accessToken: 'login-acc', domain: 'tencent', uid: 'u1', enterpriseId: 'ent1' })
      expect(invalidate).toHaveBeenCalledTimes(1)
    })
  })

  describe('logout', () => {
    it('deletes the stored grant and invalidates the session', async () => {
      const ctx = await setupScratch()
      await writeGrant(ctx, grant())
      const { session, invalidate, announceCatalogChange: announce } = sessionStub()
      const svc = new CodeBuddyRemoteService(ctx, { session })

      await expect(svc.logout()).resolves.toBeUndefined()

      await expect(readGrant(ctx)).resolves.toBeUndefined()
      expect(invalidate).toHaveBeenCalledTimes(1)
      // 选择器里的模型列表属于刚离开的账号：必须播报，否则它会继续显示。
      expect(announce).toHaveBeenCalledTimes(1)
    })

    it('does not throw and still invalidates when no credentials seam is mounted', async () => {
      const ctx = new Context()
      const { session, invalidate, announceCatalogChange: announce } = sessionStub()
      const svc = new CodeBuddyRemoteService(ctx, { session })

      await expect(svc.logout()).resolves.toBeUndefined()

      expect(invalidate).toHaveBeenCalledTimes(1)
    })
  })

  describe('getSettings', () => {
    it('returns the schema defaults when no settings handle is provided', async () => {
      const ctx = new Context()
      const svc = new CodeBuddyRemoteService(ctx, { session: sessionStub().session })

      await expect(svc.getSettings()).resolves.toEqual({ showUsage: false, showComposerUsage: true, webSearch: false })
    })

    it('returns the authoritative values from the settings handle', async () => {
      // 0.1.7：权威值由 index.ts 从 apply 的 config 句柄传入（volatile 字段经 loader 提交）。
      const ctx = new Context()
      const svc = new CodeBuddyRemoteService(ctx, {
        session: sessionStub().session,
        settings: () => ({ showUsage: false, showComposerUsage: false, webSearch: true }),
      })

      await expect(svc.getSettings()).resolves.toEqual({ showUsage: false, showComposerUsage: false, webSearch: true })
    })

    it('re-reads the handle on every call (volatile commits are visible immediately)', async () => {
      const ctx = new Context()
      let current = { showUsage: true, showComposerUsage: false, webSearch: false }
      const svc = new CodeBuddyRemoteService(ctx, {
        session: sessionStub().session,
        settings: () => current,
      })

      await expect(svc.getSettings()).resolves.toEqual({ showUsage: true, showComposerUsage: false, webSearch: false })
      current = { showUsage: true, showComposerUsage: true, webSearch: true }
      await expect(svc.getSettings()).resolves.toEqual({ showUsage: true, showComposerUsage: true, webSearch: true })
    })
  })

  describe('setSettings', () => {
    it('writes { showUsage } as a path op through settings.mutate', async () => {
      const ctx = new Context()
      await ctx.plugin(FakeSettings)
      const settings = ctx.get('settings') as FakeSettings
      const svc = new CodeBuddyRemoteService(ctx, { session: sessionStub().session })

      await expect(svc.setSettings({ showUsage: false })).resolves.toBeUndefined()

      expect(settings.calls).toEqual([{ ns: 'plugin-llm-codebuddy', ops: [{ op: 'set', path: ['showUsage'], value: false }] }])
    })

    it('writes true for a re-enable', async () => {
      const ctx = new Context()
      await ctx.plugin(FakeSettings)
      const settings = ctx.get('settings') as FakeSettings
      const svc = new CodeBuddyRemoteService(ctx, { session: sessionStub().session })

      await expect(svc.setSettings({ showUsage: true })).resolves.toBeUndefined()

      expect(settings.calls).toEqual([{ ns: 'plugin-llm-codebuddy', ops: [{ op: 'set', path: ['showUsage'], value: true }] }])
    })

    it('writes a showComposerUsage-only patch without touching the other switches', async () => {
      const ctx = new Context()
      await ctx.plugin(FakeSettings)
      const settings = ctx.get('settings') as FakeSettings
      const svc = new CodeBuddyRemoteService(ctx, { session: sessionStub().session })

      await expect(svc.setSettings({ showComposerUsage: false })).resolves.toBeUndefined()

      expect(settings.calls).toEqual([{ ns: 'plugin-llm-codebuddy', ops: [{ op: 'set', path: ['showComposerUsage'], value: false }] }])
    })

    it('writes a webSearch-only patch without touching showUsage', async () => {
      const ctx = new Context()
      await ctx.plugin(FakeSettings)
      const settings = ctx.get('settings') as FakeSettings
      const svc = new CodeBuddyRemoteService(ctx, { session: sessionStub().session })

      await expect(svc.setSettings({ webSearch: true })).resolves.toBeUndefined()

      // 局部更新：只送被切换的字段，避免覆盖另一个开关的当前值。
      expect(settings.calls).toEqual([{ ns: 'plugin-llm-codebuddy', ops: [{ op: 'set', path: ['webSearch'], value: true }] }])
    })

    it('is a no-op when no settings seam is mounted', async () => {
      const ctx = new Context()
      const svc = new CodeBuddyRemoteService(ctx, { session: sessionStub().session })

      await expect(svc.setSettings({ showUsage: false })).resolves.toBeUndefined()
    })
  })
})

// settings seam：Service 子类，经 ctx.get('settings') 提供（同 settings-ns.test.ts 模式）。
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
