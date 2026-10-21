import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readGrant, writeGrant } from '../src/auth.js'
import type { CodeBuddyGrant } from '../src/auth.js'
import { CodeBuddySession, NotLoggedInError } from '../src/session.js'
import { codeBuddyIdentityHeaders } from '../src/constants.js'
import type { CodeBuddyModel, CodeBuddyPromotion, CodeBuddyTier } from '../src/types.js'

const scratchDirs: string[] = []

afterEach(() => {
  vi.unstubAllGlobals()
  for (const dir of scratchDirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* best-effort cleanup */ }
  }
})

async function setupScratch(): Promise<{ ctx: Context; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'cb-session-'))
  scratchDirs.push(dir)
  const ctx = new Context()
  await ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), watch: false })
  return { ctx, dir }
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

const refreshed = {
  accessToken: 'new',
  expiresIn: 3600,
  refreshToken: 'newr',
  refreshExpiresIn: 2_592_000,
  domain: 'd',
}

function okRefreshResponse(data = refreshed) {
  return { ok: true, status: 200, json: async () => ({ code: 0, msg: '', requestId: 'r', data }) }
}

function installFetch(handler: (url: string, init: unknown) => unknown) {
  const mock = vi.fn(async (url: string, init: unknown) => handler(url, init))
  vi.stubGlobal('fetch', mock)
  return mock
}

describe('CodeBuddySession identity / credential lifecycle', () => {
  it('returns the stored grant without touching fetch or the record when unexpired', async () => {
    const { ctx } = await setupScratch()
    const stored = grant({ accessToken: 'acc', domain: 'd' })
    await writeGrant(ctx, stored)
    const fetchMock = installFetch(() => { throw new Error('fetch must not be called') })

    const session = new CodeBuddySession(ctx)
    await expect(session.identity()).resolves.toEqual({ accessToken: 'acc', domain: 'd' })

    expect(fetchMock).not.toHaveBeenCalled()
    await expect(readGrant(ctx)).resolves.toEqual(stored)
  })

  it('refreshes exactly once and updates the record when the access token is expired', async () => {
    const { ctx } = await setupScratch()
    const now = Date.now()
    const stored = grant({
      accessToken: 'old',
      expiresAt: now - 1_000,
      refreshToken: 'oldr',
      refreshExpiresAt: now + 2_592_000_000,
      domain: 'd',
      uid: 'u1',
      enterpriseId: 'e1',
    })
    await writeGrant(ctx, stored)
    const fetchMock = installFetch(() => okRefreshResponse())

    const session = new CodeBuddySession(ctx)
    await expect(session.identity()).resolves.toEqual({ accessToken: 'new', domain: 'd', uid: 'u1', enterpriseId: 'e1' })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const updated = await readGrant(ctx)
    expect(updated?.accessToken).toBe('new')
    expect(updated?.refreshToken).toBe('newr')
    expect(updated?.domain).toBe('d')
    expect(updated?.uid).toBe('u1')
    expect(updated?.enterpriseId).toBe('e1')
    expect(updated?.expiresAt).toBeGreaterThan(Date.now())
    expect(updated?.refreshExpiresAt).toBeGreaterThan(Date.now())
  })

  it('keeps the old record and rejects identity/authHeaders with NotLoggedInError when refresh fails', async () => {
    const { ctx } = await setupScratch()
    const now = Date.now()
    const stored = grant({
      accessToken: 'old',
      expiresAt: now - 1_000,
      refreshToken: 'oldr',
      refreshExpiresAt: now + 2_592_000_000,
      domain: 'd',
    })
    await writeGrant(ctx, stored)
    installFetch(() => ({ ok: false, status: 401, json: async () => ({ code: 401, msg: 'bad', requestId: 'r' }) }))

    const session = new CodeBuddySession(ctx)
    await expect(session.identity()).rejects.toBeInstanceOf(NotLoggedInError)
    await expect(session.authHeaders()).rejects.toBeInstanceOf(NotLoggedInError)

    await expect(readGrant(ctx)).resolves.toEqual(stored)
  })

  it('shares one refresh across concurrent identity() and authHeaders() calls', async () => {
    const { ctx } = await setupScratch()
    const now = Date.now()
    await writeGrant(ctx, grant({
      accessToken: 'old',
      expiresAt: now - 1_000,
      refreshToken: 'oldr',
      refreshExpiresAt: now + 2_592_000_000,
      domain: 'd',
    }))
    const fetchMock = installFetch(async () => {
      await new Promise(resolve => setTimeout(resolve, 20))
      return okRefreshResponse()
    })

    const session = new CodeBuddySession(ctx)
    const results = await Promise.all([
      session.identity(),
      session.identity(),
      session.authHeaders(),
      session.identity(),
    ])

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(results[0]).toEqual({ accessToken: 'new', domain: 'd' })
    expect(results[1]).toEqual({ accessToken: 'new', domain: 'd' })
    expect(results[2]).toEqual({ ...codeBuddyIdentityHeaders(), 'Authorization': 'Bearer new', 'X-Domain': 'd' })
    expect(results[3]).toEqual({ accessToken: 'new', domain: 'd' })
  })

  it('throws NotLoggedInError from identity() on a bare Context with no credentials seam', async () => {
    const ctx = new Context()
    const session = new CodeBuddySession(ctx)
    await expect(session.identity()).rejects.toBeInstanceOf(NotLoggedInError)
    await expect(session.authHeaders()).rejects.toBeInstanceOf(NotLoggedInError)
    await expect(session.isLoggedIn()).resolves.toBe(false)
  })
})

