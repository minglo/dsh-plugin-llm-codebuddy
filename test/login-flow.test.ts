import { Context, Service } from '@deepseek-ai/cordis'
import type { AuthorizationFlow, AuthorizationSession } from '@deepseek-ai/dsh-authorization'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as codebuddy from '../src/codebuddy.js'
import { completeLogin, registerCodeBuddyFlow } from '../src/login-flow.js'
import { readGrant, recordKey } from '../src/auth.js'
import type { CodeBuddySession } from '../src/session.js'

const scratchDirs: string[] = []
let scratchDir: string

beforeAll(() => {
  scratchDir = mkdtempSync(join(tmpdir(), 'cb-login-flow-'))
  scratchDirs.push(scratchDir)
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of scratchDirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* best-effort cleanup */ }
  }
})

// authorization seam：Service 子类（同 dsh-authorization 的 AuthorizationService 一样经
// ctx.get('authorization') 提供），捕获 registerFlow 的 flow 供测试驱动 run()。
class FakeAuthorization extends Service {
  static inject = ['credentials']
  flows: AuthorizationFlow[] = []

  constructor(ctx: Context) {
    super(ctx, 'authorization')
  }

  registerFlow(flow: AuthorizationFlow): () => void {
    this.flows.push(flow)
    return () => {}
  }
}

function fakeSession(): { method: string; signal: AbortSignal; notify: ReturnType<typeof vi.fn> } {
  return { method: 'browser', signal: new AbortController().signal, notify: vi.fn() }
}

function fakeCodeBuddySession(): CodeBuddySession {
  return { invalidate: vi.fn(), announceCatalogChange: vi.fn() } as unknown as CodeBuddySession
}

async function setupScratch(): Promise<{ ctx: Context; auth: FakeAuthorization; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'cb-login-flow-case-'))
  scratchDirs.push(dir)
  const ctx = new Context()
  await ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), watch: false })
  await ctx.plugin(FakeAuthorization)
  const auth = ctx.get('authorization') as FakeAuthorization
  return { ctx, auth, dir }
}

describe('registerCodeBuddyFlow', () => {
  it('registers a flow under plugin-llm-codebuddy/codebuddy with browser methods', async () => {
    const { ctx, auth } = await setupScratch()
    registerCodeBuddyFlow(ctx)
    expect(auth.flows).toHaveLength(1)
    const flow = auth.flows[0]!
    expect(flow.key).toBe(recordKey())
    expect(flow.label).toBe('CodeBuddy')
    expect(flow.methods.length).toBeGreaterThan(0)
    expect(flow.methods[0]!.id).toBe('browser')
  })

  it('registers nothing and does not throw when no authorization seam is mounted', async () => {
    const ctx = new Context()
    await ctx.plugin(LocalCredentialProvider, { path: join(scratchDir, 'noauth.yaml'), watch: false })
    // 原先这里唯一的断言是 `ctx.get('authorization')` 为 undefined——那在调用**之前**
    // 就成立，等于没测调用。这里直接断言调用本身不抛（headless 形态会走这条路）。
    expect(() => registerCodeBuddyFlow(ctx)).not.toThrow()
    expect(ctx.get('authorization')).toBeUndefined()
  })
})

