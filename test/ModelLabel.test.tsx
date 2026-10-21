import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { EMPTY_MODEL_SNAPSHOT } from '../src/client/model-feed.js'
import type { ModelFeed, ModelFeedSnapshot } from '../src/client/model-feed.js'

// ui-primitives 用桩（照 test/ComposerUsage.test.tsx 的做法）：只关心「渲染了
// 什么」，不复制官方 Tag 的色板与 Tooltip 的定位/portal。Tooltip 桩把 label
// 也渲染进 DOM，测试才能读到气泡里的内容。
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Tag: ({ children, tone }: { children?: unknown; tone?: string }) =>
    createElement('span', { 'data-tone': tone }, children),
  Tooltip: ({ label, children }: { label?: unknown; children?: unknown }) =>
    createElement('span', { 'data-tip': 'yes' }, children, label),
}))

import { ModelLabel } from '../src/client/ModelLabel.jsx'
import type { LocaleFace } from '../src/client/ModelLabel.jsx'

/** Task 8 注册时声明的键（见 task-8-brief）：组件用的自有文案必须逐字对上。 */
const zhT = (key: string): string => ({
  rateLabel: '倍率',
  windowLabel: '时间窗',
  freeLabel: '免费',
  baseRateLabel: '基础倍率',
  currentRateLabel: '当前倍率',
}[key] ?? key)

function feedOf(snapshot: ModelFeedSnapshot): ModelFeed {
  return {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
  }
}

function localeOf(active = 'zh', revision = 0): LocaleFace {
  return {
    subscribe: () => () => {},
    getSnapshot: () => ({ active, revision }),
  }
}

function renderLabel(args: {
  providerId?: string
  providerName?: string
  modelId?: string
  modelName?: string
  modelDescription?: string
  snapshot?: ModelFeedSnapshot
  active?: string
} = {}) {
  const {
    providerId = 'codebuddy',
    providerName = 'CodeBuddy',
    modelId = 'hy3',
    modelName = 'Hy3',
    modelDescription = undefined,
    snapshot = EMPTY_MODEL_SNAPSHOT,
    active = 'zh',
  } = args
  return render(createElement(ModelLabel as never, {
    provider: { id: providerId, name: providerName },
    model: { id: modelId, name: modelName, description: modelDescription },
    placement: 'trigger',
    selected: false,
    sessionId: 's-1',
    feed: feedOf(snapshot) as never,
    locale: localeOf(active) as never,
    t: zhT as never,
  } as never))
}

