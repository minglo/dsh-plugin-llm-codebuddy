import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { judgeStages } from '../src/channel-health.js'
import type { CodeBuddySession } from '../src/session.js'
import type { CodeBuddyModel } from '../src/types.js'

/**
 * POSIX 权限位在 Windows 上表达不出来：可写文件的 `statSync().mode` 恒在 0o666
 * 附近（不随 umask 或我们的 0600 变化），`chmodSync` 也只切换只读位，造不出
 * 「被放宽成 0644」这种状态。所以下面四条权限断言在 win32 上不是失败，而是
 * **测不到东西**——用 `skipIf` 让它们继续在 Linux/macOS 上跑。不要删掉或改成
 * 恒真：它们锁的是「写严格」这条真实约束，只在 Windows 上无意义。
 */
const isWindows = process.platform === 'win32'

// 每个用例一个全新 home：落盘路径由 DSH_HOME 决定，测试之间不共享状态。
let home = ''
// 临时目录逐用例登记，afterEach 里尽力删除：Linux 靠 tmpfs 回收，Windows 上
// 不删就会一直累积（mkdtemp 建在 %TEMP% 下，没有进程退出即清空的保证）。
const scratchDirs: string[] = []
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'cb-health-'))
  scratchDirs.push(home)
  vi.stubEnv('DSH_HOME', home)
  vi.resetModules() // 单飞状态是模块级的，模块必须在每个用例重新求值
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  // force: true 让「用例自己删过」或「从未建出文件」也不算失败；异常吞掉纯属
  // best-effort——清理失败不该把一条真实断言的结果改写成红。
  for (const dir of scratchDirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* best-effort cleanup */ }
  }
})

/** 落盘文件在临时 home 里的位置。 */
const healthFile = () => join(home, 'codebuddy-channel-health.json')

const block = (at: number) => ({
  at,
  requestId: `r${at}`,
  endpoint: 'https://copilot.tencent.com/v2',
  systemLength: 7904,
  fingerprintGuess: 'identity-sentence' as const,
})

describe('readChannelHealth', () => {
  it('returns an empty record when the file is absent', async () => {
    const { readChannelHealth } = await import('../src/channel-health.js')
    expect(await readChannelHealth()).toEqual({ recentBlocks: [] })
  })

  it('returns an empty record when the file is corrupt', async () => {
    writeFileSync(healthFile(), '{not json')
    const { readChannelHealth } = await import('../src/channel-health.js')
    expect(await readChannelHealth()).toEqual({ recentBlocks: [] })
  })

  it('reads a record saved with a leading UTF-8 BOM', async () => {
    // Windows 编辑器给 UTF-8 加 BOM 是常态。`JSON.parse` 见到开头的 U+FEFF 会抛
    // 「Unexpected token」，整份记录被当成「无记录」——历史静默消失。读侧必须剥掉
    // 那一个字符再解析，否则这条用例拿到的是 `{ recentBlocks: [] }`。
    writeFileSync(healthFile(), `\uFEFF${JSON.stringify({ lastBlock: block(9) })}`)
    const { readChannelHealth } = await import('../src/channel-health.js')
    expect((await readChannelHealth()).lastBlock).toMatchObject({ at: 9 })
  })

  it('drops a lastBlock whose fingerprintGuess is outside the closed set', async () => {
    // JSON 合法但形状错了：下游卡片会按三值闭集渲染，'garbage' 没有对应文案。
    writeFileSync(healthFile(), JSON.stringify({
      lastBlock: { at: 1, endpoint: 'e', systemLength: 1, fingerprintGuess: 'garbage' },
    }))
    const { readChannelHealth } = await import('../src/channel-health.js')
    expect((await readChannelHealth()).lastBlock).toBeUndefined()
  })

  it('drops recentBlocks when it is not an array', async () => {
    writeFileSync(healthFile(), JSON.stringify({ recentBlocks: 'x' }))
    const { readChannelHealth } = await import('../src/channel-health.js')
    expect(await readChannelHealth()).toEqual({ recentBlocks: [] })
  })

  it('drops a lastProbe whose stage element is not an object', async () => {
    // Array.isArray 只保证外层是数组；`[null]` 会在卡片里被当成阶段读字段。
    writeFileSync(healthFile(), JSON.stringify({
      lastProbe: { verdict: 'healthy', at: 1, model: 'm1', stages: [null] },
    }))
    const { readChannelHealth } = await import('../src/channel-health.js')
    expect((await readChannelHealth()).lastProbe).toBeUndefined()
  })

  it('drops a lastBlock whose optional requestId is not a string', async () => {
    // requestId 可选，但「有」的时候只能是字符串：42 不是任何一次请求的回执。
    writeFileSync(healthFile(), JSON.stringify({
      lastBlock: { at: 1, requestId: 42, endpoint: 'e', systemLength: 1, fingerprintGuess: 'identity-sentence' },
    }))
    const { readChannelHealth } = await import('../src/channel-health.js')
    expect((await readChannelHealth()).lastBlock).toBeUndefined()
  })
})

