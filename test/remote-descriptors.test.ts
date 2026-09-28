import { describe, expect, it } from 'vitest'
import TYPERT_REMOTE, { TYPERT_REMOTE as namedExport } from '../src/remote-descriptors.js'
import type { TypertCodec } from '@deepseek-ai/dsh-typert-protocol'

const METHODS = ['status', 'usage', 'startLogin', 'pollLogin', 'logout', 'getSettings', 'setSettings'] as const

function asStrict(codec: TypertCodec): Extract<TypertCodec, { mode: 'strict' }> {
  if (codec.mode !== 'strict') throw new Error(`expected strict codec, got mode ${codec.mode}`)
  return codec
}

// 0.1.7 的 strict codec 用 create: () => schema（进程域 schema 首次跨界时物化），
// 不再直接携带 schema 字段。
function schemaOf(codec: Extract<TypertCodec, { mode: 'strict' }>): { parse(value: unknown): unknown } {
  return codec.create()
}

function parse(schema: { parse(value: unknown): unknown }, value: unknown): unknown {
  return schema.parse(value)
}

const usageBucket = { expiring: 1, used: 1, size: 2, usedRatio: 0.5 }

const usageView = {
  totalBalance: 10,
  totalSize: 20,
  totalUsed: 10,
  totalUsedRatio: 0.5,
  monthPool: usageBucket,
  monthPoolRemain: 1,
  monthPoolExpiring: 1,
  tomorrowExpiring: 2,
  dayAfterExpiring: 3,
  weekExpiring: 4,
  tomorrow: usageBucket,
  dayAfter: usageBucket,
  week: usageBucket,
  details: [{ name: 'pkg', cycleEndTime: '2026-08-31 23:59:59', remain: 10, size: 20, used: 10 }],
}

const samples: Record<string, unknown> = {
  status: { loggedIn: false },
  usage: { loggedIn: true, view: usageView },
  startLogin: { authUrl: 'https://cb/login', state: 'st-1' },
  pollLogin: { done: true },
  logout: {},
  getSettings: { showUsage: true, showComposerUsage: false, webSearch: false },
  setSettings: {},
}

