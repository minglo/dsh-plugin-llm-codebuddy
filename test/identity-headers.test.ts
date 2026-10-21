import { describe, expect, it } from 'vitest'
import { codeBuddyIdentityHeaders, withIdentityHeaders } from '../src/constants.js'

/**
 * 出站身份头的契约。
 *
 * 为什么专门钉住：这组头原先在 5 处手搓（codebuddy.ts ×2、usage.ts、session.ts、
 * web-providers.ts）。**缺失时服务端不报错**，只把调用方记成未知客户端——也就是说
 * 「漏带一个头」永远不会让任何测试变红，只会让使用记录悄悄失真。合并成
 * `withIdentityHeaders` 之后，这里把每处的**确切头集合**固定下来，任何一处多带、
 * 少带都会立刻失败。
 */

type Identity = { accessToken: string; domain: string; uid?: string; enterpriseId?: string }

const full: Identity = { accessToken: 'tok', domain: 'tencent', uid: 'u1', enterpriseId: 'e1' }
const keys = (headers: Record<string, string>): string[] => Object.keys(headers).sort()

describe('withIdentityHeaders', () => {
  it('带上四个归属头，并就地返回同一个对象', () => {
    const target: Record<string, string> = { Accept: 'application/json' }
    const returned = withIdentityHeaders(target, full)
    expect(returned).toBe(target) // 就地修改，调用方无需再接一次返回值
    expect(target['Authorization']).toBe('Bearer tok')
    expect(target['X-Domain']).toBe('tencent')
    expect(target['X-User-Id']).toBe('u1')
    expect(target['X-Enterprise-Id']).toBe('e1')
    // 调用方自己的头必须原样保留。
    expect(target['Accept']).toBe('application/json')
  })

  it('uid / enterpriseId 缺失时不发对应的头（有才发，而不是发空串）', () => {
    // 空字符串是有效值，必须照发；只有 undefined 才省略。
    expect(keys(withIdentityHeaders({}, { accessToken: 't', domain: 'd' })))
      .toEqual(['Authorization', 'X-Domain'])
    // 显式空串仍要发出去：服务端区分「没这个头」与「这个头是空的」。
    const blank = withIdentityHeaders({}, { accessToken: 't', domain: 'd', uid: '', enterpriseId: '' })
    expect(blank['X-User-Id']).toBe('')
    expect(blank['X-Enterprise-Id']).toBe('')
  })

  it('withEnterpriseId: false 时只省略企业头，用户头照常', () => {
    // fetchUsage（usage.ts）刻意只带 X-User-Id：这是当前生效的行为，
    // 不能被「看起来更统一」的重构顺手改掉。
    const headers = withIdentityHeaders({}, full, { withEnterpriseId: false })
    expect(headers['X-User-Id']).toBe('u1')
    expect(headers).not.toHaveProperty('X-Enterprise-Id')
  })
})

describe('各调用点的确切头集合', () => {
  // 期望值抄自迁移前手工拼装的结果（5 处逐一核对过）。
  // 加头/删头都必须同时改这里，从而暴露「改了调用点却忘了同步」。
  const IDE = codeBuddyIdentityHeaders()

  it('session.authHeaders：仅客户端身份头 + 归属头，无 Accept/UA', () => {
    const headers = withIdentityHeaders({ ...IDE }, full)
    expect(keys(headers)).toEqual([
      'Authorization', 'X-Agent-Intent', 'X-Domain', 'X-Enterprise-Id', 'X-Env-ID',
      'X-IDE-Name', 'X-IDE-Type', 'X-IDE-Version', 'X-Product', 'X-Product-Version', 'X-User-Id',
    ])
  })

  it('codebuddy.getConfig：身份头 + Accept + User-Agent', () => {
    const headers = withIdentityHeaders({ Accept: 'application/json', 'User-Agent': 'ua', ...IDE }, full)
    expect(keys(headers)).toContain('User-Agent')
    expect(keys(headers)).toContain('Accept')
    expect(keys(headers)).toContain('X-Product-Version')
    expect(headers['Authorization']).toBe('Bearer tok')
  })

  it('codebuddy.refreshAccessToken：带刷新专用头', () => {
    const headers = withIdentityHeaders({ Accept: 'application/json', 'X-Refresh-Token': 'r', 'X-Auth-Refresh-Source': 'workbuddy' }, full)
    expect(keys(headers)).toEqual([
      'Accept', 'Authorization', 'X-Auth-Refresh-Source', 'X-Domain',
      'X-Enterprise-Id', 'X-Refresh-Token', 'X-User-Id',
    ])
  })

  it('usage.fetchUsage：刻意不带 X-Enterprise-Id（回归锁）', () => {
    const headers = withIdentityHeaders({ Accept: 'application/json', ...IDE }, full, { withEnterpriseId: false })
    expect(keys(headers)).not.toContain('X-Enterprise-Id')
    expect(keys(headers)).toContain('X-User-Id')
  })

  it('web-providers.authHeaders：agenttool 的额外头齐全', () => {
    const headers = withIdentityHeaders({
      'User-Agent': 'ua', 'X-Requested-With': 'XMLHttpRequest',
      'Accept': 'application/json', 'Content-Type': 'application/json',
    }, full)
    expect(keys(headers)).toEqual([
      'Accept', 'Authorization', 'Content-Type', 'User-Agent',
      'X-Domain', 'X-Enterprise-Id', 'X-Requested-With', 'X-User-Id',
    ])
  })
})
