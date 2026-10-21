import { describe, it, expect, vi } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { createElement, Fragment } from 'react'

// 颜色断言只看 style，故 Tooltip 透传 children 即可。
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Tooltip: ({ children }: { children?: unknown }) => createElement(Fragment, null, children),
}))

import { UsageIndicator } from '../src/client/UsageIndicator.jsx'
import { MORANDI, SEGMENT_COLORS, EXPIRY_COLORS, monthColor, tint } from '../src/client/palette.js'

// ── 色彩度量：sRGB → HSL（判莫兰迪）与 CIE Lab（判可分辨性） ──────────────

function toRgb(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16)
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff]
}

/** 莫兰迪判据：中明度、低饱和。 */
function hsl(hex: string): { h: number; s: number; l: number } {
  const [r, g, b] = toRgb(hex).map(v => v / 255) as [number, number, number]
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  const s = max === min ? 0 : (max - min) / (1 - Math.abs(2 * l - 1))
  let h = 0
  if (max !== min) {
    if (max === r) h = ((g - b) / (max - min)) % 6
    else if (max === g) h = (b - r) / (max - min) + 2
    else h = (r - g) / (max - min) + 4
    h = ((h * 60) + 360) % 360
  }
  return { h, s, l }
}

function toLab(hex: string): [number, number, number] {
  const [r, g, b] = toRgb(hex).map(v => {
    const c = v / 255
    return c > 0.04045 ? ((c + 0.055) / 1.055) ** 2.4 : c / 12.92
  }) as [number, number, number]
  const x = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047
  const y = r * 0.2126 + g * 0.7152 + b * 0.0722
  const z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883
  const f = (v: number): number => (v > 0.008856 ? Math.cbrt(v) : 7.787 * v + 16 / 116)
  const [fx, fy, fz] = [f(x), f(y), f(z)] as [number, number, number]
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)]
}

/** CIE76 色差：差值 <10 时普通人已难分辨。 */
function deltaE(a: string, b: string): number {
  const [a1, a2, a3] = toLab(a)
  const [b1, b2, b3] = toLab(b)
  return Math.hypot(a1 - b1, a2 - b2, a3 - b3)
}

/**
 * 同屏出现的**数据色**：面板里 5 条进度条同屏，侧栏里 3 段同屏。
 * 状态徽标是互斥的单点、且旁边始终有文字，故不在此集合内（另有阈值更宽的断言）。
 */
const BAR_COLORS = {
  '已用积分': MORANDI.used,
  '本月到期(低)': MORANDI.monthLow,
  '本月到期(中)': MORANDI.month,
  '本月到期(高)': MORANDI.monthHigh,
  '1天内到期': SEGMENT_COLORS[0],
  '2天内到期': SEGMENT_COLORS[1],
  '7天内到期': SEGMENT_COLORS[2],
}

function pairs<T>(items: T[]): Array<[T, T]> {
  const out: Array<[T, T]> = []
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) out.push([items[i] as T, items[j] as T])
  }
  return out
}