describe('CodeBuddySession authHeaders / isLoggedIn', () => {
  it('composes the CodeBuddy identity headers, Authorization, X-Domain, and optional uid/enterpriseId', async () => {
    const { ctx } = await setupScratch()
    await writeGrant(ctx, grant({ accessToken: 'acc', domain: 'd', uid: 'u1', enterpriseId: 'e1' }))
    const installFetchResult = installFetch(() => { throw new Error('fetch must not be called') })

    const session = new CodeBuddySession(ctx)
    await expect(session.authHeaders()).resolves.toEqual({
      ...codeBuddyIdentityHeaders(),
      'Authorization': 'Bearer acc',
      'X-Domain': 'd',
      'X-User-Id': 'u1',
      'X-Enterprise-Id': 'e1',
    })
    // 服务端「使用记录」靠这组头把本插件认成 VSCode；锁住它防止被无声删掉。
    expect(codeBuddyIdentityHeaders()['X-IDE-Name']).toBe('VSCode')
    expect(codeBuddyIdentityHeaders()['X-IDE-Type']).toBe('VSCode')
    expect(installFetchResult).not.toHaveBeenCalled()
  })

  it('omits uid/enterpriseId headers when absent and reflects isLoggedIn', async () => {
    const { ctx } = await setupScratch()
    await writeGrant(ctx, grant({ accessToken: 'acc', domain: 'd' }))
    const session = new CodeBuddySession(ctx)
    await expect(session.authHeaders()).resolves.toEqual({
      ...codeBuddyIdentityHeaders(),
      'Authorization': 'Bearer acc',
      'X-Domain': 'd',
    })
    await expect(session.isLoggedIn()).resolves.toBe(true)
  })
})

