import type { WireWording } from './types.js'

/**
 * 第一个携带非空文本的条目。
 *
 * 这里的类型检测是**承重**的，不是防御性冗余：按上报的语言 id 去查 `displayMsg`
 * 可能命中 `Object.prototype` 的继承成员（上报 `constructor` 就会取到那个函数），
 * 此时对它调 `.trim` 会抛错——从而丢掉整个信封、把错误码降级。
 * @param values - 候选条目。
 * @returns 第一个非空文本，或 undefined。
 */
export function firstText(values: readonly unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return undefined
}

/**
 * 一个语言 id 可能命名的文案键，最优者在前。
 *
 * 服务把繁中文案只放在 `zh-hant` 下，而语言包按地区选它（`zh-TW`/`zh-HK`/`zh-MO`），
 * 所以这些 id 必须能到达该脚本键。按 `zh` 去读会让繁体读者收到简体。
 * @param language - 界面语言（BCP 47 标签），缺省按英文。
 * @returns 可能命中的键，最优者在前。
 */
export function wordingKeys(language: string | undefined): readonly string[] {
  const key = language?.trim().toLowerCase()
  if (key === undefined || key.length === 0) return []
  if (key === 'zh-tw' || key === 'zh-hk' || key === 'zh-mo') return [key, 'zh-hant']
  return [key]
}

/**
 * 一个文案块在上报语言下的那句话：先按语言 id 取，再退到英文，然后中文。
 * @param field - `displayMsg`/`displayTips` 块，报文没带时为 undefined。
 * @param language - 界面语言。
 * @returns 成句文案，或 undefined。
 */
export function curatedSentence(field: WireWording | undefined, language: string | undefined): string | undefined {
  if (field === undefined) return undefined
  return firstText([
    ...wordingKeys(language).map(key => field[key]),
    field.en,
    field.zh,
  ])
}

/** 正文里有没有汉字——分隔符按它决定。 */
const HAS_CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u

/** 已经收尾的中文句子或从句，后面不再加分隔符。 */
const CJK_END = /[。！？…：；，]$/u

/** 已经收尾的拉丁句子或从句，后面只加一个空格。 */
const LATIN_END = /[.!?…:;,]$/u

/**
 * 把「出了什么事」和「该怎么办」连成一句可上报的话。
 *
 * 分隔符跟着**正文**走，不跟界面语言走：中文正文用全角冒号（中文不需要空格），
 * 拉丁正文用 `": "`（拉丁常需要那个空格才读得顺）。正文自带句末标点时就不再加
 * 标点，免得一句话两个句号。
 *
 * 只成一条字符串，不拆成两个字段：宿主会把 provider 失败压成一组固定事实，
 * 单独的 `tips` 会被丢掉。
 * @param statement - 出了什么事。
 * @param tips - 该怎么办，报文没带时为 undefined。
 * @returns 一句可上报的话。
 */
export function joinedMessage(statement: string, tips: string | undefined): string {
  // 重复一遍读起来像口吃，不像强调。
  if (tips === undefined || tips === statement) return statement
  if (HAS_CJK.test(statement)) {
    return CJK_END.test(statement) ? `${statement}${tips}` : `${statement}：${tips}`
  }
  return LATIN_END.test(statement) ? `${statement} ${tips}` : `${statement}: ${tips}`
}
