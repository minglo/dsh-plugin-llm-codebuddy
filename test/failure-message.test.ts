import { describe, expect, it } from 'vitest'
import { curatedSentence, joinedMessage } from '../src/failure-message.js'

// 上游的失败信封有两半：displayMsg 说出了什么事，displayTips 说该怎么办。
// 只报前半句，界面上就是「Request blocked. Please send it again」这种谜语。

describe('curatedSentence', () => {
  const field = { en: 'English wording', zh: '中文说明', 'zh-hant': '繁體說明' }

  it('picks the reported language', () => {
    expect(curatedSentence(field, 'zh')).toBe('中文说明')
    expect(curatedSentence(field, 'zh-TW')).toBe('繁體說明')
    expect(curatedSentence(field, 'en-US')).toBe('English wording')
  })

  it('falls back to English, then Chinese, when the reported language is absent', () => {
    expect(curatedSentence({ en: 'English wording' }, 'zh')).toBe('English wording')
    expect(curatedSentence({ zh: '中文说明' }, 'en-US')).toBe('中文说明')
  })

  it('returns nothing when the field is absent or empty', () => {
    expect(curatedSentence(undefined, 'zh')).toBeUndefined()
    expect(curatedSentence({ en: '   ' }, 'zh')).toBeUndefined()
  })
})

describe('joinedMessage', () => {
  it('joins a Chinese statement and advice with a full-width colon', () => {
    expect(joinedMessage('测试', '提示')).toBe('测试：提示')
  })

  it('adds nothing after a Chinese statement that already ends a sentence', () => {
    for (const statement of ['测试。', '测试！', '测试？', '测试…', '测试：']) {
      expect(joinedMessage(statement, '提示'), statement).toBe(`${statement}提示`)
    }
  })

  it('joins a Latin statement and advice with a colon and a space', () => {
    expect(joinedMessage('msg', 'tips')).toBe('msg: tips')
  })

  it('adds only a space after a Latin statement that already ends a sentence', () => {
    for (const statement of ['msg.', 'msg!', 'msg?', 'msg…', 'msg:']) {
      expect(joinedMessage(statement, 'tips'), statement).toBe(`${statement} tips`)
    }
  })

  it('follows the statement text, not the client language, for the separator', () => {
    // 中文界面上的英文陈述仍按拉丁处理：分隔符要跟着被显示的文本走。
    expect(joinedMessage('msg', 'tips')).toBe('msg: tips')
  })

  it('does not repeat advice that matches the statement', () => {
    expect(joinedMessage('same', 'same')).toBe('same')
  })

  it('returns the statement alone when there is no advice', () => {
    expect(joinedMessage('msg', undefined)).toBe('msg')
  })
})