describe('TYPERT_REMOTE (client remote descriptors)', () => {
  it('exports the contribution as both named and default export', () => {
    expect(namedExport).toBe(TYPERT_REMOTE)
  })

  it('declares exactly the seven codebuddy methods', () => {
    expect(TYPERT_REMOTE.descriptors).toHaveLength(7)
    const methods = TYPERT_REMOTE.descriptors.map(d => d.method)
    expect(methods).toEqual([...METHODS])
  })

  it('satisfies the client $mount shape for every descriptor', () => {
    for (const descriptor of TYPERT_REMOTE.descriptors) {
      expect(descriptor.id).toBeTruthy()
      expect(descriptor.namespace).toBe('codebuddy')
      expect(descriptor.service).toBe('codebuddy')
      expect(METHODS).toContain(descriptor.method)
      expect(descriptor.invocation).toEqual({ kind: 'direct' })
      expect(descriptor.cancellation).toBeUndefined()
      for (const parameter of descriptor.parameters) {
        // create() 必须返回一个带 parse 的 schema（宿主执行 codec.create().parse(value)）。
        expect(schemaOf(asStrict(parameter.codec)).parse).toBeTypeOf('function')
      }
      expect(schemaOf(asStrict(descriptor.result)).parse).toBeTypeOf('function')
    }
  })

  it('caches the process-realm schema across create() calls', () => {
    const status = TYPERT_REMOTE.descriptors.find(d => d.method === 'status')
    expect(status).toBeDefined()
    if (!status) return
    const codec = asStrict(status.result)
    // 0.1.7 语义：create 物化后同一进程域复用同一实例。
    expect(codec.create()).toBe(codec.create())
  })

  it('parses a representative sample value with every param and result codec', () => {
    for (const descriptor of TYPERT_REMOTE.descriptors) {
      const strictResult = asStrict(descriptor.result)
      const parsed = parse(schemaOf(strictResult), samples[descriptor.method])
      expect(parsed).toEqual(samples[descriptor.method])
    }
    const pollLogin = TYPERT_REMOTE.descriptors.find(d => d.method === 'pollLogin')
    expect(pollLogin).toBeDefined()
    const param = pollLogin?.parameters[0]
    expect(param).toBeDefined()
    if (param) {
      expect(schemaOf(asStrict(param.codec)).parse('st1')).toBe('st1')
    }
  })

  describe('pollLogin', () => {
    it('has exactly one parameter named state with wire/source json', () => {
      const pollLogin = TYPERT_REMOTE.descriptors.find(d => d.method === 'pollLogin')
      expect(pollLogin).toBeDefined()
      if (!pollLogin) return
      expect(pollLogin.parameters).toHaveLength(1)
      const param = pollLogin.parameters[0]
      expect(param.name).toBe('state')
      expect(param.wire).toBe('state')
      expect(param.source).toBe('json')
    })
  })

  describe('result codecs match the host wire shapes', () => {
    it('status accepts a full identity view and omits optional keys', () => {
      const descriptor = TYPERT_REMOTE.descriptors.find(d => d.method === 'status')
      expect(descriptor).toBeDefined()
      if (!descriptor) return
      const schema = schemaOf(asStrict(descriptor.result))
      expect(schema.parse({ loggedIn: true, userId: 'u', tenantId: 't', enterpriseId: 'e' })).toEqual({ loggedIn: true, userId: 'u', tenantId: 't', enterpriseId: 'e' })
      expect(schema.parse({ loggedIn: false })).toEqual({ loggedIn: false })
    })

    it('status carries the optional searchBackend badge state and rejects unknown values', () => {
      const descriptor = TYPERT_REMOTE.descriptors.find(d => d.method === 'status')
      expect(descriptor).toBeDefined()
      if (!descriptor) return
      const schema = schemaOf(asStrict(descriptor.result))
      // 三个枚举值都要能过；缺省（旧 host 不发）也必须合法，否则客户端整张卡片
      // 会因 decode 失败而消失。
      for (const state of ['codebuddy', 'default', 'unavailable']) {
        expect(schema.parse({ loggedIn: true, searchBackend: state })).toEqual({ loggedIn: true, searchBackend: state })
      }
      expect(schema.parse({ loggedIn: false })).toEqual({ loggedIn: false })
      expect(() => schema.parse({ loggedIn: true, searchBackend: 'nope' })).toThrow()
    })

    it('usage accepts view with the seven numeric fields and details', () => {
      const descriptor = TYPERT_REMOTE.descriptors.find(d => d.method === 'usage')
      expect(descriptor).toBeDefined()
      if (!descriptor) return
      const schema = schemaOf(asStrict(descriptor.result))
      expect(schema.parse({ loggedIn: true, view: usageView })).toEqual({ loggedIn: true, view: usageView })
      expect(schema.parse({ loggedIn: true })).toEqual({ loggedIn: true })
    })

    it('logout result accepts an empty object (remote undefined -> void)', () => {
      const descriptor = TYPERT_REMOTE.descriptors.find(d => d.method === 'logout')
      expect(descriptor).toBeDefined()
      if (!descriptor) return
      expect(schemaOf(asStrict(descriptor.result)).parse({})).toEqual({})
      expect(descriptor.parameters).toHaveLength(0)
    })

    it('getSettings tolerates a host that predates showComposerUsage', () => {
      // host 与 client 是两个独立产物：浏览器 bundle 经 HMR 可以先换，宿主模块
      // 要重启才换。新 client + 旧 host 时 decode 必须成功，否则整张配置卡片
      // 会静默消失（与 status.searchBackend 是同一条不变式）。
      const descriptor = TYPERT_REMOTE.descriptors.find(d => d.method === 'getSettings')
      expect(descriptor).toBeDefined()
      if (!descriptor) return
      const schema = schemaOf(asStrict(descriptor.result))
      expect(schema.parse({ showUsage: true, webSearch: false }))
        .toEqual({ showUsage: true, webSearch: false })
    })

    it('startLogin/getSettings/pollLogin match their host payloads', () => {
      const start = TYPERT_REMOTE.descriptors.find(d => d.method === 'startLogin')
      expect(start).toBeDefined()
      if (start) expect(schemaOf(asStrict(start.result)).parse({ authUrl: 'u', state: 's' })).toEqual({ authUrl: 'u', state: 's' })
      const poll = TYPERT_REMOTE.descriptors.find(d => d.method === 'pollLogin')
      expect(poll).toBeDefined()
      if (poll) expect(schemaOf(asStrict(poll.result)).parse({ done: false })).toEqual({ done: false })
      const settings = TYPERT_REMOTE.descriptors.find(d => d.method === 'getSettings')
      expect(settings).toBeDefined()
      if (settings) expect(schemaOf(asStrict(settings.result)).parse({ showUsage: true, showComposerUsage: false, webSearch: false })).toEqual({ showUsage: true, showComposerUsage: false, webSearch: false })
    })
  })

  describe('setSettings', () => {
    it('has exactly one patch parameter with a strict partial { showUsage?, showComposerUsage?, webSearch? } codec', () => {
      const descriptor = TYPERT_REMOTE.descriptors.find(d => d.method === 'setSettings')
      expect(descriptor).toBeDefined()
      if (!descriptor) return
      expect(descriptor.parameters).toHaveLength(1)
      const param = descriptor.parameters[0]
      if (!param) return
      expect(param.name).toBe('patch')
      expect(param.wire).toBe('patch')
      expect(param.source).toBe('json')
      const codec = asStrict(param.codec)
      expect(codec.typeSymbol).toContain('setSettings')
      const schema = schemaOf(codec)
      expect(schema.parse({ showUsage: true })).toEqual({ showUsage: true })
      expect(schema.parse({ showComposerUsage: true })).toEqual({ showComposerUsage: true })
      expect(schema.parse({ webSearch: true })).toEqual({ webSearch: true })
      expect(schema.parse({ showUsage: false, showComposerUsage: false, webSearch: true }))
        .toEqual({ showUsage: false, showComposerUsage: false, webSearch: true })
      // 两个字段都可选：局部更新只送被切换的那一个。空 patch 是合法的无操作。
      expect(schema.parse({})).toEqual({})
      expect(() => schema.parse({ showUsage: 'yes' })).toThrow()
      expect(() => schema.parse({ showComposerUsage: 'yes' })).toThrow()
      expect(() => schema.parse({ webSearch: 'yes' })).toThrow()
    })

    it('result accepts an empty object (remote undefined -> void)', () => {
      const descriptor = TYPERT_REMOTE.descriptors.find(d => d.method === 'setSettings')
      expect(descriptor).toBeDefined()
      if (!descriptor) return
      expect(schemaOf(asStrict(descriptor.result)).parse({})).toEqual({})
    })
  })
})