describe('recordChannelBlock', () => {
  it('writes the block and keeps it as lastBlock', async () => {
    const { recordChannelBlock, readChannelHealth } = await import('../src/channel-health.js')
    await recordChannelBlock(block(1))
    const stored = await readChannelHealth()
    expect(stored.lastBlock).toMatchObject({ at: 1, requestId: 'r1' })
    expect(stored.recentBlocks).toHaveLength(1)
  })

  it('keeps an existing lastProbe when a real block is recorded', async () => {
    // 写拦截走的是 `{ ...current }` 的读改写；漏掉这个 spread 会在第一次真实拦截
    // 之后悄悄抹掉探针结论，而卡片仍显示「上次自检」——只是变成了无记录。
    const { recordChannelBlock, saveProbeResult, readChannelHealth } = await import('../src/channel-health.js')
    await saveProbeResult({ verdict: 'healthy', at: 1, model: 'm1', stages: [] })
    await recordChannelBlock(block(2))
    const stored = await readChannelHealth()
    expect(stored.lastProbe).toMatchObject({ verdict: 'healthy', at: 1 })
    expect(stored.lastBlock).toMatchObject({ at: 2 })
    expect(stored.recentBlocks).toHaveLength(1)
  })

  it('keeps only the newest twenty blocks, oldest dropped first', async () => {
    const { recordChannelBlock, readChannelHealth } = await import('../src/channel-health.js')
    for (let i = 0; i < 25; i++) await recordChannelBlock(block(i))
    const stored = await readChannelHealth()
    expect(stored.recentBlocks).toHaveLength(20)
    expect(stored.recentBlocks[0]?.at).toBe(5)
    expect(stored.recentBlocks[19]?.at).toBe(24)
  })

  it('keeps every block when several sessions record at once', async () => {
    // 锁的作用点：并发的 read-modify-write 在无锁时会互相覆盖，丢掉的正好是证据。
    const { recordChannelBlock, readChannelHealth } = await import('../src/channel-health.js')
    await Promise.all(Array.from({ length: 10 }, (_, i) => recordChannelBlock(block(i))))
    const stored = await readChannelHealth()
    expect(stored.recentBlocks.map((entry) => entry.at).sort((a, b) => a - b))
      .toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
  })

  it.skipIf(isWindows)('creates a missing home directory instead of dropping the first block', async () => {
    // DSH_HOME 指向尚不存在的目录时，第一次记录曾经直接 ENOENT：真实拦截的第一条
    // 证据就这样丢了，而那正是这个功能存在的理由。锁要在 <file>.lock 上 wx 创建，
    // 它不会替我们建父目录，所以父目录必须由我们建成。
    home = join(home, 'not-created-yet')
    vi.stubEnv('DSH_HOME', home)
    const { recordChannelBlock, readChannelHealth } = await import('../src/channel-health.js')
    await expect(recordChannelBlock(block(3))).resolves.toBeUndefined()
    expect((await readChannelHealth()).lastBlock).toMatchObject({ at: 3 })
    // 目录是本代码建的：诊断文件没有理由让同机其它用户列目录。
    expect(statSync(home).mode & 0o077).toBe(0)
  })

  it.skipIf(isWindows)('narrows the file mode to owner-only', async () => {
    const { recordChannelBlock } = await import('../src/channel-health.js')
    await recordChannelBlock(block(1))
    const mode = statSync(healthFile()).mode & 0o777
    expect(mode & 0o077).toBe(0)
  })

  it.skipIf(isWindows)('still reads a file whose mode was widened by hand', async () => {
    // Review Focus 第 4 条：读宽松、写严格。文件被 chmod 坏了不该让卡片报错。
    const { recordChannelBlock, readChannelHealth } = await import('../src/channel-health.js')
    await recordChannelBlock(block(7))
    chmodSync(healthFile(), 0o644)
    expect((await readChannelHealth()).lastBlock).toMatchObject({ at: 7 })
  })

  it.skipIf(isWindows)('rewrites the widened mode back to owner-only on the next write', async () => {
    const { recordChannelBlock } = await import('../src/channel-health.js')
    await recordChannelBlock(block(1))
    chmodSync(healthFile(), 0o644)
    await recordChannelBlock(block(2))
    expect(statSync(healthFile()).mode & 0o077).toBe(0)
  })
})

