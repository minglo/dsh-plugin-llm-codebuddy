import { describe, expect, it } from 'vitest'
import { decodeJwtPayload, resolveIdentity } from '../src/jwt.js'

function token(payload: unknown): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${header}.${body}.signature`
}

describe('decodeJwtPayload', () => {
  it('decodes the payload of a base64url token', () => {
    const payload = { sub: 'u1', tenant_id: 't1' }
    expect(decodeJwtPayload(token(payload))).toEqual(payload)
  })

  it('returns null for malformed tokens', () => {
    expect(decodeJwtPayload('not-a-jwt')).toBeNull()
    expect(decodeJwtPayload('a.b')).toBeNull()
    expect(decodeJwtPayload(`${'x'.repeat(10)}.%%%.sig`)).toBeNull()
  })
})

describe('resolveIdentity', () => {
  it('resolves userId from uid / sub and tenantId from the iss realm', () => {
    const identity = resolveIdentity({
      iss: 'https://id.example/realms/sso-tenant-42',
      uid: 'u7',
    })
    expect(identity).toEqual({ tenantId: 'tenant-42', enterpriseId: '', userId: 'u7' })
  })

  it('resolves enterpriseId from a group-admin role', () => {
    const identity = resolveIdentity({
      realm_access: { roles: ['user', 'group-admin:ent-9'] },
      user_id: 'u2',
    })
    expect(identity).toEqual({ tenantId: '', enterpriseId: 'ent-9', userId: 'u2' })
  })

  it('resolves alternate payload keys and prefers explicit cfg over the payload', () => {
    const identity = resolveIdentity(
      { tenantId: 'pt', enterpriseId: 'pe', sub: 'ps' },
      { tenantId: 'ct', enterpriseId: 'ce', userId: 'cu' },
    )
    expect(identity).toEqual({ tenantId: 'ct', enterpriseId: 'ce', userId: 'cu' })
  })

  it('returns empty strings for an empty payload or null', () => {
    expect(resolveIdentity(null)).toEqual({ tenantId: '', enterpriseId: '', userId: '' })
    expect(resolveIdentity({})).toEqual({ tenantId: '', enterpriseId: '', userId: '' })
  })
})