const hy3Snapshot: ModelFeedSnapshot = {
  loggedIn: true,
  models: [{
    id: 'hy3',
    name: 'Hy3',
    rate: { base: 'x0.00', current: 'x0', strikethrough: true, free: true },
    promotion: { label: '限时免费', color: '#FF0000' },
  }],
}

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('ModelLabel（作曲家模型标签槽）', () => {
  it('非 CodeBuddy 提供方只渲染模型名', () => {
    // 富化是 CodeBuddy 的；别家 provider 的倍率/徽章一旦渲染就是谎言。
    const { container } = renderLabel({
      providerId: 'deepseek-official',
      providerName: 'DeepSeek',
      modelId: 'chat',
      modelName: 'DeepSeek Chat',
      modelDescription: 'x0.29',
    })
    expect(container.textContent).toBe('DeepSeek Chat')
    expect(container.querySelector('.cb-model-rate')).toBeNull()
    expect(container.querySelector('[data-tip]')).toBeNull()
  })

  it('CodeBuddy 模型渲染 名字 + 促销徽章 + 倍率', () => {
    const { container } = renderLabel({ snapshot: hy3Snapshot })
    // 内联行只放名字 + 徽章 + 一个倍率：用 .cb-model-label 界定，避免
    // 把气泡里的重复文案也数进来。
    const inline = container.querySelector('.cb-model-label')!
    expect(inline.textContent).toContain('Hy3')
    expect(inline.textContent).toContain('限时免费')
    // 内联倍率是实际扣费价（current），不是原价 base。
    expect(inline.textContent).toContain('x0')
    // free 模型要打标，样式才能把它当免费处理。
    expect(inline.querySelector('[data-free]')).not.toBeNull()
  })

  it('tier 徽章渲染在促销徽章之后、倍率之前', () => {
    const { container } = renderLabel({
      snapshot: {
        loggedIn: true,
        models: [{
          id: 'hy3',
          name: 'Hy3',
          rate: { base: 'x1.00', current: 'x0.50', strikethrough: true, free: false },
          promotion: { label: '限时五折', color: '#FF0000' },
          tier: { label: '旗舰' },
        }],
      },
    })
    const html = container.innerHTML
    expect(html.indexOf('限时五折')).toBeGreaterThan(-1)
    expect(html.indexOf('限时五折')).toBeLessThan(html.indexOf('旗舰'))
    expect(html.indexOf('旗舰')).toBeLessThan(html.indexOf('x0.50'))
  })

  it('复刻官方的 1017 角标（DeepSeek 官方 Flash）', () => {
    // 我们的注册以 priority -1 抢占了这个 single 槽，官方插件不再渲染；
    // 不复刻的话每个用户都会丢一个已发布的角标。
    const { container } = renderLabel({
      providerId: 'deepseek-official',
      providerName: 'DeepSeek',
      modelId: 'deepseek-flash',
      modelName: 'DeepSeek-V4.1-Flash',
    })
    expect(container.querySelector('.cb-model-label')!.textContent).toContain('1017')
  })

  it('没有 1017 条件的模型不出现 1017 角标', () => {
    const { container } = renderLabel({
      providerId: 'deepseek-official',
      providerName: 'DeepSeek',
      modelId: 'deepseek-flash',
      modelName: 'DeepSeek Chat',
    })
    expect(container.textContent).toBe('DeepSeek Chat')
    expect(screen.queryByText('1017')).toBeNull()
  })

  it('远端没有该模型时退回目录描述里的倍率', () => {
    const { container } = renderLabel({ modelDescription: 'x0.29' })
    expect(container.querySelector('.cb-model-label')!.textContent).toContain('x0.29')
  })

  it('别家 provider 的目录描述绝不退回成倍率', () => {
    // 另一家的 description 是别的东西（简介文案），退回就是张冠李戴。
    const { container } = renderLabel({
      providerId: 'deepseek-official',
      providerName: 'DeepSeek',
      modelId: 'chat',
      modelName: 'DeepSeek Chat',
      modelDescription: 'x0.29',
    })
    expect(container.textContent).toBe('DeepSeek Chat')
  })

  it('远端失败时不渲染任何徽章，也不抛错', () => {
    const { container } = renderLabel()
    expect(container.textContent).toBe('Hy3')
    expect(container.querySelector('[data-tip]')).toBeNull()
  })

  it('replace 模式不划原价：base 与 current 不同但 strikethrough 为假时不划线', () => {
    // 划线与否是服务端的意图（promotion displayMode），不是「两数不同」就能推的：
    // replace 促销的现价直接替代原价，划线会把它画成打折。
    const { container } = renderLabel({
      snapshot: {
        loggedIn: true,
        models: [{
          id: 'hy3',
          name: 'Hy3',
          rate: { base: 'x1.00', current: 'x0.50', strikethrough: false, free: false },
        }],
      },
    })
    const tip = container.querySelector('.cb-model-tip')!
    // 两个数都在（只给现价会让人以为一直是这个价），但谁也不划线。
    expect(tip.textContent).toContain('x1.00')
    expect(tip.textContent).toContain('x0.50')
    expect(tip.querySelector('s')).toBeNull()
  })

  it('条目 rate 没有数字时气泡里整行省略倍率（不打印 undefined）', () => {
    // 目录里没 credits 的模型（如 auto）照样有富化条目，它的 rate 两个字段都缺。
    // 内联行早已被 guard 住，气泡行原来没 guard，会打出「倍率: undefined」。
    const { container } = renderLabel({
      snapshot: {
        loggedIn: true,
        models: [{
          id: 'hy3',
          name: 'Hy3',
          rate: { strikethrough: false, free: false },
          promotion: { label: '限时免费', color: '#FF0000' },
        }],
      },
    })
    const tip = container.querySelector('.cb-model-tip')!
    expect(tip.textContent).not.toContain('undefined')
    expect(tip.textContent).toContain('限时免费')
    // 倍率行整行省略：气泡里只剩名字 + id 行 + 提供方行 + 促销行。
    expect(tip.querySelectorAll('.cb-model-tip-row')).toHaveLength(3)
  })

  it('条目无数字价但目录描述可归一时气泡展示降级倍率', () => {
    // 内联行展示了降级倍率，气泡不能反过来整行省略——两边是同一份 rateText。
    const { container } = renderLabel({
      modelDescription: 'x0.29',
      snapshot: {
        loggedIn: true,
        models: [{
          id: 'hy3',
          name: 'Hy3',
          rate: { strikethrough: false, free: false },
        }],
      },
    })
    const tip = container.querySelector('.cb-model-tip')!
    expect(tip.textContent).toContain('x0.29')
    expect(tip.textContent).not.toContain('undefined')
  })

  it('tips 里给出完整信息', () => {
    const { container } = renderLabel({
      snapshot: {
        loggedIn: true,
        models: [{
          id: 'hy3',
          name: 'Hy3',
          rate: { base: 'x1.00', current: 'x0.50', strikethrough: true, free: false },
          promotion: {
            label: '限时五折',
            color: '#FF0000',
            text: { zh: '夜场五折说明', en: 'Half off at night' },
            window: '23:00–08:00',
          },
          tier: { label: '旗舰', text: { zh: '旗舰分层说明', en: 'Flagship tier' } },
          description: { zh: '中文模型描述', en: 'English description' },
        }],
      },
    })
    // Tooltip 桩把 label 也渲染进 DOM：气泡内容（.cb-model-tip）可直接断言。
    // 「包含」语义——行标签与值拼在一串文本里，不断言整串相等。
    const tip = container.querySelector('.cb-model-tip')!
    expect(tip.textContent).toContain('Hy3')
    expect(tip.textContent).toContain('x1.00')
    expect(tip.textContent).toContain('x0.50')
    // 原价划线、现价并列：strikethrough 的落点。
    expect(tip.querySelector('s')?.textContent).toBe('x1.00')
    expect(tip.textContent).toContain('夜场五折说明')
    expect(tip.textContent).toContain('23:00–08:00')
    expect(tip.textContent).toContain('旗舰分层说明')
    expect(tip.textContent).toContain('中文模型描述')
  })

  it('气泡顶部给出模型 id（弱化）与提供方名', () => {
    // 规格 §3.6 的前两行：同名模型可能分属多个提供方，id 是调试时的唯一把柄。
    const { container } = renderLabel({
      providerName: 'CodeBuddy',
      modelId: 'hy3-pro',
      modelName: 'Hy3 Pro',
      snapshot: {
        loggedIn: true,
        models: [{
          id: 'hy3-pro',
          name: 'Hy3 Pro',
          rate: { base: 'x1.00', current: 'x0.50', strikethrough: true, free: false },
          promotion: { label: '限时五折', color: '#FF0000' },
        }],
      },
    })
    const tip = container.querySelector('.cb-model-tip')!
    expect(tip.textContent).toContain('hy3-pro')
    expect(tip.textContent).toContain('CodeBuddy')
    // id 行弱化展示：名字才是主视觉。
    expect(tip.querySelector('.cb-model-tip-id')?.textContent).toBe('hy3-pro')
    // 两行都在名字之后、徽章与倍率之前。
    const html = tip.innerHTML
    expect(html.indexOf('hy3-pro')).toBeGreaterThan(html.indexOf('Hy3 Pro'))
    expect(html.indexOf('CodeBuddy')).toBeGreaterThan(html.indexOf('Hy3 Pro'))
    expect(html.indexOf('CodeBuddy')).toBeLessThan(html.indexOf('限时五折'))
  })

  it('提供方名缺失时回落到 provider id', () => {
    const { container } = renderLabel({
      providerName: null as unknown as string,
      snapshot: hy3Snapshot,
    })
    expect(container.querySelector('.cb-model-tip')!.textContent).toContain('codebuddy')
  })

  it('气泡里的服务端文案跟随当前语言', () => {
    const snapshot: ModelFeedSnapshot = {
      loggedIn: true,
      models: [{
        id: 'hy3',
        name: 'Hy3',
        rate: { base: 'x1.00', current: 'x0.50', strikethrough: false, free: false },
        promotion: {
          label: '限时五折',
          color: '#FF0000',
          text: { zh: '夜场五折说明', en: 'Half off at night' },
        },
      }],
    }
    renderLabel({ snapshot, active: 'en' })
    expect(screen.getByText('Half off at night')).toBeTruthy()
    expect(screen.queryByText('夜场五折说明')).toBeNull()
  })
})
