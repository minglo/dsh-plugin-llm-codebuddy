// CodeBuddy 网关 /agenttool 端点的 wire 类型（纯类型，无运行时代码）。
// 形状来自实测（2026-09，见开发记录）：search 返回 {code,msg,results[]}，
// webfetch 返回 {url,title,content,content_type,content_length,truncated,status_code,context}。
// 字段一律按「网关可能不发」建模——缺失时由 provider 侧兜底，不在这里假设。

/** 网关统一的响应信封：code === 0 表示成功。 */
export interface AgentToolEnvelope {
  code?: number
  msg?: string
}

/** /agenttool/v1/search 的一条结果。 */
export interface AgentToolSearchResult {
  title?: string | null
  url?: string | null
  snippet?: string | null
}

/** /agenttool/v1/search 响应。 */
export interface AgentToolSearchResponse extends AgentToolEnvelope {
  results?: AgentToolSearchResult[] | null
  total_results?: number
  provider?: string
}

/**
 * /agenttool/v1/webfetch 响应。
 * `content` 已被网关解码/转换为文本（实测：HTML 页面返回的是转换后的正文，
 * 不是原始标记），因此 provider 一律按 `text` 分类，不再交给下游二次转换。
 */
export interface AgentToolFetchResponse extends AgentToolEnvelope {
  url?: string | null
  title?: string | null
  content?: string | null
  content_type?: string | null
  content_length?: number | null
  /** 网关侧的截断标记；透传（我们不设本地上限）。 */
  truncated?: boolean | null
  /** 目标页的真实 HTTP 状态；网关取不到时为 null。 */
  status_code?: number | null
}