describe('completeLogin', () => {
  beforeEach(() => {
    vi.spyOn(codebuddy, 'requestAuthState').mockResolvedValue({ state: 'st1', authUrl: 'https://x/login' })
    vi.spyOn(codebuddy, 'pollAuthToken').mockResolvedValue({
      accessToken: 'acc',
      expiresIn: 7200,
      refreshToken: 'rt',
      refreshExpiresIn: 2592000,
      domain: 'tencent',
    })
    vi.spyOn(codebuddy, 'getLoginAccount').mockResolvedValue({ uid: 'u1', nickname: 'Nick', enterpriseId: 'ent1' })
  })

  it('polls the token, fetches the account, writes the grant, and invalidates the session', async () => {
    const { ctx } = await setupScratch()
    const session = fakeCodeBuddySession()
    const before = Date.now()

    const grant = await completeLogin(ctx, 'st1', session)

    const after = Date.now()
    expect(grant).toBeDefined()
    expect(grant!.accessToken).toBe('acc')
    expect(grant!.refreshToken).toBe('rt')
    expect(grant!.domain).toBe('tencent')
    expect(grant!.uid).toBe('u1')
    expect(grant!.enterpriseId).toBe('ent1')
    expect(grant!.expiresAt).toBeGreaterThanOrEqual(before + 7200 * 1000)
    expect(grant!.expiresAt).toBeLessThanOrEqual(after + 7200 * 1000)
    expect(grant!.refreshExpiresAt).toBeGreaterThanOrEqual(before + 2592000 * 1000)
    expect(grant!.refreshExpiresAt).toBeLessThanOrEqual(after + 2592000 * 1000)
    expect(session.invalidate).toHaveBeenCalledTimes(1)
    // 换账号意味着客户端手里的整份模型列表都属于上一个（可能是已登出的）状态：
    // 必须播报，不能等到某次读取碰巧内容不同。
    expect(session.announceCatalogChange).toHaveBeenCalledTimes(1)

    const stored = await readGrant(ctx)
    expect(stored).toEqual(grant)
    expect(codebuddy.pollAuthToken).toHaveBeenCalledWith('st1', undefined)
    expect(codebuddy.getLoginAccount).toHaveBeenCalledWith('st1', 'acc', 'tencent')
  })

  it('returns undefined and stores nothing when polling yields no token', async () => {
    const { ctx } = await setupScratch()
    vi.mocked(codebuddy.pollAuthToken).mockResolvedValue(undefined)
    const session = fakeCodeBuddySession()

    await expect(completeLogin(ctx, 'st1', session)).resolves.toBeUndefined()

    await expect(readGrant(ctx)).resolves.toBeUndefined()
    expect(codebuddy.getLoginAccount).not.toHaveBeenCalled()
    expect(session.invalidate).not.toHaveBeenCalled()
  })
})

describe('registerCodeBuddyFlow flow.run', () => {
  beforeEach(() => {
    vi.spyOn(codebuddy, 'requestAuthState').mockResolvedValue({ state: 'st1', authUrl: 'https://x/login' })
    vi.spyOn(codebuddy, 'pollAuthToken').mockResolvedValue({
      accessToken: 'acc',
      expiresIn: 7200,
      refreshToken: 'rt',
      refreshExpiresIn: 2592000,
      domain: 'tencent',
    })
    vi.spyOn(codebuddy, 'getLoginAccount').mockResolvedValue({ uid: 'u1', nickname: 'Nick', enterpriseId: 'ent1' })
  })

  it('notifies the auth url, completes login end to end, and invalidates the session', async () => {
    const { ctx, auth } = await setupScratch()
    const session = fakeCodeBuddySession()
    registerCodeBuddyFlow(ctx, session as unknown as CodeBuddySession)
    const authSession = fakeSession()

    await auth.flows[0]!.run(authSession)

    expect(codebuddy.requestAuthState).toHaveBeenCalledWith(authSession.signal)
    expect(authSession.notify).toHaveBeenCalledTimes(1)
    expect(authSession.notify).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://x/login' }))
    expect(codebuddy.pollAuthToken).toHaveBeenCalledWith('st1', authSession.signal)
    expect(codebuddy.getLoginAccount).toHaveBeenCalledWith('st1', 'acc', 'tencent')
    const stored = await readGrant(ctx)
    expect(stored).toMatchObject({ accessToken: 'acc', domain: 'tencent', uid: 'u1', enterpriseId: 'ent1' })
    expect(session.invalidate).toHaveBeenCalledTimes(1)
  })

  it('throws when the sign-in never completes (poll returns no token)', async () => {
    const { ctx, auth } = await setupScratch()
    vi.mocked(codebuddy.pollAuthToken).mockResolvedValue(undefined)
    registerCodeBuddyFlow(ctx)
    const authSession = fakeSession()

    await expect(auth.flows[0]!.run(authSession)).rejects.toThrow('CodeBuddy sign-in did not complete.')

    expect(authSession.notify).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://x/login' }))
    await expect(readGrant(ctx)).resolves.toBeUndefined()
  })
})
