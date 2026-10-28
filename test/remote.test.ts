import { Context, Service } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CodeBuddyRemoteService } from '../src/remote.js'
import * as codebuddy from '../src/codebuddy.js'
import * as usage from '../src/usage.js'
import * as checkin from '../src/checkin.js'
import type { CodeBuddyIdentity } from '../src/codebuddy.js'
import type { CodeBuddyGrant } from '../src/auth.js'
import type { CodeBuddySession } from '../src/session.js'
import { NotLoggedInError, SessionUnavailableError } from '../src/session.js'
import type { UsageView } from '../src/usage.js'
import { readGrant, writeGrant } from '../src/auth.js'

const scratchDirs: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
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

  describe('checkin', () => {
    it('checkinStatus reports unavailable when no grant is stored', async () => {
      const ctx = await setupScratch()
      const { session, identity } = sessionStub()
      const svc = new CodeBuddyRemoteService(ctx, { session })

      await expect(svc.checkinStatus()).resolves.toEqual({
        available: false, active: false, checkedIn: false,
        streakDays: 0, dailyCredit: 0, todayCredit: 0,
      })
      expect(identity).not.toHaveBeenCalled()
    })

    it('checkinStatus reports unavailable when the endpoint cannot be read', async () => {
      const ctx = await setupScratch()
      await writeGrant(ctx, grant())
      const { session } = sessionStub()
      const fetchSpy = vi.spyOn(checkin, 'fetchCheckinStatus').mockResolvedValue(undefined)
      const svc = new CodeBuddyRemoteService(ctx, { session })

      const status = await svc.checkinStatus()
      expect(status.available).toBe(false)
      expect(status.active).toBe(false)
      expect(fetchSpy).toHaveBeenCalledTimes(1)
    })

    it('checkinStatus passes the read-through flags through', async () => {
      const ctx = await setupScratch()
      await writeGrant(ctx, grant())
      const { session } = sessionStub()
      vi.spyOn(checkin, 'fetchCheckinStatus').mockResolvedValue({
        active: true, checkedIn: true, streakDays: 20, dailyCredit: 100, todayCredit: 100,
      })
      const svc = new CodeBuddyRemoteService(ctx, { session })

      await expect(svc.checkinStatus()).resolves.toEqual({
        available: true, active: true, checkedIn: true,
        streakDays: 20, dailyCredit: 100, todayCredit: 100,
      })
    })

    it('checkin returns the server outcome, including the reason on failure', async () => {
      const ctx = await setupScratch()
      await writeGrant(ctx, grant())
      const { session } = sessionStub()
      const fetchSpy = vi.spyOn(checkin, 'performCheckin').mockResolvedValue({
        success: false, message: '活动未开启', credit: 0, streakDays: 0,
      })
      const svc = new CodeBuddyRemoteService(ctx, { session })

      await expect(svc.checkin()).resolves.toEqual({
        success: false, message: '活动未开启', credit: 0, streakDays: 0,
      })
      expect(fetchSpy).toHaveBeenCalledTimes(1)
    })

    it('checkin reports a signed-out account as failed without calling the endpoint', async () => {
      const ctx = await setupScratch()
      const { session, identity } = sessionStub()
      const fetchSpy = vi.spyOn(checkin, 'performCheckin')
      const svc = new CodeBuddyRemoteService(ctx, { session })

      const result = await svc.checkin()
      expect(result.success).toBe(false)
      expect(result.message).toBe('not signed in')
      expect(identity).not.toHaveBeenCalled()
      expect(fetchSpy).not.toHaveBeenCalled()
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

      await expect(svc.getSettings()).resolves.toEqual({ showUsage: false, showComposerUsage: true, waitOnRateLimit: false, webSearch: false })
    })

    it('returns the authoritative values from the settings handle', async () => {
      // 0.1.7：权威值由 index.ts 从 apply 的 config 句柄传入（volatile 字段经 loader 提交）。
      const ctx = new Context()
      const svc = new CodeBuddyRemoteService(ctx, {
        session: sessionStub().session,
        settings: () => ({ showUsage: false, showComposerUsage: false, webSearch: true, waitOnRateLimit: true }),
      })

      await expect(svc.getSettings()).resolves.toEqual({ showUsage: false, showComposerUsage: false, waitOnRateLimit: true, webSearch: true })
    })

    it('re-reads the handle on every call (volatile commits are visible immediately)', async () => {
      const ctx = new Context()
      let current = { showUsage: true, showComposerUsage: false, webSearch: false, waitOnRateLimit: false }
      const svc = new CodeBuddyRemoteService(ctx, {
        session: sessionStub().session,
        settings: () => current,
      })

      await expect(svc.getSettings()).resolves.toEqual({ showUsage: true, showComposerUsage: false, waitOnRateLimit: false, webSearch: false })
      current = { showUsage: true, showComposerUsage: true, webSearch: true, waitOnRateLimit: true }
      await expect(svc.getSettings()).resolves.toEqual({ showUsage: true, showComposerUsage: true, waitOnRateLimit: true, webSearch: true })
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

    it('writes a waitOnRateLimit-only patch without touching the other switches', async () => {
      const ctx = new Context()
      await ctx.plugin(FakeSettings)
      const settings = ctx.get('settings') as FakeSettings
      const svc = new CodeBuddyRemoteService(ctx, { session: sessionStub().session })

      await expect(svc.setSettings({ waitOnRateLimit: true })).resolves.toBeUndefined()

      expect(settings.calls).toEqual([{ ns: 'plugin-llm-codebuddy', ops: [{ op: 'set', path: ['waitOnRateLimit'], value: true }] }])
    })

    it('is a no-op when no settings seam is mounted', async () => {
      const ctx = new Context()
      const svc = new CodeBuddyRemoteService(ctx, { session: sessionStub().session })

      await expect(svc.setSettings({ showUsage: false })).resolves.toBeUndefined()
    })
  })
  describe('models', () => {
    function modelsSession(overrides: {
      usable?: boolean
      models?: Array<{ id: string; name: string; credits?: string; descriptionZh?: string; descriptionEn?: string }>
      promotions?: Array<{
        id: string
        modelIds?: string[]
        badge?: { label?: string; color?: string }
        hover?: { textZh?: string; textEn?: string }
        discount?: { discountedCredits?: string }
        schedule?: { validFrom?: string; validUntil?: string }
      }>
      tiers?: Array<{
        id: string
        modelIds?: string[]
        badge?: { label?: string; color?: string }
        hover?: { textZh?: string; textEn?: string }
      }>
    }): {
      session: CodeBuddySession
      modelsOrEmpty: ReturnType<typeof vi.fn>
      promotionsOrEmpty: ReturnType<typeof vi.fn>
      tiersOrEmpty: ReturnType<typeof vi.fn>
      isUsable: ReturnType<typeof vi.fn>
    } {
      const base = sessionStub({ usable: overrides.usable ?? true })
      const modelsOrEmpty = vi.fn(async () => overrides.models ?? [])
      const promotionsOrEmpty = vi.fn(async () => overrides.promotions ?? [])
      const tiersOrEmpty = vi.fn(async () => overrides.tiers ?? [])
      const session = {
        invalidate: base.invalidate,
        identity: base.identity,
        isUsable: base.isUsable,
        announceCatalogChange: base.announceCatalogChange,
        modelsOrEmpty,
        promotionsOrEmpty,
        tiersOrEmpty,
      } as unknown as CodeBuddySession
      return { session, modelsOrEmpty, promotionsOrEmpty, tiersOrEmpty, isUsable: base.isUsable }
    }

    it('models() 未登录时返回空目录', async () => {
      const ctx = await setupScratch()
      const { session, modelsOrEmpty, isUsable } = modelsSession({})
      const svc = new CodeBuddyRemoteService(ctx, { session })

      await expect(svc.models()).resolves.toEqual({ loggedIn: false, models: [] })
      // 磁盘上没有凭据：根本不该去碰目录快照与可用性探测。
      expect(isUsable).not.toHaveBeenCalled()
      expect(modelsOrEmpty).not.toHaveBeenCalled()
    })

    it('models() 在凭据过期时与 status() 一致报未登录', async () => {
      // 与 status() 同一套探测：有文件 ≠ 能认证，此时只报未登录、不带任何目录。
      const ctx = await setupScratch()
      await writeGrant(ctx, grant())
      const { session, modelsOrEmpty } = modelsSession({ usable: false })
      const svc = new CodeBuddyRemoteService(ctx, { session })

      await expect(svc.models()).resolves.toEqual({ loggedIn: false, models: [] })
      expect(modelsOrEmpty).not.toHaveBeenCalled()
    })

    it('models() 给命中的模型挂上当前生效的促销与倍率', async () => {
      const ctx = await setupScratch()
      await writeGrant(ctx, grant())
      const { session } = modelsSession({
        models: [{
          id: 'hy3',
          name: 'Hy3',
          credits: 'x0.00',
          descriptionZh: '混元思考模型',
          descriptionEn: 'Hunyuan thinking model',
        }],
        promotions: [{
          id: 'promo-free',
          modelIds: ['hy3'],
          badge: { label: '限时免费', color: '#FF0000' },
          hover: { textZh: '每日赠送免费额度' },
          discount: { discountedCredits: '0x' },
          schedule: { validFrom: '2026-01-01T00:00:00.000Z', validUntil: '2027-01-01T00:00:00.000Z' },
        }],
        tiers: [{
          id: 'tier-sub',
          modelIds: ['hy3'],
          badge: { label: '订阅优先' },
          hover: { textZh: '订阅用户优先调度' },
        }],
      })
      const svc = new CodeBuddyRemoteService(ctx, { session })

      const result = await svc.models()
      expect(result.loggedIn).toBe(true)
      expect(result.models).toHaveLength(1)
      const entry = result.models[0]!
      expect(entry.id).toBe('hy3')
      expect(entry.name).toBe('Hy3')
      // 促销价优先：目录 x0.00 被折扣价 x0 替换，读作免费。
      expect(entry.rate).toEqual({ base: 'x0.00', current: 'x0', strikethrough: false, free: true })
      expect(entry.promotion?.label).toBe('限时免费')
      expect(entry.promotion?.color).toBe('#FF0000')
      expect(entry.promotion?.text).toEqual({ zh: '每日赠送免费额度' })
      expect(entry.promotion?.window).toBe('2026-01-01 – 2027-01-01')
      expect(entry.tier).toEqual({ label: '订阅优先', text: { zh: '订阅用户优先调度' } })
      expect(entry.description).toEqual({ zh: '混元思考模型', en: 'Hunyuan thinking model' })
    })

    it('models() 只把当前生效的促销挂上去', async () => {
      // schedule 起点在未来：目录里有这条促销，但此刻没有生效。
      const ctx = await setupScratch()
      await writeGrant(ctx, grant())
      const { session } = modelsSession({
        models: [{ id: 'hy3', name: 'Hy3', credits: 'x0.00' }],
        promotions: [{
          id: 'promo-future',
          modelIds: ['hy3'],
          badge: { label: '未来促销', color: '#FF0000' },
          schedule: { validFrom: '2999-01-01T00:00:00.000Z' },
        }],
      })
      const svc = new CodeBuddyRemoteService(ctx, { session })

      const result = await svc.models()
      expect(result.loggedIn).toBe(true)
      expect(result.models).toHaveLength(1)
      const entry = result.models[0]!
      expect(entry.promotion).toBeUndefined()
      // 没命中的倍率回落到目录价。
      expect(entry.rate).toEqual({ base: 'x0.00', current: 'x0.00', strikethrough: false, free: true })
    })

    it('models() 给缺颜色的徽章补中性底色、缺 label 的不挂 promotion', async () => {
      const ctx = await setupScratch()
      await writeGrant(ctx, grant())
      const { session } = modelsSession({
        models: [
          { id: 'a', name: 'A', credits: 'x1.00' },
          { id: 'b', name: 'B', credits: 'x1.00' },
        ],
        promotions: [
          // 生效但没给颜色：浏览器要渲染徽章，空颜色会渲染出隐形药丸。
          { id: 'p-nocolor', modelIds: ['a'], badge: { label: '无色徽章' } },
          // 有颜色但没 label：wire 上没有「空徽章」的位置，直接不挂。
          { id: 'p-nolabel', modelIds: ['b'], badge: { color: '#FF0000' } },
        ],
      })
      const svc = new CodeBuddyRemoteService(ctx, { session })

      const result = await svc.models()
      expect(result.models).toHaveLength(2)
      expect(result.models[0]!.promotion).toEqual({ label: '无色徽章', color: '#8A8F99' })
      expect(result.models[1]!.promotion).toBeUndefined()
    })

    it('models() 返回整份目录：未命中的模型照样在列', async () => {
      // 富化是挂上去的，不是筛出来的：客户端按 id 匹配，没有富化的模型也要在列。
      const ctx = await setupScratch()
      await writeGrant(ctx, grant())
      const { session } = modelsSession({
        models: [
          { id: 'hy3', name: 'Hy3', credits: 'x0.00' },
          { id: 'plain', name: 'Plain' },
        ],
        promotions: [{
          id: 'promo-free',
          modelIds: ['hy3'],
          badge: { label: '限时免费', color: '#FF0000' },
          discount: { discountedCredits: '0x' },
        }],
        tiers: [{ id: 'tier-sub', modelIds: ['hy3'], badge: { label: '订阅优先' } }],
      })
      const svc = new CodeBuddyRemoteService(ctx, { session })

      const result = await svc.models()
      expect(result.models.map(entry => entry.id)).toEqual(['hy3', 'plain'])
      const plain = result.models[1]!
      expect(plain.promotion).toBeUndefined()
      expect(plain.tier).toBeUndefined()
      expect(plain.description).toBeUndefined()
    })

    it('models() 给没有可用倍率的模型返回裸条目（不带 rate 字段）', async () => {
      // 目录里没 credits 的模型（如 auto、codewise-*、nes-gf）照样有条目，
      // 但它的 rate 两个字段都缺：下发空 rate 只会让客户端在气泡里打出
      // 「倍率: undefined」，不如整个字段省略（wire 上它本就是 optional）。
      const ctx = await setupScratch()
      await writeGrant(ctx, grant())
      const { session } = modelsSession({
        models: [
          { id: 'auto', name: 'Auto' },
          { id: 'bad', name: 'Bad', credits: 'free' },
        ],
      })
      const svc = new CodeBuddyRemoteService(ctx, { session })

      const result = await svc.models()
      expect(result.models).toHaveLength(2)
      expect('rate' in result.models[0]!).toBe(false)
      expect('rate' in result.models[1]!).toBe(false)
    })
  })
})

