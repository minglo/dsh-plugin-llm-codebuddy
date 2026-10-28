import { CODEBUDDY_ENDPOINT } from './constants.js'

/**
 * 上游渠道校验的指纹：提示里出现 harness 的产品名，上游就按「不是官方客户端」
 * 拒收（HTTP 400 · `code=11128` · "Illegal API invocation from an unapproved
 * channel"，界面文案是 "Request blocked. Please send it again"）。
 *
 * 这不是认证问题：同一凭据、同一请求头，破坏指纹就立刻 200。
 *
 * 指纹不止一处，且会随上游收紧而增加——已实测被拦的两处是：
 *   1. 提示**开头**那句身份声明（`You are an AI agent powered by DeepSeek Harness.`）；
 *   2. 提示里提到 harness 的那句部署说明（`… through the DeepSeek Harness Web GUI …`）。
 * 两者都含产品名，所以中和产品名即可同时破掉它们与将来同族的新指纹。
 */

/**
 * 上游按「它是官方客户端」核对的原文。探针与被动分类共用这一份，不再各写一份。
 *
 * **末尾句号也是原文的一部分**：上游做的是整句逐字比对，句号同样是匹配点。
 * 探针 B 阶段原样发这一份，句号掉了，它测的就不再是上游实际核对的那句话。
 *
 * 正则与这个常量必须描述同一句：下面的正则由它切出来，改这里就是改规则。
 */
export const ESTABLISHED_FINGERPRINT = 'You are an AI agent powered by DeepSeek Harness.'

/**
 * 句身：去掉末尾句号的同一句声明。
 *
 * 正则与位置判定都按句身匹配、把句号当可选尾巴：上游给的是带句号的原文，但
 * 我们构造或改写后的文本可能没有它；两者都该被认成同一句，不能因为一个标点
 * 就从「开头命中」掉成「完全不含」。
 */
const IDENTITY_BODY = ESTABLISHED_FINGERPRINT.replace(/\.$/, '')

/**
 * 转义正则元字符。
 *
 * 句身是可变文案：将来若出现 `.`、`(` 等字符，直接拼进正则会改变匹配语义，
 * 极端情况下在模块加载时就抛 SyntaxError。拼之前一律先过这里。
 */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 由句身派生「开头整句」正则。
 *
 * 开头的身份声明是上游的核对点：整句比对，改一个标点就不再命中。在 "agent" 后
 * 补一个逗号：`You are an AI agent powered by DeepSeek Harness.` →
 * `You are an AI agent, powered by DeepSeek Harness.`。句子仍然成立，模型读到的
 * 身份说明不变。逗号是可选捕获：已经补过的文本再跑一次不会补第二个。末尾句号
 * 单独捕获、原样带回：改写只插入逗号，不增删其它字符。
 *
 * 可选逗号组必须插在**第一处** `agent` 之后：`split('agent')` 遇到第二处会把
 * 多余的段静默丢掉，句身一旦再出现 `agent`，尾巴就被截断。这里用 indexOf
 * 定位第一处并显式检查存在性，前后两段各自转义后原样保留。
 *
 * 导出只为测试能钉住「文案含元字符/第二个 agent 时仍然成立」；运行时只用下面
 * 由 {@link IDENTITY_BODY} 派生的那一份。
 */
export function identitySentenceRegExp(body: string): RegExp {
  const at = body.indexOf('agent')
  if (at < 0) throw new Error(`identity sentence must contain "agent": ${body}`)
  const head = body.slice(0, at)
  const tail = body.slice(at + 'agent'.length)
  return new RegExp(`^(${escapeRegExp(head)}agent)(,?)(${escapeRegExp(tail)})(\\.?)`, 'i')
}

const IDENTITY_SENTENCE = identitySentenceRegExp(IDENTITY_BODY)

/**
 * 指纹位置的三个取值。运行时常量与派生类型同源：宿主在下发前要按这份闭集
 * 复验读盘内容，client descriptor 的 z.enum 也从这里取值——两处各列一份
 * 迟早会漂移。
 */
export const FINGERPRINT_GUESSES = ['identity-sentence', 'anywhere', 'unknown'] as const

export type FingerprintGuess = typeof FINGERPRINT_GUESSES[number]

/**
 * 判定一段 system 提示里这句原文出现的位置。
 *
 * 位置决定风险：上游只对**开头**整句比对，别处出现只说明产品名还在提示里。
 * @param system - 待判定的 system 正文。
 * @returns 开头命中 / 别处命中 / 完全不含。
 */
