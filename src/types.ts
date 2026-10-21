export interface ResponseBase {
  code: number
  msg: string
  requestId: string
}

export interface AuthToken {
  accessToken: string
  expiresIn: number
  refreshToken: string
  refreshExpiresIn: number
  domain: string
}
export interface AuthTokenResponse extends ResponseBase {
  data?: AuthToken
}

export interface AuthState {
  state: string
  authUrl: string
}
export interface AuthStateResponse extends ResponseBase {
  data?: AuthState
}

export interface Account {
  uid: string
  nickname: string
  uin?: string
  enterpriseId?: string
  enterpriseName?: string
  enterpriseUserName?: string
  departmentFullName?: string
}
export interface AccountResponse extends ResponseBase {
  data?: Account
}

export interface CodeBuddyReasoning {
  supportedEfforts?: string[]
  defaultEffort?: string
  effort?: string
  canDisableThinking?: boolean
  summary?: string
}

export interface CodeBuddyModel {
  id: string
  name: string
  credits?: string
  maxAllowedSize?: number
  maxOutputTokens?: number
  supportsImages?: boolean
  supportsToolCall?: boolean
  supportsReasoning?: boolean
  /** 该模型的思考**无法关闭**。 */
  onlyReasoning?: boolean
  reasoning?: CodeBuddyReasoning
  /**
   * 模型描述：服务端按语言各下发一条，而不是让宿主拼一个本地化串。
   *
   * 宿主不知道浏览器的语言（`locale.preference` 只在用户手选后才有值），
   * 所以两份都留在 wire 上，由客户端按当前语言挑选。
   */
  descriptionZh?: string
  descriptionEn?: string
}

export interface CodeBuddyConfig {
  models: CodeBuddyModel[]
  /**
   * 促销与分层跟模型列表在**同一个** `/v3/config` 响应里下发。
   *
   * 服务端没有要播报的内容时会省略这两个字段，所以可选；读取方按空数组处理，
   * 而不是把「没有促销」当成「响应不完整」。
   */
  modelPromotions?: CodeBuddyPromotion[]
  modelTiers?: CodeBuddyTier[]
}

/**
 * 促销生效的时间窗（wire 层：服务端原始 JSON 的形状）。
 *
 * 服务端把「全天」写成 daily 00:00–23:59、把昼夜互补写成两条记录共用同一徽标
 * 文案，所以判定层必须按分钟闭区间解释窗口（23:59 覆盖到当天最后一秒），
 * 否则每天会漏掉一分钟的徽标。
 */
export interface PromotionWindow {
  /** 按该 IANA 时区的墙钟分钟解释 daily，而不是宿主机本地时间。 */
  timezone?: string
  /** 绝对有效期起点（含该瞬间），缺省表示不限。 */
  validFrom?: string
  /** 绝对有效期终点（不含该瞬间），缺省表示不限。 */
  validUntil?: string
  /** 每日窗口；缺省表示只受有效期约束，空数组表示没有任何窗口覆盖。 */
  daily?: readonly { start: string; end: string }[]
}

/**
 * 促销徽标（wire 层）。
 *
 * 服务端多数记录省略 display，缺省必须按 activeOnly 解释：否则昼夜互补的两条
 * 记录会全天同时渲染出两个同文案徽标，而不是各管一半天。
 */
export interface PromotionBadge {
  color?: string
  label?: string
  display?: 'activeOnly' | 'always'
}

/**
 * 促销价（wire 层）。
 *
 * 目录价 credits 是 x 在前的 `x0.29`，这里是 x 在后的 `0.50x` / `0x`，
 * 两种拼写都由 src/rate.ts 的 normalizeCredits 归一，判定层不再重复实现。
 */
export interface PromotionDiscount {
  discountedCredits?: string
  factor?: number
  displayMode?: 'replace' | 'strikethrough'
}