describe('莫兰迪调色板', () => {
  it('每个色值都落在莫兰迪区间（中明度、低饱和）', () => {
    for (const [name, hex] of Object.entries(MORANDI)) {
      const { s, l } = hsl(hex)
      expect(s, `${name}=${hex} 饱和度 ${(s * 100).toFixed(0)}% 过高`).toBeLessThanOrEqual(0.32)
      expect(l, `${name}=${hex} 明度 ${(l * 100).toFixed(0)}% 出界`).toBeGreaterThanOrEqual(0.45)
      expect(l, `${name}=${hex} 明度 ${(l * 100).toFixed(0)}% 出界`).toBeLessThanOrEqual(0.80)
    }
  })

  it('不再使用高饱和的主题别名（主题别名会解析回系统色，覆盖莫兰迪）', () => {
    for (const hex of Object.values(MORANDI)) expect(hex).not.toContain('var(')
  })

  it('每个语义各自一个不同色值——没有两个指标共用同一颜色', () => {
    // 回归点：曾出现「已用积分」与「7天内到期」都取 calm，导致两个不同指标同色。
    const values = Object.values(MORANDI)
    expect(new Set(values).size).toBe(values.length)
  })

  it('同屏的进度条两两可分辨（ΔE ≥ 11）', () => {
    for (const [a, b] of pairs(Object.entries(BAR_COLORS))) {
      const d = deltaE(a[1], b[1])
      expect(d, `${a[0]} vs ${b[0]} 只差 ${d.toFixed(1)}`).toBeGreaterThanOrEqual(11)
    }
  })

  it('到期三档是同族连续色阶：相邻比跨档更接近', () => {
    const [a, b, c] = SEGMENT_COLORS as unknown as [string, string, string]
    const adjacent = Math.min(deltaE(a, b), deltaE(b, c))
    const spanning = deltaE(a, c)
    // 相邻更近 → 眼睛读出来是一条「时间推移」的序列，而不是三个孤立色块。
    expect(adjacent, `相邻 ${adjacent.toFixed(1)} 应明显小于跨档 ${spanning.toFixed(1)}`).toBeLessThan(spanning * 0.8)
    // 同族：色相单调推进，且明度接近（否则读不出连续）。
    const hues = [a, b, c].map(hex => hsl(hex))
    expect(hues[1]!.h).toBeGreaterThan(hues[0]!.h)
    expect(hues[2]!.h).toBeGreaterThan(hues[1]!.h)
    const lums = hues.map(x => x.l)
    expect(Math.max(...lums) - Math.min(...lums)).toBeLessThan(0.06)
  })

  it('本月到期三档同理：同色相内升降明度，不是换色相', () => {
    const trio = [MORANDI.monthLow, MORANDI.month, MORANDI.monthHigh]
    const hues = trio.map(hex => hsl(hex).h)
    expect(Math.max(...hues) - Math.min(...hues)).toBeLessThan(8)
    const lums = trio.map(hex => hsl(hex).l)
    expect(lums[0]).toBeGreaterThan(lums[1] as number)
    expect(lums[1]).toBeGreaterThan(lums[2] as number)
  })

  it('月度预警按消耗率升档，且三档互不相同', () => {
    expect(monthColor(0.1)).toBe(MORANDI.monthLow)
    expect(monthColor(0.7)).toBe(MORANDI.month)
    expect(monthColor(0.9)).toBe(MORANDI.monthHigh)
    expect(new Set([monthColor(0.1), monthColor(0.7), monthColor(0.9)]).size).toBe(3)
  })

  it('7 天圆环色阶：7 步互不相同，且相邻两天足够可分辨', () => {
    expect(EXPIRY_COLORS).toHaveLength(7)
    expect(new Set(EXPIRY_COLORS).size).toBe(7)
    // 这条是本次修改的**核心**：上一版把 7 天做成「相邻 ΔE≈4」的连续渐变，
    // 肉眼读到的是一片糊，用户的原话是「看不明白」。
    // 阈值 11 与下面 BAR_COLORS 用的同一把尺子（palette.test.ts 既有标准）。
    for (let i = 1; i < EXPIRY_COLORS.length; i++) {
      const d = deltaE(EXPIRY_COLORS[i - 1] as string, EXPIRY_COLORS[i] as string)
      expect(d, `第 ${i - 1} 天 vs 第 ${i} 天只差 ${d.toFixed(1)}`).toBeGreaterThanOrEqual(11)
    }
  })

  it('7 天色阶与侧栏三段条是两套色，且圆环内部全对可分辨', () => {
    // 刻意**不**复用 SEGMENT_COLORS：那三个锚点彼此只差 ΔE≈11.8，摊到 3 步
    // 每步 ≈3.9，永远到不了可分辨阈值。这条断言防止有人「顺手统一」两套色，
    // 那会把 7 天重新糊成一片。
    for (const anchor of SEGMENT_COLORS) {
      expect(EXPIRY_COLORS as readonly string[]).not.toContain(anchor)
    }
    let min = Number.POSITIVE_INFINITY
    let worst = ''
    for (let i = 0; i < EXPIRY_COLORS.length; i++) {
      for (let j = i + 1; j < EXPIRY_COLORS.length; j++) {
        const d = deltaE(EXPIRY_COLORS[i] as string, EXPIRY_COLORS[j] as string)
        if (d < min) { min = d; worst = `第 ${i} 天 vs 第 ${j} 天` }
      }
    }
    expect(min, `最接近的一对是 ${worst}，只差 ${min.toFixed(1)}`).toBeGreaterThanOrEqual(11)
  })

  it('7 天色阶保留时间轴：色相单调推进（越近越暖）', () => {
    const hues = EXPIRY_COLORS.map(hex => hsl(hex))
    for (let i = 1; i < hues.length; i++) {
      expect(hues[i]!.h, `第 ${i} 步色相应大于上一步`).toBeGreaterThan(hues[i - 1]!.h)
    }
  })

  it('7 天色阶与其它环的数据色也能分开（同屏共现）', () => {
    // 已用环 / 本月三档与 7 天分段同屏出现，彼此不能撞色。
    const others = [MORANDI.used, MORANDI.monthLow, MORANDI.month, MORANDI.monthHigh]
    for (const other of others) {
      for (const day of EXPIRY_COLORS) {
        const d = deltaE(other, day)
        expect(d, `${other} vs ${day} 只差 ${d.toFixed(1)}`).toBeGreaterThanOrEqual(11)
      }
    }
  })

  it('7 天色阶的每一档仍是莫兰迪（中明度、低饱和）', () => {
    for (const hex of EXPIRY_COLORS) {
      const { s, l } = hsl(hex)
      expect(s, `${hex} 饱和度过高`).toBeLessThanOrEqual(0.32)
      expect(l, `${hex} 明度出界`).toBeGreaterThanOrEqual(0.45)
      expect(l, `${hex} 明度出界`).toBeLessThanOrEqual(0.80)
    }
  })

  it('状态徽标色离各数据色仍可分辨（阈值放宽到 9：徽标小且有文字兜底）', () => {
    for (const [name, status] of [['ok', MORANDI.ok], ['blocked', MORANDI.blocked], ['neutral', MORANDI.neutral]] as const) {
      for (const [bar, color] of Object.entries(BAR_COLORS)) {
        const d = deltaE(status, color)
        expect(d, `状态 ${name} vs ${bar} 只差 ${d.toFixed(1)}`).toBeGreaterThanOrEqual(9)
      }
    }
  })

  it('控件强调色（开关）也离所有数据色够远', () => {
    for (const [bar, color] of Object.entries(BAR_COLORS)) {
      expect(deltaE(MORANDI.accent, color), `开关 vs ${bar}`).toBeGreaterThanOrEqual(11)
    }
  })

  it('tint 保留原色相但把占比压到很低（当轨道底色）', () => {
    // 原断言只查了两个子串，占比改成 95% 也照样通过——测不出「降低占比」这个主张。
    const out = tint(MORANDI.urgent)
    expect(out).toContain(MORANDI.urgent) // 原色相还在
    expect(out).toContain('color-mix')
    // 关键：混色占比必须是"底色"量级，不能高到把轨道压过实心进度条。
    const share = Number.parseFloat(out.match(/\s(\d+(?:\.\d+)?)%/)![1]!)
    expect(share).toBeGreaterThan(0)
    expect(share).toBeLessThanOrEqual(30)
    // 且必须混到 transparent（叠在任意底色上都能透出下层），而不是混白/混黑。
    expect(out).toContain('transparent')
  })
})

