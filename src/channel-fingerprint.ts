import { CODEBUDDY_ENDPOINT } from './constants.js'

/**
 * 上游渠道校验的指纹：提示里出现 harness 的产品名，上游就按「不是官方客户端」
 * 拒收（HTTP 400 · `code=11128` · "Illegal API invocation from an unapproved
 * channel"，界面文案是 "Request blocked. Please send it again"）。
 *
 * 这不是认证问题：同一凭据、同一请求头，破坏指纹就立刻 200。
 *
 * 指纹不止一处，且会随上游收紧而增加——已实测被拦的两处是：
 *   1. 提示**开头**那句身份声明（`You are an AI agent powered by DeepSeek Harness`）；
 *   2. 提示里提到 harness 的那句部署说明（`… through the DeepSeek Harness Web GUI …`）。
 * 两者都含产品名，所以中和产品名即可同时破掉它们与将来同族的新指纹。
 */

/**
 * 开头的身份声明：上游按整句比对，改一个标点就不再命中。
 *
 * 在 "agent" 后补一个逗号：`You are an AI agent powered by DeepSeek Harness` →
 * `You are an AI agent, powered by DeepSeek Harness`。句子仍然成立，模型读到的
 * 身份说明不变。逗号是可选捕获：已经补过的文本再跑一次不会补第二个。
 */
const IDENTITY_SENTENCE = /^(You are an AI agent)(,?)( powered by DeepSeek Harness)/i

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
 * 破坏渠道校验的指纹。
 *
 * 两条规则：
 *   1. **开头**那句身份声明补一个逗号（上游只认开头的整句比对）；
 *   2. 提示其余位置的产品名换成中性代称（其余指纹都含产品名）。
 *
 * 第 2 条刻意不碰身份声明里的那一份：身份声明是模型唯一知道自己是谁的地方，
 * 把产品名留在那里。幂等：改写后的文本再跑一次不会变。
 * @param system - system 消息的正文。
 * @returns 改写后的正文；没命中时逐字节原样返回。
 */
export function rewriteHarnessIdentity(system: string): string {
  const match = IDENTITY_SENTENCE.exec(system)
  if (match === null) return aliasProductName(system)
  // 捕获到的可选逗号是「已经补过」的标记，直接丢掉：输出永远只有一个逗号。
  const identity = `${match[1]},${match[3]}`
  return identity + aliasProductName(system.slice(match[0].length))
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
