import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { createElement } from 'react'
import type { UsageView } from '../src/remote-types.js'
import { UsageRings } from '../src/client/UsageRings.jsx'
import { en } from '../src/client/locales.js'
import { EXPIRY_COLORS, MORANDI, monthColor } from '../src/client/palette.js'

const t = (key: string) => en[key as keyof typeof en] ?? key

/**
 * 相对今天第 n 天的到期时刻，形如 `YYYY-MM-DD 12:00:00`（上海墙上时间）。
 * 用相对天数而不是写死日期：分桶依赖「今天」，写死日期会让用例隔天失效。
 */
function farDay(offset: number): string {
  const now = Date.now() + offset * 86_400_000
  const wall = new Date(now + 8 * 3_600_000)
  return `${wall.toISOString().slice(0, 10)} 12:00:00`
}

function view(overrides: Partial<UsageView> = {}): UsageView {
  return {
    totalBalance: 1000,
    totalSize: 2000,
    totalUsed: 1000,
    totalUsedRatio: 0.5,
    monthPool: { expiring: 360, used: 40, size: 400, usedRatio: 0.1 },
    monthPoolRemain: 360,
    monthPoolExpiring: 360,
    tomorrowExpiring: 40,
    dayAfterExpiring: 80,
    weekExpiring: 120,
    tomorrow: { expiring: 40, used: 1, size: 40, usedRatio: 0.025 },
    dayAfter: { expiring: 80, used: 3, size: 80, usedRatio: 0.0375 },
    week: { expiring: 120, used: 6, size: 120, usedRatio: 0.05 },
    details: [],
    ...overrides,
  }
}

function renderRings(v: UsageView = view()) {
  return render(createElement(UsageRings as never, { view: v, t }))
}