describe('saveProbeResult', () => {
  it('does not touch lastBlock', async () => {
    // 自检不能污染「上次真实拦截」。
    const { recordChannelBlock, saveProbeResult, readChannelHealth } = await import('../src/channel-health.js')
    await recordChannelBlock(block(1))
    await saveProbeResult({ verdict: 'healthy', at: 2, model: 'm1', stages: [] })
    const stored = await readChannelHealth()
    expect(stored.lastProbe).toMatchObject({ verdict: 'healthy', at: 2 })
    expect(stored.lastBlock).toMatchObject({ at: 1 })
    expect(stored.recentBlocks).toHaveLength(1)
  })
})

const stage = (s: 'A' | 'B' | 'C', status?: number, code?: number, quota?: boolean) => ({
  stage: s,
  status,
  code,
  ...quota === undefined ? {} : { quota },
})

describe('judgeStages', () => {
  it('healthy: bare passes, raw blocked, neutralized passes', () => {
    expect(judgeStages([stage('A', 200), stage('B', 400, 11128), stage('C', 200)])).toBe('healthy')
  })

  it('rule-gone: the raw fingerprint now passes too', () => {
    expect(judgeStages([stage('A', 200), stage('B', 200), stage('C', 200)])).toBe('rule-gone')
  })

  it('neutralization-broken: both system stages blocked', () => {
    expect(judgeStages([stage('A', 200), stage('B', 400, 11128), stage('C', 400, 11128)])).toBe('neutralization-broken')
  })

  it('inconsistent: raw passes but neutralized is blocked', () => {
    expect(judgeStages([stage('A', 200), stage('B', 200), stage('C', 400, 11128)])).toBe('inconsistent')
  })

  it('stage-failed: a system stage failed for an unrelated reason', () => {
    expect(judgeStages([stage('A', 200), stage('B', 500), stage('C', 200)])).toBe('stage-failed')
  })

  it('does not report a mixed transport failure as unreachable', () => {
    // A 已经拿到状态码：网关可达。B/C 没有状态只说明后续请求失败，不能把整轮
    // 说成「连不上」——那会建议用户去查网络，而问题在 A 之后的那一发。
    const verdict = judgeStages([stage('A', 200), stage('B'), stage('C')], 'unreachable')
    expect(verdict).not.toBe('unreachable')
    expect(verdict).toBe('stage-failed')
  })

  it('reads auth and rate-limit signals only on stage A', () => {
    // A 已返回 200 = 凭据与频率都被上游接受；B/C 的 401/429 不能反过来否定它。
    // 设计 §5 把这两行条件在 A 上，B/C 的同类状态归 stage-failed。
    expect(judgeStages([stage('A', 200), stage('B', 401), stage('C', 200)])).toBe('stage-failed')
    expect(judgeStages([stage('A', 200), stage('B', 429), stage('C', 200)])).toBe('stage-failed')
  })

  it('channel-rejected requires HTTP 400, not just the code', () => {
    // 500 的 body 里也可能透传同一个 code；只看 code 会把服务端故障说成
    // 「你的请求头不合规」，给出完全错误的行动建议。
    expect(judgeStages([stage('A', 500, 11128)])).toBe('unavailable')
  })

  it('channel-rejected: the bare request itself is blocked', () => {
    expect(judgeStages([stage('A', 400, 11128)])).toBe('channel-rejected')
  })

  it('auth / rate-limited / unavailable from A alone', () => {
    expect(judgeStages([stage('A', 401)])).toBe('auth')
    expect(judgeStages([stage('A', 403)])).toBe('auth')
    expect(judgeStages([stage('A', 429)])).toBe('rate-limited')
    expect(judgeStages([stage('A', 400, 1)])).toBe('unavailable')
    expect(judgeStages([stage('A', 500)])).toBe('unavailable')
  })

  it('unreachable when no status was observed at all', () => {
    expect(judgeStages([], 'unreachable')).toBe('unreachable')
    expect(judgeStages([stage('A')], 'unreachable')).toBe('unreachable')
  })

  it('prefers quota over the channel verdict when both signals appear', () => {
    // 实测：内容审核发生在额度检查之前，所以「内容被拦 + 额度也尽了」时上游报的是
    // 额度。判定按同一优先级。
    expect(judgeStages([stage('A', 429, undefined, true)])).toBe('quota')
    expect(judgeStages([stage('A', 400, 11128, true)])).toBe('quota')
  })
})