/**
 * 一条服务端促销（wire 层）。
 *
 * 除 id 外字段全部可选——服务端可能不下发，缺字段时判定层按「无约束」处理，
 * 而不是把整条促销丢掉。
 */
export interface CodeBuddyPromotion {
  id: string
  enabled?: boolean
  priority?: number
  modelIds?: readonly string[]
  badge?: PromotionBadge
  hover?: { textZh?: string; textEn?: string }
  discount?: PromotionDiscount
  schedule?: PromotionWindow
}

/**
 * 一条服务端分层（wire 层）：按 modelIds 挂到模型上，不带时间表，
 * 所以判定层只做匹配、不做生效判断。
 */
export interface CodeBuddyTier {
  id: string
  modelIds?: readonly string[]
  badge?: { label?: string; color?: string }
  hover?: { textZh?: string; textEn?: string }
  tier?: string
  requiredUserType?: string
}
export interface ConfigResponse extends ResponseBase {
  data?: CodeBuddyConfig
}

export function hasDisclosedCapacity(model: CodeBuddyModel): boolean {
  return model.maxAllowedSize !== undefined && model.maxAllowedSize > 0
    && model.maxOutputTokens !== undefined && model.maxOutputTokens > 0
}

/** 按语言归档的一句成句文案。 */
export interface WireWording {
  zh?: string
  en?: string
  'zh-hant'?: string
  [language: string]: string | undefined
}

/**
 * 非 2xx chat 回复携带的信封：服务自己的控制面形状，或自定义 `baseURL` 可能说的
 * OpenAI `{error: {...}}`。措辞散落在 `msg`、`extError`、`displayMsg` 三处，
 * 因为某个条件可能只从其中之一认得出来。
 */
export interface WireError {
  /** 服务错误码，如 11115。 */
  code?: number
  /** 服务自己对失败的描述。 */
  msg?: string
  /** 服务包装的上游 provider 故障。 */
  extError?: {
    code?: string
    type?: string
    message?: string
    param?: string
  }
  /** 按语言归档的、面向用户的成句文案：出了什么事。 */
  displayMsg?: WireWording
  /**
   * 按语言归档的建议：该拿这个失败怎么办。
   *
   * 与 `displayMsg` 分开，因为它是**补救措辞**（「充值额度」「用官方客户端重发」），
   * 不是失败状态本身——它只跟着陈述句上报，不参与失败分类。
   */
  displayTips?: WireWording
  /** OpenAI 兼容信封。 */
  error?: { message?: string; type?: string; code?: string }
}

export interface WireUsage {
  prompt_tokens: number
  completion_tokens: number
  total_tokens?: number
  prompt_cache_hit_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number }
  completion_tokens_details?: { reasoning_tokens?: number }
}

/**
 * 一段流式 tool-call 分片。`id` 与 `name` 是**身份**而非累加：仅在首帧发送一次，
 * 续帧会以 `''` 或 `null` 重复表示「无更新」。线上类型只声明远端编码器可能发出的
 * 东西，所以三者都保持可空，由消费方决定空值意味着什么（见 translate.acceptIdentity）。
 */
export interface WireToolCall {
  index: number
  id?: string | null
  function?: { name?: string | null; arguments?: string | null }
}

export interface WireChunk {
  choices?: {
    delta?: {
      content?: string | null
      reasoning_content?: string | null
      reasoning?: string | null
      tool_calls?: WireToolCall[] | null
    } | null
    finish_reason?: string | null
  }[] | null
  usage?: WireUsage | null
}

export interface WireMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  reasoning_content?: string
  tool_call_id?: string
  tool_calls?: {
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }[]
}

export interface WireTool {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

export interface WireRequest {
  model: string
  messages: WireMessage[]
  stream: true
  stream_options?: { include_usage: boolean }
  tools?: WireTool[]
  temperature?: number
  max_tokens?: number
  stop?: string[]
  reasoning_effort?: string
}