const ok = <T,>(value: T): { ok: true; value: T } => ({ ok: true, value })

const view = {
  totalBalance: 1000,
  totalSize: 2000,
  totalUsed: 1000,
  totalUsedRatio: 0.5,
  monthPool: { expiring: 360, used: 240, size: 400, usedRatio: 0.6 },
  monthPoolRemain: 360,
  monthPoolExpiring: 360,
  tomorrowExpiring: 10,
  dayAfterExpiring: 40,
  weekExpiring: 70,
  tomorrow: { expiring: 10, used: 1, size: 10, usedRatio: 0.1 },
  dayAfter: { expiring: 40, used: 8, size: 40, usedRatio: 0.2 },
  week: { expiring: 70, used: 21, size: 70, usedRatio: 0.3 },
  details: [],
}

function renderWide() {
  const remote = {
    usage: async () => ok({ loggedIn: true, view }),
    getSettings: async () => ok({ showUsage: true }),
  }
  return render(createElement(UsageIndicator as never, {
    remote: remote as never,
    t: (key: string) => key,
    wide: true,
  }))
}

/** #rrggbb → 浏览器风格 'rgb(r, g, b)'，便于与 jsdom 归一化后的值比对。 */
function rgbOf(hex: string): string {
  const [r, g, b] = toRgb(hex)
  return `rgb(${r}, ${g}, ${b})`
}

describe('侧栏三段条使用到期色阶', () => {
  it('三段实心填充依次取 1天/2天/7天 的色阶色', async () => {
    const { container } = renderWide()
    await waitFor(() => expect(container.querySelectorAll('[data-expiring-segment]')).toHaveLength(3))
    const fills = Array.from(container.querySelectorAll('[data-expiring-segment]'))
      .map(segment => segment.querySelector('div') as HTMLElement)
      .map(fill => fill.style.background)
    for (const [index, fill] of fills.entries()) {
      expect(fill, `第 ${index + 1} 段实心色`).toBe(rgbOf(SEGMENT_COLORS[index] as string))
    }
  })
})