/** 成功的最小 SSE 响应；探针只需要响应头与可 cancel 的 body。 */
const okResponse = () => new Response('data: [DONE]\n\n', { status: 200, headers: { 'x-request-id': 'ok' } })

/** 上游的渠道拒收：400 + code=11128。 */
const blockedResponse = () => new Response(
  JSON.stringify({ code: 11128, msg: 'Illegal API invocation from an unapproved channel' }),
  { status: 400, headers: { 'x-request-id': 'blocked' } },
)

/** 同一拒收，但业务码是数字字符串：网关不同错误路径的另一种拼写。 */
const blockedStringCodeResponse = () => new Response(
  JSON.stringify({ code: '11128', msg: 'Illegal API invocation from an unapproved channel' }),
  { status: 400, headers: { 'x-request-id': 'blocked-string' } },
)

/**
 * 429 + 额度措辞。`reset` 为真时把一个未来时刻写进报文的成句里（与真实
 * CodeBuddy 报文同形），否则只有 quota 措辞、没有可读的重置时刻。
 */
const quotaResponse = (reset: boolean, headers: Record<string, string> = {}): Response => {
  const at = new Date(Date.now() + 30 * 60_000).toISOString()
  const msg = reset
    ? `usage limit exceeded; it will reset at ${at}`
    : 'usage limit exceeded'
  return new Response(JSON.stringify({ code: 11115, msg }), { status: 429, headers })
}

function fakeSession(): CodeBuddySession {
  return {
    authHeaders: async () => ({ Authorization: 'Bearer t', 'X-Domain': 'd' }),
    modelsOrEmpty: async () => [{ id: 'm1', name: 'M1' }] as CodeBuddyModel[],
  } as unknown as CodeBuddySession
}

