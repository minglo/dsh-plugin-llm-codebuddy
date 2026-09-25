import type { Context } from '@deepseek-ai/cordis'
import type { AuthorizationSession } from '@deepseek-ai/dsh-authorization'
import { getLoginAccount, pollAuthToken, requestAuthState } from './codebuddy.js'
import { recordKey, writeGrant } from './auth.js'
import type { CodeBuddyGrant } from './auth.js'
import type { CodeBuddySession } from './session.js'

/**
 * 完成一次已开始的登录握手：轮询 token → 取账号 → 构造 grant → 写 grant → 失效目录缓存。
 * 唯一的登录完成路径，AuthorizationFlow 与 Remote.startLogin 两个入口都调用它，
 * 避免「构造 grant + 写盘 + 失效」逻辑在两处复制。
 */
export async function completeLogin(
  ctx: Context,
  state: string,
  session: CodeBuddySession | undefined,
  signal?: AbortSignal,
): Promise<CodeBuddyGrant | undefined> {
  const token = await pollAuthToken(state, signal)
  if (token === undefined) return undefined
  const account = await getLoginAccount(state, token.accessToken, token.domain)
  const grant: CodeBuddyGrant = {
    accessToken: token.accessToken,
    expiresAt: Date.now() + token.expiresIn * 1000,
    refreshToken: token.refreshToken,
    refreshExpiresAt: Date.now() + token.refreshExpiresIn * 1000,
    domain: token.domain,
    ...account.uid === undefined ? {} : { uid: account.uid },
    ...account.enterpriseId === undefined ? {} : { enterpriseId: account.enterpriseId },
  }
  await writeGrant(ctx, grant)
  session?.invalidate()
  // 新账号有自己的模型列表；播报让客户端丢掉上一个（可能是已登出）状态缓存的那份。
  session?.announceCatalogChange()
  return grant
}

export function registerCodeBuddyFlow(ctx: Context, session?: CodeBuddySession): void {
  const authorization = ctx.get('authorization')
  if (authorization === undefined) return // 无 authorization seam（headless）则无登录入口
  authorization.registerFlow({
    key: recordKey(),
    label: 'CodeBuddy',
    methods: [{ id: 'browser', label: 'Sign in with CodeBuddy' }],
    async run(authSession: AuthorizationSession) {
      const handshake = await requestAuthState(authSession.signal)
      authSession.notify({
        message: 'Open this page to sign in to CodeBuddy, then return here.',
        url: handshake.authUrl,
      })
      const grant = await completeLogin(ctx, handshake.state, session, authSession.signal)
      if (grant === undefined) throw new Error('CodeBuddy sign-in did not complete.')
    },
  })
}
