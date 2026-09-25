import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import { jsonImage, readGrant, recordKey, writeGrant, RECORD_SCOPE } from '../src/auth.js'

describe('auth', () => {
  it('recordKey is plugin-llm-codebuddy/codebuddy', () => {
    expect(recordKey()).toBe('plugin-llm-codebuddy/codebuddy') // 钉字面量（实现即同源组成，避免同义反复）
    expect(RECORD_SCOPE).toBe('plugin-llm-codebuddy')
  })

  it('jsonImage strips explicit undefined', () => {
    expect(jsonImage({ a: undefined, b: [1, undefined, 2], c: 'x' })).toEqual({ b: [1, null, 2], c: 'x' })
  })

  it('readGrant returns undefined without a credentials seam', async () => {
    const ctx = new Context()
    await expect(readGrant(ctx)).resolves.toBeUndefined()
  })

  it('writeGrant throws NO_CREDENTIAL_STORE without a seam', async () => {
    const ctx = new Context()
    await expect(writeGrant(ctx, { accessToken: 'a', expiresAt: 1, refreshToken: 'r', refreshExpiresAt: 2, domain: 'd' }))
      .rejects.toMatchObject({ code: 'NO_CREDENTIAL_STORE' })
  })
})