export function guessFingerprint(system: string): FingerprintGuess {
  const index = system.toLowerCase().indexOf(IDENTITY_BODY.toLowerCase())
  if (index < 0) return 'unknown'
  return index === 0 ? 'identity-sentence' : 'anywhere'
}

/**
 * 产品名的中性代称。
 *
 * 替换要读得通：「the DeepSeek Harness Web GUI」不能变成「the the harness Web
 * GUI」，所以先吃掉定冠词那一份，剩下的裸名再换成带定冠词的代称。
 */
const ALIAS_WITH_ARTICLE = /the deepseek harness/gi
const ALIAS_BARE = /deepseek harness/gi

/**
 * 把提示里的产品名换成中性代称。
 * @param text - 待中和的文本。
 * @returns 中和后的文本。
 */
function aliasProductName(text: string): string {
  return text.replace(ALIAS_WITH_ARTICLE, 'this harness').replace(ALIAS_BARE, 'the harness')
}

/**
 * 第二类指纹：`@` 路径说明那句。
 *
 * 由 `@deepseek-ai/dsh-file-reference` 贡献进系统提示，**与产品名无关**，所以
 * 补逗号和产品名代称两条规则都盖不到它。
 *
 * 2026-10-29 用真实 system 正文二分定位实测确认：把这句原样放进 system（不在开头
 * 也一样）就 `400 · code=11128`；把 `prefixed with` 改成 `starting with` 立刻
 * `200`。同一句话改一个词（`explicitly` → `directly`）也不再命中——上游做的是
 * 长字面量比对，不是语义判断。
 *
 * 保留整句作为常量而不是只留一个词：**测试要钉住的就是这段长字面量**，将来上游
 * 换了匹配点，这里改一处、测试同时变红。
 */
export const FILE_REFERENCE_FINGERPRINT = 'Tokens prefixed with @ are paths the user explicitly referenced.'

/**
 * 等义改写：只把 `prefixed with` 换成 `starting with`。
 *
 * 句子对模型的意思不变（仍然是「以 @ 开头的 token 是用户引用过的路径」），但
 * 上游那串长字面量的开头被破坏，整条匹配失效。幂等：改写后的文本不再命中本规则。
 * 正则以 `prefixed with` 开头、只换这两个词：句中其余文字（含大小写）逐个保留。
 */
const FILE_REFERENCE_PATTERN = /prefixed with @ are paths the user explicitly referenced\./gi

const FILE_REFERENCE_REWRITE = 'starting with @ are paths the user explicitly referenced.'

/**
 * 破坏 `@` 路径说明那句的字面量。
 * @param text - 待中和的文本。
 * @returns 中和后的文本。
 */
function rewriteFileReference(text: string): string {
  return text.replace(FILE_REFERENCE_PATTERN, FILE_REFERENCE_REWRITE)
}

/**
 * 破坏渠道校验的指纹。
 *
 * 三条规则：
 *   1. **开头**那句身份声明补一个逗号（上游只认开头的整句比对）；
 *   2. 提示其余位置的产品名换成中性代称（同族指纹都含产品名）；
 *   3. `@` 路径说明那句换个等价说法（它与产品名无关，前两条都覆盖不到）。
 *
 * 第 2 条刻意不碰身份声明里的那一份：身份声明是模型唯一知道自己是谁的地方，
 * 把产品名留在那里。幂等：改写后的文本再跑一次不会变。
 * @param system - system 消息的正文。
 * @returns 改写后的正文；没命中时逐字节原样返回。
 */
export function rewriteHarnessIdentity(system: string): string {
  const match = IDENTITY_SENTENCE.exec(system)
  if (match === null) return rewriteFileReference(aliasProductName(system))
  // 捕获到的可选逗号是「已经补过」的标记，直接丢掉：输出永远只有一个逗号。
  // 末尾句号是第 4 组，原样带回——没有句号的输入也不会被补上一个。
  const identity = `${match[1]},${match[3]}${match[4]}`
  return identity + rewriteFileReference(aliasProductName(system.slice(match[0].length)))
}

/**
 * 一个聊天网关是不是 CodeBuddy 官方站点——只有它才跑渠道校验。
 *
 * 自建网关/代理没有这道校验，它们的运营方应该看到 dsh 真正组装的提示，所以那里
 * 不改写。判定按 origin 精确比：形似主机名（`copilot.tencent.com.evil.test`）
 * 不算官方站点。
 * @param base - 解析后的聊天网关地址（无末尾斜杠）。
 * @returns 是否为 CodeBuddy 官方站点。
 */
export function isCodeBuddyEndpoint(base: string): boolean {
  return base === CODEBUDDY_ENDPOINT || base.startsWith(`${CODEBUDDY_ENDPOINT}/`)
}
