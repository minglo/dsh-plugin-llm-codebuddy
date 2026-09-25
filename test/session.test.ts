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