describe('channelHealth / probe', () => {
  const chatBase = 'https://copilot.tencent.com/v2'

  /** 每个用例一个独立 home：健康态路径由 DSH_HOME 决定，用例之间不共享。 */
  function scratchHome(): string {
    const dir = mkdtempSync(join(tmpdir(), 'cb-remote-health-'))
    scratchDirs.push(dir)
    vi.stubEnv('DSH_HOME', dir)
    return dir
  }

  it('channelHealth reads stored health without any outbound request', async () => {
    scratchHome()
    const { recordChannelBlock } = await import('../src/channel-health.js')
    await recordChannelBlock({
      at: 2,
      endpoint: chatBase,
      systemLength: 10,
      fingerprintGuess: 'identity-sentence',
    })
    // 卡片的第一次读取必须零外呼：任何请求都会在这里直接抛错。
    vi.stubGlobal('fetch', () => { throw new Error('channelHealth must not touch the network') })
    const ctx = await setupScratch()
    const svc = new CodeBuddyRemoteService(ctx, { session: sessionStub().session, chatBaseURL: () => chatBase })

    await expect(svc.channelHealth()).resolves.toEqual({
      applicable: true,
      lastBlock: { at: 2, fingerprintGuess: 'identity-sentence' },
    })
  })

  it('channelHealth marks a non-CodeBuddy endpoint as not applicable', async () => {
    // 自建网关没有渠道校验：客户端据此整行隐藏，而不是显示一个永远健康的探针。
    scratchHome()
    const ctx = await setupScratch()
    const svc = new CodeBuddyRemoteService(ctx, {
      session: sessionStub().session,
      chatBaseURL: () => 'https://proxy.example/v1',
    })

    await expect(svc.channelHealth()).resolves.toEqual({ applicable: false })
  })

  /** 直接写盘，模拟手改 / 版本偏斜 / 旧宿主留下的记录。 */
  function writeHealth(home: string, value: unknown): void {
    writeFileSync(join(home, 'codebuddy-channel-health.json'), JSON.stringify(value))
  }

  it('drops a lastProbe with an unknown verdict instead of failing the whole call', async () => {
    // readChannelHealth 刻意宽松（verdict 只查字符串），但 wire 上的 strict codec
    // 只认 11 个值：原样下发会让宿主网关 parse 失败，连 applicable 与 lastBlock
    // 一起丢掉——正是「卡片不该因一份旁路数据而消失」要防的场景。
    const home = scratchHome()
    writeHealth(home, {
      lastProbe: { verdict: 'from-the-future', at: 1, model: 'm1', stages: [] },
      lastBlock: { at: 2, requestId: 'r2', endpoint: chatBase, systemLength: 10, fingerprintGuess: 'identity-sentence' },
    })
    const ctx = await setupScratch()
    const svc = new CodeBuddyRemoteService(ctx, { session: sessionStub().session, chatBaseURL: () => chatBase })

    await expect(svc.channelHealth()).resolves.toEqual({
      applicable: true,
      lastBlock: { at: 2, fingerprintGuess: 'identity-sentence' },
    })
  })

  it('drops a lastProbe whose stage shape the client codec would reject', async () => {
    // stages 里的元素同样过 strict codec：缺 stage 的 `{}` 会让整个调用 parse 失败。
    const home = scratchHome()
    writeHealth(home, {
      lastProbe: { verdict: 'healthy', at: 1, model: 'm1', stages: [{}] },
    })
    const ctx = await setupScratch()
    const svc = new CodeBuddyRemoteService(ctx, { session: sessionStub().session, chatBaseURL: () => chatBase })

    await expect(svc.channelHealth()).resolves.toEqual({ applicable: true })
  })

  it('falls back to the default chat base when the composition does not pass one', async () => {
    // headless / 旧组合可能只构造服务、不传 chatBaseURL。缺省按官方 chat base
    // 判 applicable，而不是在调用时炸成 `this.options.chatBaseURL is not a function`。
    scratchHome()
    const ctx = await setupScratch()
    const svc = new CodeBuddyRemoteService(ctx, { session: sessionStub().session })

    await expect(svc.channelHealth()).resolves.toEqual({ applicable: true })
  })

  it('probe returns an auth verdict without the network when the account is signed out', async () => {
    vi.stubGlobal('fetch', () => { throw new Error('probe must not touch the network') })
    const ctx = await setupScratch()
    const session = {
      modelsOrEmpty: async () => [],
      authHeaders: async () => { throw new NotLoggedInError('signed out') },
    } as unknown as CodeBuddySession
    const svc = new CodeBuddyRemoteService(ctx, { session, chatBaseURL: () => chatBase })

    await expect(svc.probe()).resolves.toMatchObject({ verdict: 'auth', model: '', stages: [] })
  })

  it('probe does not turn an unreadable catalog into an auth verdict', async () => {
    // 目录读失败 ≠ 凭据失效：报 auth 会让一个已登录用户白跑一次浏览器握手。
    vi.stubGlobal('fetch', () => { throw new Error('probe must not touch the network') })
    const ctx = await setupScratch()
    const session = {
      modelsOrEmpty: async () => [],
      authHeaders: async () => ({ Authorization: 'Bearer t' }),
    } as unknown as CodeBuddySession
    const svc = new CodeBuddyRemoteService(ctx, { session, chatBaseURL: () => chatBase })

    await expect(svc.probe()).resolves.toMatchObject({ verdict: 'unavailable', model: '', stages: [] })
  })

  it('probe lets a session failure reject instead of fabricating a verdict', async () => {
    // 刷新端点不可达不是一次渠道观测；吞成 verdict 会让卡片把基础设施故障
    // 说成渠道问题。Remote 调用在浏览器侧报错才是事实。
    const ctx = await setupScratch()
    const session = {
      modelsOrEmpty: async () => [{ id: 'm1' }],
      authHeaders: async () => { throw new SessionUnavailableError('refresh endpoint unreachable') },
    } as unknown as CodeBuddySession
    const svc = new CodeBuddyRemoteService(ctx, { session, chatBaseURL: () => chatBase })

    await expect(svc.probe()).rejects.toBeInstanceOf(SessionUnavailableError)
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
