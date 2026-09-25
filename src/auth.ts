import type { Context } from '@deepseek-ai/cordis'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { CredentialKey, CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { PACKAGE_NAME, PLUGIN_NAME } from './constants.js'

export const RECORD_SCOPE = PLUGIN_NAME

export interface CodeBuddyGrant {
  accessToken: string
  expiresAt: number
  refreshToken: string
  refreshExpiresAt: number
  domain: string
  uid?: string
  enterpriseId?: string
}

export function recordKey(): CredentialKey {
  return credentialKey(RECORD_SCOPE, 'codebuddy')
}

export function jsonImage(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(entry => entry === undefined ? null : jsonImage(entry))
  if (typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
    const image: Record<string, unknown> = {}
    for (const [key, member] of Object.entries(value)) {
      if (member !== undefined) image[key] = jsonImage(member)
    }
    return image
  }
  return value
}

function writableStore(ctx: Context): CredentialProvider {
  const credentials = ctx.get('credentials')
  if (credentials === undefined) {
    throw new LlmError(
      `${PACKAGE_NAME}: this composition mounts no credentials service, so there is nowhere to store`
      + ' the credential a sign-in produces; mount one (dsh-credentials-local) to sign in',
      'NO_CREDENTIAL_STORE',
    )
  }
  return credentials
}

export async function readGrant(ctx: Context): Promise<CodeBuddyGrant | undefined> {
  const credentials = ctx.get('credentials')
  if (credentials === undefined) return undefined
  const record = await credentials.readRecord(recordKey())
  return record?.kind === 'grant' ? record.payload as CodeBuddyGrant : undefined
}

export async function writeGrant(ctx: Context, grant: CodeBuddyGrant): Promise<void> {
  await writableStore(ctx).modifyRecord(recordKey(), async () => ({ kind: 'grant', payload: jsonImage(grant) }))
}
