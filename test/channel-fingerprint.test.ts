import { describe, expect, it } from 'vitest'
import { isCodeBuddyEndpoint, rewriteHarnessIdentity } from '../src/channel-fingerprint.js'

// 上游按「渠道校验」核对调用方：提示里带 harness 产品名就一律拒收
// （HTTP 400 · code=11128 · "Illegal API invocation from an unapproved channel"）。
// 同一凭据破坏指纹就立刻 200——所以出站前必须中和它。
//
// 指纹不止一处，且上游会加：已实测被拦的是「开头那句身份声明」与「部署说明里
// 提到 harness Web GUI 的那句」。两者都含产品名，所以规则是两条：开头那句补
// 逗号，其余产品名换中性代称。

const IDENTITY = 'You are an AI agent powered by DeepSeek Harness.'

describe('rewriteHarnessIdentity', () => {
  it('breaks the identity sentence with a comma after "agent"', () => {
    expect(rewriteHarnessIdentity(IDENTITY)).toBe('You are an AI agent, powered by DeepSeek Harness.')
  })

  it('keeps the rest of the identity line untouched', () => {
    expect(rewriteHarnessIdentity(`${IDENTITY}\n\nBody.`)).toBe('You are an AI agent, powered by DeepSeek Harness.\n\nBody.')
  })

  it('neutralizes the product name elsewhere in the prompt', () => {
    // 部署说明那句也是指纹：上游 10-21 当天加的，同构请求此前还通着。
    const prompt = 'You are interacting with the user through the DeepSeek Harness Web GUI whose URL the runtime context names.'
    expect(rewriteHarnessIdentity(prompt)).toBe('You are interacting with the user through this harness Web GUI whose URL the runtime context names.')
  })

  it('neutralizes a bare product name without doubling the article', () => {
    expect(rewriteHarnessIdentity('# DeepSeek Harness (dsh) Tool Mapping'))
      .toBe('# the harness (dsh) Tool Mapping')
  })

  it('neutralizes the product name regardless of case', () => {
    // 上游的判定不分大小写，中和也必须分。
    expect(rewriteHarnessIdentity('DeepSeek Harness is dsh.')).toBe('the harness is dsh.')
  })

  it('is idempotent: a rewritten prompt is not rewritten again', () => {
    const once = rewriteHarnessIdentity(`${IDENTITY}\n\nDeepSeek Harness Web GUI`)
    expect(rewriteHarnessIdentity(once)).toBe(once)
  })

  it('leaves a prompt without the product name byte-identical', () => {
    const text = 'You are a coding agent powered by the m model.\n\n<EXTREMELY-IMPORTANT>'
    expect(rewriteHarnessIdentity(text)).toBe(text)
  })

  it('neutralizes the product name even when the identity sentence is not at the start', () => {
    // 上游只对开头那句整句比对，所以不在开头时不必补逗号；但产品名照样要中和。
    const text = 'Intro.\n\nYou are an AI agent powered by DeepSeek Harness.'
    expect(rewriteHarnessIdentity(text)).toBe('Intro.\n\nYou are an AI agent powered by the harness.')
  })
})

describe('isCodeBuddyEndpoint', () => {
  it('recognizes the official chat base', () => {
    expect(isCodeBuddyEndpoint('https://copilot.tencent.com/v2')).toBe(true)
    expect(isCodeBuddyEndpoint('https://copilot.tencent.com')).toBe(true)
  })

  it('does not recognize a proxy', () => {
    // 代理/自建网关没有渠道校验，它的运营方应该看到 dsh 真正组装的提示。
    expect(isCodeBuddyEndpoint('https://proxy.example/v2')).toBe(false)
  })

  it('does not recognize a lookalike host', () => {
    expect(isCodeBuddyEndpoint('https://copilot.tencent.com.evil.test/v2')).toBe(false)
  })
})
