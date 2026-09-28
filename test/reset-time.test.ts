import { describe, expect, it } from 'vitest'
import { RESET_LOOKAHEAD_MS, resetAtFromText } from '../src/reset-time.js'

/** 判定「未来」的基准：2026-09-27 16:00 +08（= 08:00Z）。 */
const NOW = Date.UTC(2026, 8, 27, 8, 0, 0)

describe('resetAtFromText', () => {
  it('reads the reset instant out of the sentence CodeBuddy actually sends', () => {
    // 逐字照抄 2026-09-27 会话日志里那条 429 的 displayMsg.zh（见 README 的「限流」一节）。
    const text = JSON.stringify({
      code: 11115,
      msg: 'usage limit exceeded',
      displayMsg: { zh: '您的使用量已超出频率限制，将在 2026-09-27 17:30:18 UTC+8 重置，您也可以切换其他模型继续使用。' },
    })
    expect(resetAtFromText(text, NOW)).toBe(Date.UTC(2026, 8, 27, 9, 30, 18))
  })

  it('is language independent: the same instant in an English sentence', () => {
    const text = 'usage rate limit exceeded; it will reset at 2026-09-27 17:30:18 UTC+8, or switch models'
    expect(resetAtFromText(text, NOW)).toBe(Date.UTC(2026, 8, 27, 9, 30, 18))
  })

  it('accepts UTC+08:00, a missing seconds field, and UTC-5', () => {
    expect(resetAtFromText('reset 2026-09-27 17:30 UTC+08:00', NOW)).toBe(Date.UTC(2026, 8, 27, 9, 30))
    expect(resetAtFromText('reset 2026-09-27 04:30:00 UTC-5', NOW)).toBe(Date.UTC(2026, 8, 27, 9, 30))
  })

  it('accepts ISO 8601 with an offset or Z', () => {
    expect(resetAtFromText('{"resetAt":"2026-09-27T17:30:18+08:00"}', NOW)).toBe(Date.UTC(2026, 8, 27, 9, 30, 18))
    expect(resetAtFromText('{"resetAt":"2026-09-27T09:30:18Z"}', NOW)).toBe(Date.UTC(2026, 8, 27, 9, 30, 18))
    expect(resetAtFromText('{"resetAt":"2026-09-27T09:30:18.250Z"}', NOW)).toBe(Date.UTC(2026, 8, 27, 9, 30, 18))
  })

  it('takes the earliest future instant when the body carries several dates', () => {
    const text = 'resets at 2026-09-27 19:00:00 UTC+8, billing period ends 2026-09-30 00:00:00 UTC+8'
    expect(resetAtFromText(text, NOW)).toBe(Date.UTC(2026, 8, 27, 11, 0, 0))
  })

  it('ignores instants that already passed', () => {
    expect(resetAtFromText('failed at 2026-09-27 15:59:59 UTC+8', NOW)).toBeUndefined()
  })

  it('ignores instants too far out to be a scheduling instruction', () => {
    const beyond = new Date(NOW + RESET_LOOKAHEAD_MS + 60_000)
    const text = `renewal ${beyond.toISOString()}`
    expect(resetAtFromText(text, NOW)).toBeUndefined()
  })

  it('rejects field values that do not exist rather than normalizing them', () => {
    // Date.UTC 会把 2 月 31 日归一成 3 月 3 日；归一后的时刻不是服务说的那一刻。
    expect(resetAtFromText('reset 2026-02-31 10:00:00 UTC+8', NOW)).toBeUndefined()
    expect(resetAtFromText('reset 2026-09-27 25:00:00 UTC+8', NOW)).toBeUndefined()
  })

  it('gives nothing for text without a timestamp', () => {
    expect(resetAtFromText(undefined, NOW)).toBeUndefined()
    expect(resetAtFromText('', NOW)).toBeUndefined()
    expect(resetAtFromText('CodeBuddy API error (HTTP 429)', NOW)).toBeUndefined()
    expect(resetAtFromText('<html><body>blocked</body></html>', NOW)).toBeUndefined()
  })

  it('does not treat a date without a zone as an instant', () => {
    // 没有偏移就没有「哪一刻」可言；按本地时区猜会把猜测写进重试时刻。
    expect(resetAtFromText('reset 2026-09-27 17:30:18', NOW)).toBeUndefined()
  })
})
