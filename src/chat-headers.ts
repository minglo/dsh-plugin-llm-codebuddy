import { createRequire } from 'node:module'
import { attributionHeaders } from '@deepseek-ai/dsh-llm'
import { CODEBUDDY_PRODUCT, CODEBUDDY_REPO_URL } from './constants.js'

/**
 * chat 面出站请求头只有这一处构造。
 *
 * 抽出来的原因：诊断探针必须发**与真实请求同一组头**，否则它量的是另一条代码
 * 路径，结论没有意义。头留在 `stream()` 里内联时，探针只能再抄一份，抄漏抄错都
 * 不会让任何测试变红。
 */

const { version } = createRequire(import.meta.url)('../package.json') as { version: string }
const APP_IDENTITY = { product: CODEBUDDY_PRODUCT, version, url: CODEBUDDY_REPO_URL }

export interface ChatHeaderIdentity {
  model: string
  sessionId?: string
}

/**
 * 组装 chat 面的完整请求头。
 *
 * @param authHeaders - 登录态给出的凭据头（`Authorization` / `X-Domain` 等）。
 * @param identity - 本次请求的模型与会话标识。
 * @returns 可直接交给 fetch 的头对象。
 */
export function buildChatHeaders(
  authHeaders: Record<string, string>,
  identity: ChatHeaderIdentity,
): Record<string, string> {
  // X-Conversation-ID 供服务端做亲和路由与 prefix-cache 复用：盖上宿主每会话 id，
  // 让同一会话的每一轮都落在同一条路由上（opencode 同款插件亦发此头）。
  // X-Model-ID 显式声明本次路由到的模型，便于服务端按模型分账与限流。
  return {
    ...authHeaders,
    'content-type': 'application/json',
    'accept': 'text/event-stream',
    ...attributionHeaders(APP_IDENTITY),
    ...identity.sessionId === undefined ? {} : { 'X-Conversation-ID': identity.sessionId },
    'X-Model-ID': identity.model,
  }
}