describe('UsageRings（同心圆环）', () => {
  it('draws exactly one arc group per day, so the ring is always 7 segments', () => {
    const { container } = renderRings()
    expect(container.querySelectorAll('[data-day-segment]')).toHaveLength(7)
  })

  it('puts the total remaining credits in the centre', () => {
    const { container } = renderRings()
    const svg = container.querySelector('svg')
    expect(svg?.textContent).toContain(en.totalBalance)
    expect(svg?.textContent).toContain('1000')
  })

  it('renders three concentric radii, inner to outer', () => {
    const { container } = renderRings()
    const radii = Array.from(container.querySelectorAll('circle'))
      .map(circle => Number(circle.getAttribute('r')))
    // 轨道 3 条 + （已用/本月/每天实心）若干；三个轨道半径必须互不相同且递增。
    const tracks = [...new Set(radii)].sort((a, b) => a - b)
    expect(tracks.length).toBeGreaterThanOrEqual(3)
    expect(tracks[0]).toBeLessThan(tracks[1] as number)
    expect(tracks[1]).toBeLessThan(tracks[2] as number)
  })

  it('colours the used ring and the month ring from the shared palette', () => {
    const { container } = renderRings()
    const strokes = Array.from(container.querySelectorAll('circle'))
      .map(circle => circle.getAttribute('stroke'))
    // 已用积分走灰紫；本月走 monthColor（此处 ratio 0.1 → 低档）。
    expect(strokes).toContain(MORANDI.used)
    expect(strokes).toContain(monthColor(0.1))
  })

  it('lists every day in the legend, including days with no allowance', () => {
    const { container } = renderRings()
    // 7 个天标签全部出现——「环上没画」与「那天没有额度」必须能分辨。
    for (let day = 0; day < 7; day++) {
      expect(container.textContent).toContain(en[`expiringDay${day}` as keyof typeof en])
    }
    expect(container.textContent).toContain(en.expiryByDay)
  })

  it('shows real per-day numbers in the legend rather than only the ring', () => {
    const { container } = renderRings(view({
      details: [{ name: 'x', cycleEndTime: farDay(2), remain: 1, size: 4, used: 3 }],
    }))
    // 有额度的那天给出精确的 used / size，精确值有出处。
    expect(container.textContent).toContain('3 / 4')
  })

  it('survives a stale view with no monthPool or details', () => {
    // 旧 host：不能抛、不能整块消失（历史上裸属性读让卡片只剩标题）。
    const stale = {
      totalBalance: 50,
      totalSize: 0,
      totalUsed: 0,
      totalUsedRatio: 0,
    } as unknown as UsageView
    const { container } = renderRings(stale)
    expect(container.querySelector('[data-usage-rings]')).not.toBeNull()
    expect(container.querySelectorAll('[data-day-segment]')).toHaveLength(7)
  })

  it('carries an accessible summary instead of seven raw arcs', () => {
    const { container } = renderRings()
    expect(container.querySelector('svg')?.getAttribute('aria-label')).toContain('1000')
  })

  it('actually draws a mark for an empty day, not just allocates width for it', () => {
    // 回归点：最小宽度如果只算在几何里而不落笔，空段就是不可见的——7 段环会
    // 塌成几段、位置天天变。这里锁定「每个 data-day-segment 里都有可见的圆」。
    const { container } = renderRings()
    const groups = Array.from(container.querySelectorAll('[data-day-segment]'))
    expect(groups).toHaveLength(7)
    for (const group of groups) {
      const circles = Array.from(group.querySelectorAll('circle'))
      expect(circles.length, `${group.getAttribute('data-day-segment')} 应有可见弧`).toBeGreaterThan(0)
    }
    // 空段是淡的（opacity < 1），真实那天是实的。
    const opacities = groups.map(group => group.querySelector('circle')?.getAttribute('stroke-opacity'))
    expect(opacities.some(value => value !== null && Number(value) < 1)).toBe(true)
  })

  it('paints every day with its own colour and a shared neutral track', () => {
    // 用户要的读法：未用部分与另外两环**同一个中性色**，已用部分才是当天的颜色。
    const { container } = renderRings(view({
      details: [
        { name: 'a', cycleEndTime: farDay(0), remain: 0, size: 100, used: 100 },
        { name: 'b', cycleEndTime: farDay(3), remain: 50, size: 100, used: 50 },
      ],
    }))
    const dayStrokes = Array.from(container.querySelectorAll('[data-day-segment] circle'))
      .map(circle => circle.getAttribute('stroke'))
    // 中性轨道出现在每一天的未用部分上（与内/中环的轨道同色）。
    expect(dayStrokes).toContain('var(--dsw-alias-border-l2)')
    // 当天已用部分用当天自己的颜色：第 0 天与第 3 天各自出现。
    expect(dayStrokes).toContain(EXPIRY_COLORS[0])
    expect(dayStrokes).toContain(EXPIRY_COLORS[3])
  })

  it('leaves a real gap between day segments instead of butting them together', () => {
    const { container } = renderRings(view({
      details: [
        { name: 'a', cycleEndTime: farDay(0), remain: 50, size: 100, used: 50 },
        { name: 'b', cycleEndTime: farDay(1), remain: 50, size: 100, used: 50 },
      ],
    }))
    // 相邻两段的「已用弧」不应首尾相接：中间必须有间隙。
    const usedArcs = Array.from(container.querySelectorAll('[data-day-segment] circle'))
      .filter(circle => circle.getAttribute('stroke') !== 'var(--dsw-alias-border-l2)')
    expect(usedArcs.length).toBeGreaterThanOrEqual(2)
  })

  it('marks a day with no allowance distinctly from a day at 0% used', () => {
    const withAllowance = {
      name: 'a', cycleEndTime: farDay(0), remain: 100, size: 100, used: 0,
    }
    const noAllowance = { name: 'b', cycleEndTime: farDay(1), remain: 0, size: 0, used: 0 }
    const { container } = renderRings(view({ details: [withAllowance, noAllowance] }))
    const day0 = container.querySelector('[data-day-segment="0"]')
    const day1 = container.querySelector('[data-day-segment="1"]')
    // 有额度但一点没用：中性弧是实心的（opacity 1）。
    expect(Number(day0?.querySelector('circle')?.getAttribute('stroke-opacity') ?? '1')).toBe(1)
    // 没额度：淡化的中性弧——两者必须能分开。
    expect(Number(day1?.querySelector('circle')?.getAttribute('stroke-opacity'))).toBeLessThan(1)
    // 图例里没额度的那天给破折号，而不是会被读成「有额度但没用」的 0 / 0。
    expect(container.textContent).toContain('—')
  })

  it('wraps instead of squashing, and leaves centring to the container', () => {
    // 弹窗内容列放不下「220px 圆环 + 图例」时，图例必须折到第二行而不是把圆环挤扁。
    // 居中**不在这里**做：插件详情页其余各行左对齐，圆环整组居中会脱节；弹窗那条
    // `.cb-usage-modal [data-usage-rings]{justify-content:center}` 见 CodeBuddyTab。
    const { container } = renderRings()
    const wrap = container.querySelector('[data-usage-rings]') as HTMLElement
    const style = wrap.getAttribute('style') ?? ''
    expect(style).toContain('flex-wrap: wrap')
    expect(style).not.toContain('justify-content: center')
  })

  it('keeps each legend value next to its label instead of pushed to the far edge', () => {
    // 用户报的「label 与数值距离太远」：标签原来是 flex:1，会把数值一路推到容器
    // 最右边，容器越宽离得越远。改成网格后四列各自成列、列间距恒定 8px。
    const { container } = renderRings()
    const legend = container.querySelector('[data-usage-rings] > div') as HTMLElement
    const style = legend.getAttribute('style') ?? ''
    expect(style).toContain('display: grid')
    expect(style).toContain('column-gap: 8px')
    // 图例贴合内容（不是 flex:1 拉伸），否则右侧会多出一块死白。
    expect(style).toContain('flex: 0 1 auto')
    // 同一行的标签与数值是**相邻**的网格项，中间没有撑开的元素。
    const children = Array.from(legend.children)
    const labelIndex = children.findIndex(child => child.textContent === en.totalUsed)
    expect(labelIndex).toBeGreaterThan(-1)
    const label = children[labelIndex] as HTMLElement
    const value = children[labelIndex + 1] as HTMLElement
    // 标签不再带 flex-grow：它是网格项，宽度由内容决定。
    expect(label.getAttribute('style')).not.toContain('flex')
    expect(value.textContent).toBe('1000 / 2000')
  })

  it('lays the legend out as one grid so all rows share the same columns', () => {
    const { container } = renderRings()
    const legend = container.querySelector('[data-usage-rings] > div') as HTMLElement
    expect(legend.getAttribute('style')).toContain('grid-template-columns: 8px auto auto auto')
  })

  it('grows each arc from zero on open, and stays static under reduced motion', () => {
    // 用户要的「打开增加一个动画过程」：弧长从 0 顺时针长出来。
    const { container } = renderRings()
    const arcs = Array.from(container.querySelectorAll('.cb-ring-arc'))
    expect(arcs.length).toBeGreaterThan(0)
    for (const arc of arcs) {
      const style = arc.getAttribute('style') ?? ''
      // 起点是「整圈」（不可见），终点是该元素自己的终值；两者由内联变量给出，
      // 所以同一条 keyframes 能服务半径各异的弧。
      expect(style).toContain('--cb-from')
      expect(style).toContain('--cb-to')
    }
    // 动画声明在样式表里、且包在 prefers-reduced-motion 守卫内——
    // 静态几何（inline 的 dashoffset 终值）不依赖动画，reduced-motion 下照常显示。
    const css = container.ownerDocument.querySelector('style[data-plugin-css*="rings"]')?.textContent ?? ''
    expect(css).toContain('cb-ring-grow')
    expect(css).toContain('prefers-reduced-motion')
  })

  it('stagger the rings so the eye is led inner-to-outer', () => {
    const { container } = renderRings()
    const delays = Array.from(container.querySelectorAll('.cb-ring-arc'))
      // React 序列化后的形式是 `animation-delay: 0ms;`——冒号后有一个空格。
      .map(arc => /animation-delay:\s*(\d+)ms/.exec(arc.getAttribute('style') ?? '')?.[1])
      .filter((value): value is string => value !== undefined)
      .map(Number)
    expect(delays.length).toBeGreaterThan(1)
    expect(new Set(delays).size).toBeGreaterThan(1)
    expect(Math.max(...delays)).toBeGreaterThan(0)
  })

})