describe('probeChannel', () => {
  it('sends three requests: bare, raw fingerprint, neutralized fingerprint', async () => {
    const bodies: string[] = []
    const headers: Record<string, string>[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: string; headers: Record<string, string> }) => {
      bodies.push(init.body)
      headers.push(init.headers)
      return bodies.length === 2
        ? blockedResponse()
        : okResponse()
    }))
    const { probeChannel } = await import('../src/channel-health.js')
    const result = await probeChannel({ session: fakeSession(), baseURL: 'https://copilot.tencent.com/v2' })
    expect(result.verdict).toBe('healthy')
    expect(bodies).toHaveLength(3)
    const systems = bodies.map(body => {
      const parsed = JSON.parse(body) as { messages: { role: string; content: string }[] }
      return parsed.messages.find(message => message.role === 'system')?.content
    })
    expect(systems[0]).toBeUndefined()
    expect(systems[1]).toContain('You are an AI agent powered by DeepSeek Harness')
    // 句号是上游逐字比对的一部分：B 发出去的必须是完整原文，掉了它就会把
    // 「规则还在」测成 rule-gone，反过来建议用户简化中和。
    expect(systems[1]?.endsWith('DeepSeek Harness.')).toBe(true)
    expect(systems[2]).not.toContain('You are an AI agent powered by DeepSeek Harness')
    // 三发都带同一个非空会话标识：探针的头集合必须和真实请求同形。
    expect(headers).toHaveLength(3)
    for (const header of headers) expect(header['X-Conversation-ID']).toBeTruthy()
    expect(new Set(headers.map(header => header['X-Conversation-ID'])).size).toBe(1)
    const firstId = headers[0]?.['X-Conversation-ID']

    // 每一轮都是新会话：复用同一个 id 会让网关把两次自检当成同一段对话，
    // 也可能让上一轮的亲和路由/前缀缓存影响这一轮的观测。
    const deps = { session: fakeSession(), baseURL: 'https://copilot.tencent.com/v2' }
    await probeChannel(deps)
    expect(headers).toHaveLength(6)
    const secondRun = headers.slice(3)
    expect(new Set(secondRun.map(header => header['X-Conversation-ID'])).size).toBe(1)
    expect(secondRun[0]?.['X-Conversation-ID']).not.toBe(firstId)
  })

  it('stops after A when the bare request is blocked', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async () => { calls.push('x'); return blockedResponse() }))
    const { probeChannel } = await import('../src/channel-health.js')
    const result = await probeChannel({ session: fakeSession(), baseURL: 'https://copilot.tencent.com/v2' })
    expect(result.verdict).toBe('channel-rejected')
    expect(calls).toHaveLength(1)
  })

  it('applies its own deadline to a hanging stage request', async () => {
    // 不真等 15 秒：只拨时钟。fetch 永不 resolve，死线应通过传给它的 signal
    // 生效；没有这一条，PROBE_TIMEOUT_MS 写错或漏传都不会被任何用例发现。
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      let captured: AbortSignal | undefined
      vi.stubGlobal('fetch', vi.fn((_url: string, init: { signal: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          captured = init.signal
          init.signal.addEventListener('abort', () => { reject(init.signal.reason) }, { once: true })
        })))
      const { probeChannel } = await import('../src/channel-health.js')
      const pending = probeChannel({ session: fakeSession(), baseURL: 'https://copilot.tencent.com/v2' })
      // 等启动链走完（目录、凭据、头集合都是纯微任务），拿到 fetch 的 signal。
      for (let i = 0; i < 20 && captured === undefined; i++) await Promise.resolve()
      expect(captured).toBeInstanceOf(AbortSignal)
      expect(captured?.aborted).toBe(false)
      await vi.advanceTimersByTimeAsync(15_000)
      const result = await pending
      expect(captured?.aborted).toBe(true)
      // 死线触发后只留下 stage，没有 status：判定不会把它当成一次 HTTP 观测。
      expect(result.stages).toEqual([{ stage: 'A' }])
    } finally {
      vi.useRealTimers()
    }
  })

  it('accepts a numeric string code in the error envelope', async () => {
    // 同一网关的另一种拼写：只认 number 会让 400 + "11128" 漏判成未分类失败。
    vi.stubGlobal('fetch', vi.fn(async () => blockedStringCodeResponse()))
    const { probeChannel } = await import('../src/channel-health.js')
    const result = await probeChannel({ session: fakeSession(), baseURL: 'https://copilot.tencent.com/v2' })
    expect(result.verdict).toBe('channel-rejected')
    expect(result.stages[0]?.code).toBe(11128)
  })

  it('reports rate-limited when a 429 carries quota wording and a readable reset', async () => {
    // 与适配器 failureCode 对齐：有重置时刻就是限流，quota 措辞不抢这条。
    vi.stubGlobal('fetch', vi.fn(async () => quotaResponse(true)))
    const { probeChannel } = await import('../src/channel-health.js')
    const result = await probeChannel({ session: fakeSession(), baseURL: 'https://copilot.tencent.com/v2' })
    expect(result.verdict).toBe('rate-limited')
    expect(result.stages[0]?.quota).toBeUndefined()
  })

  it('reads the Retry-After header as a reset instruction too', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => quotaResponse(false, { 'retry-after': '60' })))
    const { probeChannel } = await import('../src/channel-health.js')
    const result = await probeChannel({ session: fakeSession(), baseURL: 'https://copilot.tencent.com/v2' })
    expect(result.verdict).toBe('rate-limited')
  })

  it('reports quota when the wording says quota and no reset is readable', async () => {
    // 没有重置时刻的 quota 措辞就是真正的额度耗尽：这条不能被 B11 的放宽吃掉。
    vi.stubGlobal('fetch', vi.fn(async () => quotaResponse(false)))
    const { probeChannel } = await import('../src/channel-health.js')
    const result = await probeChannel({ session: fakeSession(), baseURL: 'https://copilot.tencent.com/v2' })
    expect(result.verdict).toBe('quota')
  })

  it('never feeds its own block into the block log', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => blockedResponse()))
    const { probeChannel, readChannelHealth } = await import('../src/channel-health.js')
    await probeChannel({ session: fakeSession(), baseURL: 'https://copilot.tencent.com/v2' })
    const stored = await readChannelHealth()
    expect(stored.lastBlock).toBeUndefined()
  })

  it('returns auth without calling the network when the account is signed out', async () => {
    // 未登录期待「请先登录」，不是三发 401 后报「不可达」。
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async () => { calls.push('x'); return okResponse() }))
    const { probeChannel } = await import('../src/channel-health.js')
    // 用同一次模块注册表里的类：`vi.resetModules()` 之后，文件顶层的静态导入
    // 与这里的动态导入是两个不同的模块实例，`instanceof` 会认不出。
    const { NotLoggedInError } = await import('../src/session.js')
    const signedOut = {
      ...fakeSession(),
      modelsOrEmpty: async () => [],
      authHeaders: async () => { throw new NotLoggedInError('signed out') },
    }
    const result = await probeChannel({ session: signedOut as never, baseURL: 'https://copilot.tencent.com/v2' })
    expect(result.verdict).toBe('auth')
    expect(calls).toHaveLength(0)
  })

  it('does not report an unreadable catalog as auth', async () => {
    // 目录为空也可能是「从未成功读过」：authHeaders() 成功证明账号还在，坏的是
    // 目录。没有模型 id 就发不出合法的 A，结论只能是 unavailable，不是 auth。
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async () => { calls.push('x'); return okResponse() }))
    const { probeChannel } = await import('../src/channel-health.js')
    const catalogDown = { ...fakeSession(), modelsOrEmpty: async () => [] }
    const result = await probeChannel({ session: catalogDown as never, baseURL: 'https://copilot.tencent.com/v2' })
    expect(result.verdict).toBe('unavailable')
    expect(calls).toHaveLength(0)
  })

  it('propagates a session failure instead of calling it auth', async () => {
    // 刷新端点不可达不是「凭据失效」：凭据没有被拒绝，只是基础设施坏了。
    const { probeChannel } = await import('../src/channel-health.js')
    const { SessionUnavailableError } = await import('../src/session.js')
    const unreachable = {
      ...fakeSession(),
      modelsOrEmpty: async () => [],
      authHeaders: async () => { throw new SessionUnavailableError('refresh endpoint unreachable') },
    }
    await expect(probeChannel({
      session: unreachable as never,
      baseURL: 'https://copilot.tencent.com/v2',
    })).rejects.toBeInstanceOf(SessionUnavailableError)
  })

  it('collapses concurrent calls into one run', async () => {
    // Review Focus 第 2 条：连点不产生第二批请求。
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async () => { calls.push('x'); return okResponse() }))
    const { probeChannel } = await import('../src/channel-health.js')
    const deps = { session: fakeSession(), baseURL: 'https://copilot.tencent.com/v2' }
    await Promise.all([probeChannel(deps), probeChannel(deps), probeChannel(deps)])
    expect(calls).toHaveLength(3)
  })

  it('reports a credential failure as auth, never as unreachable', async () => {
    // 目录可能是缓存里的旧快照，凭据却刚过期：modelsOrEmpty 的守卫拦不住这条路。
    // 凭据解析失败没有任何 HTTP 裁决，把它归成「连不上网关」会让用户去查网络。
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async () => { calls.push('x'); return okResponse() }))
    const { probeChannel, readChannelHealth } = await import('../src/channel-health.js')
    // 用同一次模块注册表里的类：`vi.resetModules()` 之后，文件顶层的静态导入
    // 与这里的动态导入是两个不同的模块实例，`instanceof` 会认不出。
    const { NotLoggedInError } = await import('../src/session.js')
    const expired = {
      ...fakeSession(),
      authHeaders: async () => { throw new NotLoggedInError('the session expired') },
    }
    const result = await probeChannel({ session: expired as never, baseURL: 'https://copilot.tencent.com/v2' })
    expect(result.verdict).toBe('auth')
    expect(result.stages).toEqual([])
    expect(calls).toHaveLength(0)
    expect((await readChannelHealth()).lastProbe?.verdict).not.toBe('unreachable')
  })

  it('propagates a caller abort instead of persisting unreachable', async () => {
    // 用户切走不是「网关连不上」的观测值；把它落盘会让下次开卡片报一个假故障。
    const controller = new AbortController()
    vi.stubGlobal('fetch', vi.fn((_url: string, init: { signal: AbortSignal }) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal.addEventListener('abort', () => { reject(init.signal.reason) }, { once: true })
        controller.abort()
      })))
    const { probeChannel, readChannelHealth } = await import('../src/channel-health.js')
    await expect(probeChannel(
      { session: fakeSession(), baseURL: 'https://copilot.tencent.com/v2' },
      controller.signal,
    )).rejects.toThrow()
    expect((await readChannelHealth()).lastProbe).toBeUndefined()
  })

  it('still persists unreachable for a genuine transport failure', async () => {
    // 「网关真的连不上」与「我们自己取消」必须分开：前者仍按 §5 记 unreachable。
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed') }))
    const { probeChannel, readChannelHealth } = await import('../src/channel-health.js')
    const result = await probeChannel({ session: fakeSession(), baseURL: 'https://copilot.tencent.com/v2' })
    expect(result.verdict).toBe('unreachable')
    expect((await readChannelHealth()).lastProbe?.verdict).toBe('unreachable')
  })

  it('returns the verdict and warns when the result cannot be persisted', async () => {
    // 三次请求已经花掉、结论已经算出来：写盘失败只该进 warn，不能让 probe() 拒绝
    // 并把这次读数丢掉。用一个文件冒充 $DSH_HOME，mkdir 必然失败。
    const blockedHome = join(home, 'not-a-directory')
    writeFileSync(blockedHome, 'x')
    vi.stubEnv('DSH_HOME', blockedHome)
    vi.stubGlobal('fetch', vi.fn(async () => okResponse()))
    const warn = vi.fn()
    const { probeChannel } = await import('../src/channel-health.js')
    const result = await probeChannel({
      session: fakeSession(),
      baseURL: 'https://copilot.tencent.com/v2',
      warn,
    })
    expect(result.verdict).toBe('rule-gone')
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain('saving the result failed')
  })
})