describe('CodeBuddySession model catalog cache', () => {
  it('caches the catalog within TTL and refetches after invalidate()', async () => {
    const { ctx } = await setupScratch()
    await writeGrant(ctx, grant({ accessToken: 'acc', domain: 'd' }))
    const fetchMock = installFetch(() => ({
      ok: true,
      status: 200,
      json: async () => ({ code: 0, msg: '', requestId: 'r', data: { models: [{ id: 'm1', name: 'Model One' }, { id: '', name: 'blank' }] } }),
    }))

    const session = new CodeBuddySession(ctx)
    await expect(session.models()).resolves.toEqual([{ id: 'm1', name: 'Model One' }])
    await expect(session.models()).resolves.toEqual([{ id: 'm1', name: 'Model One' }])
    expect(fetchMock).toHaveBeenCalledTimes(1)

    session.invalidate()
    await expect(session.models()).resolves.toEqual([{ id: 'm1', name: 'Model One' }])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('modelsOrEmpty returns [] when not logged in', async () => {
    const ctx = new Context()
    const session = new CodeBuddySession(ctx)
    await expect(session.modelsOrEmpty()).resolves.toEqual([])
  })
})

describe('CodeBuddySession catalog change announcements', () => {
  function okConfigResponse(models: { id: string, name: string }[]) {
    return { ok: true, status: 200, json: async () => ({ code: 0, msg: '', requestId: 'r', data: { models } }) }
  }

  async function mounted(models: { id: string, name: string }[] = [{ id: 'm1', name: 'One' }]) {
    const { ctx } = await setupScratch()
    await writeGrant(ctx, grant({ accessToken: 'acc', domain: 'd' }))
    let current = models
    const fetchMock = installFetch(() => okConfigResponse(current))
    const session = new CodeBuddySession(ctx)
    return { session, fetchMock, setModels: (next: { id: string, name: string }[]) => { current = next } }
  }

  it('does not announce the very first read (nothing client-side to invalidate yet)', async () => {
    const { session } = await mounted()
    const listener = vi.fn()
    session.onCatalogChange(listener)

    await session.models()
    await Promise.resolve()

    expect(listener).not.toHaveBeenCalled()
  })

  it('announces when the catalog content actually changes', async () => {
    const { session, setModels } = await mounted()
    await session.models()
    const listener = vi.fn()
    session.onCatalogChange(listener)

    setModels([{ id: 'm1', name: 'One' }, { id: 'm2', name: 'Two' }])
    session.invalidate()
    await session.models()
    await Promise.resolve()

    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('stays silent when a read returns identical content', async () => {
    const { session } = await mounted()
    await session.models()
    const listener = vi.fn()
    session.onCatalogChange(listener)

    session.invalidate()
    await session.models()
    await Promise.resolve()

    // 指纹相同 → 不播报：无条件播报会让每次读取都 churn 客户端的目录与分组。
    expect(listener).not.toHaveBeenCalled()
  })

  it('treats a mere reordering as no change', async () => {
    const { session, setModels } = await mounted([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }])
    await session.models()
    const listener = vi.fn()
    session.onCatalogChange(listener)

    setModels([{ id: 'b', name: 'B' }, { id: 'a', name: 'A' }])
    session.invalidate()
    await session.models()
    await Promise.resolve()

    expect(listener).not.toHaveBeenCalled()
  })

  it('announces on demand for an account change, which has no content diff to observe', async () => {
    const { session } = await mounted()
    const listener = vi.fn()
    session.onCatalogChange(listener)

    session.announceCatalogChange()
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('stops notifying after the disposer runs', async () => {
    const { session } = await mounted()
    const listener = vi.fn()
    const dispose = session.onCatalogChange(listener)
    dispose()

    session.announceCatalogChange()
    expect(listener).not.toHaveBeenCalled()
  })

  it('keeps notifying other listeners when one throws', async () => {
    const { session } = await mounted()
    const healthy = vi.fn()
    session.onCatalogChange(() => { throw new Error('broken observer') })
    session.onCatalogChange(healthy)

    session.announceCatalogChange()
    // 一个坏观察者不能弄挂播报，也不能挡住其他观察者。
    expect(healthy).toHaveBeenCalledTimes(1)
  })

  it('refreshCatalog serves the last good catalog when a forced read fails', async () => {
    const { ctx } = await setupScratch()
    await writeGrant(ctx, grant({ accessToken: 'acc', domain: 'd' }))
    let failing = false
    installFetch(() => failing
      ? { ok: false, status: 500, json: async () => ({ code: 0, msg: 'boom', requestId: 'r' }) }
      : okConfigResponse([{ id: 'm1', name: 'One' }]))
    const session = new CodeBuddySession(ctx)

    await expect(session.models()).resolves.toEqual([{ id: 'm1', name: 'One' }])
    failing = true
    session.invalidate()
    // 一次抖动不许把每一行都清空成裸名字——喂的是选择器的展示富化。
    await expect(session.refreshCatalog()).resolves.toEqual([])
  })

  it('invalidates the credential when the catalog read is refused with 401', async () => {
    const { ctx } = await setupScratch()
    await writeGrant(ctx, grant({ accessToken: 'acc', domain: 'd' }))
    let refused = true
    installFetch(() => refused
      ? { ok: false, status: 401, json: async () => ({ code: 401, msg: 'nope', requestId: 'r' }) }
      : okConfigResponse([{ id: 'm1', name: 'One' }]))
    const session = new CodeBuddySession(ctx)

    await expect(session.models()).rejects.toThrow(/401/)
    // 与 chat 路径对齐：token 被明确拒绝 → 丢掉缓存，让下次调用重读文件。
    refused = false
    await expect(session.models()).resolves.toEqual([{ id: 'm1', name: 'One' }])
  })
})

describe('CodeBuddySession catalog snapshot with promotions and tiers', () => {
  const model: CodeBuddyModel = { id: 'm1', name: 'One', credits: 'x0.29' }
  const promotionA: CodeBuddyPromotion = {
    id: 'p1',
    enabled: true,
    priority: 10,
    modelIds: ['m1'],
    badge: { label: '5 折', color: 'red' },
    hover: { textZh: '限时五折', textEn: '50% off' },
    discount: { discountedCredits: 'x0.15', displayMode: 'replace' },
    schedule: { timezone: 'Asia/Shanghai', daily: [{ start: '00:00', end: '23:59' }] },
  }
  const promotionB: CodeBuddyPromotion = { ...promotionA, badge: { label: '3 折', color: 'red' } }
  const promotionC: CodeBuddyPromotion = { ...promotionA, id: 'p2', modelIds: ['m2'] }
  const tierA: CodeBuddyTier = {
    id: 't1',
    modelIds: ['m1'],
    badge: { label: '专享' },
    tier: 'pro',
    requiredUserType: 'vip',
  }
  const tierB: CodeBuddyTier = { ...tierA, tier: 'enterprise' }

  interface CatalogView {
    fingerprint: string
    promotions: readonly CodeBuddyPromotion[]
    tiers: readonly CodeBuddyTier[]
  }

  /**
   * 读私有的缓存快照：指纹不外露，但「促销变化必须换指纹」正是本任务的规格，
   * 只能从快照上观察（TS private 只是编译期约束）。
   */
  function snapshotOf(session: CodeBuddySession): CatalogView {
    const snapshot = (session as unknown as { catalog?: CatalogView }).catalog
    if (snapshot === undefined) throw new Error('the catalog was never read')
    return snapshot
  }

  type CatalogWire = {
    models: CodeBuddyModel[]
    modelPromotions?: CodeBuddyPromotion[]
    modelTiers?: CodeBuddyTier[]
  }

  async function mounted(initial: CatalogWire | 'fail') {
    const { ctx } = await setupScratch()
    await writeGrant(ctx, grant({ accessToken: 'acc', domain: 'd' }))
    let current: CatalogWire | 'fail' = initial
    installFetch(() => current === 'fail'
      ? { ok: false, status: 500, json: async () => ({ code: 0, msg: 'boom', requestId: 'r' }) }
      : { ok: true, status: 200, json: async () => ({ code: 0, msg: '', requestId: 'r', data: current }) })
    return {
      session: new CodeBuddySession(ctx),
      setConfig: (next: CatalogWire | 'fail') => { current = next },
    }
  }

  async function fingerprintAfter(config: CatalogWire): Promise<string> {
    const { session } = await mounted(config)
    await session.models()
    return snapshotOf(session).fingerprint
  }

  it('changes the fingerprint when only the promotions change', async () => {
    // 模型条目完全相同；不把促销并进指纹，新促销就永远到不了输入框。
    const before = await fingerprintAfter({ models: [model], modelPromotions: [promotionA] })
    const after = await fingerprintAfter({ models: [model], modelPromotions: [promotionB] })
    expect(after).not.toBe(before)
  })

  it('changes the fingerprint when only the tiers change', async () => {
    const before = await fingerprintAfter({ models: [model], modelTiers: [tierA] })
    const after = await fingerprintAfter({ models: [model], modelTiers: [tierB] })
    expect(after).not.toBe(before)
  })

  it('keeps the fingerprint stable when promotions are merely reordered', async () => {
    // 与模型条目同一标准：换序不是内容变化，不该让客户端重拉目录。
    const one = await fingerprintAfter({ models: [model], modelPromotions: [promotionA, promotionC] })
    const other = await fingerprintAfter({ models: [model], modelPromotions: [promotionC, promotionA] })
    expect(other).toBe(one)
  })

  it('changes the fingerprint when only the model description changes', async () => {
    // 描述会渲染进模型条目（Task 5 的 description），只改文案同样必须播报，
    // 否则条目会一直显示旧描述。两种语言各断言一次，防投影只带其中一种。
    const base = await fingerprintAfter({
      models: [{ ...model, descriptionZh: '旧描述', descriptionEn: 'old copy' }],
    })
    const zhChanged = await fingerprintAfter({
      models: [{ ...model, descriptionZh: '新描述', descriptionEn: 'old copy' }],
    })
    const enChanged = await fingerprintAfter({
      models: [{ ...model, descriptionZh: '旧描述', descriptionEn: 'new copy' }],
    })
    expect(zhChanged).not.toBe(base)
    expect(enChanged).not.toBe(base)
  })

  it('keeps the fingerprint stable when modelIds are merely reordered', async () => {
    // 投影对 modelIds 排序；若丢了排序，这里会因两个指纹不同而失败。
    const promotion = { ...promotionA, modelIds: ['m1', 'm2'] }
    const tier = { ...tierA, modelIds: ['m1', 'm2'] }
    const canonical = await fingerprintAfter({
      models: [model],
      modelPromotions: [promotion],
      modelTiers: [tier],
    })
    const reordered = await fingerprintAfter({
      models: [model],
      modelPromotions: [{ ...promotion, modelIds: ['m2', 'm1'] }],
      modelTiers: [{ ...tier, modelIds: ['m2', 'm1'] }],
    })
    expect(reordered).toBe(canonical)
  })

  it('changes the fingerprint when only hover copy changes', async () => {
    // hover 文案会进 tooltip / 分层说明，属于客户端渲染的内容，而不是服务端回显：
    // 只改文案也必须播报，否则提示会一直停在旧措辞，直到某次无关的目录变化。
    const editedPromotionHover = { ...promotionA, hover: { textZh: '另一段文案', textEn: 'other copy' } }
    const promotionBefore = await fingerprintAfter({ models: [model], modelPromotions: [editedPromotionHover] })
    const promotionAfter = await fingerprintAfter({ models: [model], modelPromotions: [promotionA] })
    expect(promotionAfter).not.toBe(promotionBefore)

    const editedTierHover = { ...tierA, hover: { textZh: '另一段说明', textEn: 'other copy' } }
    const tierBefore = await fingerprintAfter({ models: [model], modelTiers: [editedTierHover] })
    const tierAfter = await fingerprintAfter({ models: [model], modelTiers: [tierA] })
    expect(tierAfter).not.toBe(tierBefore)
  })

  it('caches promotions and tiers as the raw wire entries', async () => {
    // 用乱序的多元素 modelIds：指纹投影会排序，若快照存的是投影后的形态，
    // 这里读回来的顺序会变成 ['m1','m2'] 而失败——这是唯一可观察的原始/投影差异。
    const rawPromotion = { ...promotionA, modelIds: ['m2', 'm1'] }
    const rawTier = { ...tierA, modelIds: ['m2', 'm1'] }
    const { session } = await mounted({
      models: [model],
      modelPromotions: [rawPromotion],
      modelTiers: [rawTier],
    })
    await session.models()
    await expect(session.promotionsOrEmpty()).resolves.toEqual([rawPromotion])
    await expect(session.tiersOrEmpty()).resolves.toEqual([rawTier])
  })

  it('defaults omitted promotions and tiers to empty lists', async () => {
    const { session } = await mounted({ models: [model] })
    await session.models()
    await expect(session.promotionsOrEmpty()).resolves.toEqual([])
    await expect(session.tiersOrEmpty()).resolves.toEqual([])
  })

  it('keeps the last good promotions and tiers when a forced read fails', async () => {
    const { session, setConfig } = await mounted({
      models: [model],
      modelPromotions: [promotionA],
      modelTiers: [tierA],
    })
    await session.models()
    // 越过强制读下限：否则强制读退化成缓存副本，根本不会走失败分支。
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(Date.now() + 4_000)
      setConfig('fail')
      await expect(session.refreshCatalog()).resolves.toEqual([model])
      // 与模型同一份快照、同一条失败策略：一次抖动不许把徽标与倍率清空。
      await expect(session.promotionsOrEmpty()).resolves.toEqual([promotionA])
      await expect(session.tiersOrEmpty()).resolves.toEqual([tierA])
    } finally {
      vi.useRealTimers()
    }
  })

  it('announces a promotion-only catalog change', async () => {
    const { session, setConfig } = await mounted({ models: [model], modelPromotions: [promotionA] })
    await session.models()
    const listener = vi.fn()
    session.onCatalogChange(listener)

    setConfig({ models: [model], modelPromotions: [promotionB] })
    session.invalidate()
    await session.models()
    await Promise.resolve()

    // 指纹变了 → 现有播报路径触发，客户端才会重拉。
    expect(listener).toHaveBeenCalledTimes(1)
  })
})

describe('CodeBuddySession.isUsable', () => {
  it('is false when nothing is stored', async () => {
    const ctx = new Context()
    await expect(new CodeBuddySession(ctx).isUsable()).resolves.toBe(false)
  })

  it('is true for a fresh access token without any network call', async () => {
    const { ctx } = await setupScratch()
    await writeGrant(ctx, grant({ accessToken: 'acc', domain: 'd' }))
    const fetchMock = installFetch(() => { throw new Error('fetch must not be called') })

    await expect(new CodeBuddySession(ctx).isUsable()).resolves.toBe(true)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('is false when the refresh token has expired too (dead credential)', async () => {
    const { ctx } = await setupScratch()
    const now = Date.now()
    await writeGrant(ctx, grant({
      accessToken: 'old',
      expiresAt: now - 1_000,
      refreshToken: 'oldr',
      refreshExpiresAt: now - 1, // refresh 也过期
      domain: 'd',
    }))
    installFetch(() => { throw new Error('fetch must not be called') })

    // 文件在，但打不通任何请求 → 不能报「已登录」。
    await expect(new CodeBuddySession(ctx).isUsable()).resolves.toBe(false)
  })

  it('is false when the service refuses the refresh outright', async () => {
    const { ctx } = await setupScratch()
    const now = Date.now()
    await writeGrant(ctx, grant({
      accessToken: 'old',
      expiresAt: now - 1_000,
      refreshToken: 'oldr',
      refreshExpiresAt: now + 2_592_000_000,
      domain: 'd',
    }))
    installFetch(() => ({ ok: false, status: 401, json: async () => ({ code: 401, msg: 'bad', requestId: 'r' }) }))

    await expect(new CodeBuddySession(ctx).isUsable()).resolves.toBe(false)
  })

  it('stays true when the service is merely unreachable (credential was not refused)', async () => {
    const { ctx } = await setupScratch()
    const now = Date.now()
    await writeGrant(ctx, grant({
      accessToken: 'old',
      expiresAt: now - 1_000,
      refreshToken: 'oldr',
      refreshExpiresAt: now + 2_592_000_000,
      domain: 'd',
    }))
    installFetch(() => ({ ok: false, status: 503, json: async () => ({ code: 0, msg: 'down', requestId: 'r' }) }))

    // 网络闪一下不能把用户翻成「未登录」。
    await expect(new CodeBuddySession(ctx).isUsable()).resolves.toBe(true)
  })
})
