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
}

export interface CodeBuddyConfig {
  models: CodeBuddyModel[]
}
export interface ConfigResponse extends ResponseBase {
  data?: CodeBuddyConfig
}

export function hasDisclosedCapacity(model: CodeBuddyModel): boolean {
  return model.maxAllowedSize !== undefined && model.maxAllowedSize > 0
    && model.maxOutputTokens !== undefined && model.maxOutputTokens > 0
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
  /** 按语言归档的、面向用户的成句文案。 */
  displayMsg?: {
    zh?: string
    en?: string
    'zh-hant'?: string
    [language: string]: string | undefined
  }
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
