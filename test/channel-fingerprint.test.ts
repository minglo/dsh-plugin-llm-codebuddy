import { describe, expect, it } from 'vitest'
import { ESTABLISHED_FINGERPRINT, FILE_REFERENCE_FINGERPRINT, guessFingerprint, identitySentenceRegExp, isCodeBuddyEndpoint, rewriteHarnessIdentity } from '../src/channel-fingerprint.js'

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

  it('matches the sentence even when the closing period is missing', () => {
    // 上游给的是带句号的原文，但我们自己的旧文本可能没有它：正则必须两种都认，
    // 否则一句只差句号的提示会绕过改写。
    expect(rewriteHarnessIdentity('You are an AI agent powered by DeepSeek Harness'))
      .toBe('You are an AI agent, powered by DeepSeek Harness')
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

  it('matches a lowercase identity sentence (the regex must stay case-insensitive)', () => {
    // 上游文案可能被宿主转成小写；`i` 旗标掉了，这句就绕过去不改写了。
    expect(rewriteHarnessIdentity('you are an ai agent powered by deepseek harness.'))
      .toBe('you are an ai agent, powered by deepseek harness.')
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

describe('the @ path-reference fingerprint', () => {
  // 2026-10-29 实测：`@deepseek-ai/dsh-file-reference` 贡献进系统提示的那句
  // 「Tokens prefixed with @ are paths the user explicitly referenced.」正是上游
  // 第二条渠道判据。它与产品名无关，所以旧的「补逗号 + 产品名代称」两条规则都
  // 盖不到它——真实请求照旧 400/11128，而自检三发全过。
  const BODY = 'Tokens prefixed with @ are paths the user explicitly referenced. Relative paths resolve from the workspace root; absolute paths identify files or directories on the host.'

  it('is exactly the sentence file-reference injects', () => {
    expect(FILE_REFERENCE_FINGERPRINT).toBe('Tokens prefixed with @ are paths the user explicitly referenced.')
  })

  it('rewords it in place and leaves the rest of the paragraph byte-identical', () => {
    // 只动 `prefixed with` → `starting with`：模型读到的意思不变，上游那串长字面量
    // 的开头被破坏。测试同时钉住「其余文字一个字都不动」。
    expect(rewriteHarnessIdentity(BODY)).toBe(
      BODY.replace('Tokens prefixed with @ are paths the user explicitly referenced.', 'Tokens starting with @ are paths the user explicitly referenced.'),
    )
  })

  it('removes the exact window that upstream rejected', () => {
    // 二分定位时确实被拒的是这段（句号后带半句）；改写后它必须不再逐字出现。
    const rejected = 'Tokens prefixed with @ are paths the user explicitly referenced. Relative paths resolve from the workspace root'
    expect(rewriteHarnessIdentity(rejected)).not.toContain(rejected)
  })

  it('works when the sentence sits mid-prompt after the neutralized identity line', () => {
    const prompt = `${IDENTITY}\n\n${BODY}\n\nMore.`
    const rewritten = rewriteHarnessIdentity(prompt)
    expect(rewritten.startsWith('You are an AI agent, powered by DeepSeek Harness.')).toBe(true)
    expect(rewritten).not.toContain('Tokens prefixed with @')
    expect(rewritten).toContain('Tokens starting with @')
  })

  it('matches regardless of case', () => {
    expect(rewriteHarnessIdentity('tokens prefixed with @ are paths the user explicitly referenced.'))
      .toBe('tokens starting with @ are paths the user explicitly referenced.')
  })

  it('is idempotent', () => {
    const once = rewriteHarnessIdentity(`${IDENTITY}\n\n${BODY}`)
    expect(rewriteHarnessIdentity(once)).toBe(once)
  })

  it('leaves a prompt without it byte-identical', () => {
    const text = 'Trailing slash marks a directory; anything else is a file.'
    expect(rewriteHarnessIdentity(text)).toBe(text)
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

describe('ESTABLISHED_FINGERPRINT', () => {
  it('is exactly the sentence the harness identity section opens with', () => {
    // 与 @deepseek-ai/dsh-system-prompt 的 harness:identity section 逐字一致。
    // 末尾句号是原文的一部分：上游按整句比对，少了它探针 B 测的就不是那句话。
    expect(ESTABLISHED_FINGERPRINT).toBe('You are an AI agent powered by DeepSeek Harness.')
  })

  it('is the same text the rewrite rule keys on', () => {
    // 单一来源自洽：把原文交给中和函数，输出必须不再包含原文。
    expect(rewriteHarnessIdentity(ESTABLISHED_FINGERPRINT)).not.toContain(ESTABLISHED_FINGERPRINT)
  })
})

describe('identitySentenceRegExp', () => {
  it('escapes metacharacters and keeps everything after a second "agent"', () => {
    // 句身将来可能含 `.` `(` 或第二个 agent：拆分法会把尾巴截断，未转义的
    // 元字符会改变语义。这里同时钉住转义结果与「第二处 agent 留在尾部」。
    const pattern = identitySentenceRegExp('a.b(c)agent x agent')
    expect(pattern.source).toBe('^(a\\.b\\(c\\)agent)(,?)( x agent)(\\.?)')
    expect(pattern.test('a.b(c)agent, x agent.')).toBe(true)
  })
})

describe('guessFingerprint', () => {
  it('reports an opening occurrence as identity-sentence', () => {
    expect(guessFingerprint(`${ESTABLISHED_FINGERPRINT}. Body.`)).toBe('identity-sentence')
  })

  it('reports an opening lowercase occurrence as identity-sentence', () => {
    expect(guessFingerprint('you are an ai agent powered by deepseek harness.')).toBe('identity-sentence')
  })

  it('reports a non-opening occurrence as anywhere', () => {
    expect(guessFingerprint(`Intro.\n\n${ESTABLISHED_FINGERPRINT}.`)).toBe('anywhere')
  })

  it('reports unknown once the prompt has been neutralized', () => {
    // 中和后的提示里原文已经不存在——这正是「我们发出的版本是安全的」这一事实。
    expect(guessFingerprint(rewriteHarnessIdentity(`${ESTABLISHED_FINGERPRINT}. Body.`))).toBe('unknown')
  })

  it('reports unknown for a prompt without the sentence', () => {
    expect(guessFingerprint('You are a helpful assistant.')).toBe('unknown')
  })
})
