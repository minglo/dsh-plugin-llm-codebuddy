import { describe, it, expect, vi } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { createElement, Fragment } from 'react'

// UsageIndicator 只用 Tooltip：mock 成透传容器（children + label 都渲染），
// 使可见条与悬停 label 都可被 textContent 断言。
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Tooltip: ({ children, label }: { children?: unknown; label?: string }) =>
    createElement(Fragment, null, children, label === undefined ? null : label),
}))

import { UsageIndicator } from '../src/client/UsageIndicator.jsx'

const ok = <T,>(value: T): { ok: true; value: T } => ({ ok: true, value: value })

function makeRemote(view: unknown) {
  return {
    usage: async () => ok({ loggedIn: true, view }),
    getSettings: async () => ok({ showUsage: true }),
  }
}

/** 完整 view：总剩 1000，本月池 size 400（已用 40 → 10%），本月剩 360（占总额 36%）。
 * 到期窗口是**累计**口径（7天 ⊇ 2天 ⊇ 1天），互斥三段由 host 值相减得到。 */
const fullView = {
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
  // 累计：≤1天 used1/size40、≤2天 used3/size80、≤7天 used6/size120。
  // 互斥相减 → 段1 1/40(2.5%)、段2 2/40(5%)、段3 3/40(7.5%)。
  tomorrow: { expiring: 40, used: 1, size: 40, usedRatio: 0.025 },
  dayAfter: { expiring: 80, used: 3, size: 80, usedRatio: 0.0375 },
  week: { expiring: 120, used: 6, size: 120, usedRatio: 0.05 },
  details: [],
}

function renderRail(view: unknown) {
  return render(createElement(UsageIndicator as never, {
    remote: makeRemote(view) as never,
    t: (key: string) => key,
    wide: false,
  }))
}

function renderWide(view: unknown) {
  return render(createElement(UsageIndicator as never, {
    remote: makeRemote(view) as never,
    t: (key: string) => key,
    wide: true,
  }))
}

describe('UsageIndicator（侧栏：本月剩余三段式 + 最近剩余复合条）', () => {
  it('rail 态显示本月到期池消耗率（10%），非整体已用率', async () => {
    const { container } = renderRail(fullView)
    await waitFor(() => expect(container.textContent).toContain('10%'))
    expect(container.textContent).not.toContain('50%') // 旧整体口径不再出现
  })

  it('tooltip 含已使用/本月剩余/总剩余，以及三个互斥到期段', async () => {
    const { container } = renderRail(fullView)
    await waitFor(() => expect(container.textContent).toContain('10%'))
    expect(container.textContent).toContain('monthUsed: 40 / monthUsedRate: 10%')
    expect(container.textContent).toContain('monthPoolRemain: 360 / monthSize: 400')
    expect(container.textContent).toContain('totalBalance: 1000')
    // 段名只在 tooltip：互斥值由累计值相减得到。
    expect(container.textContent).toContain('expiringWithin1d: 1 / 40 (3%)')
    expect(container.textContent).toContain('expiring1to2d: 2 / 40 (5%)')
    expect(container.textContent).toContain('expiring2to7d: 3 / 40 (8%)')
  })

  it('第一行为三段式：本月剩余 | 进度条 | 比例', async () => {
    const { container } = renderWide(fullView)
    await waitFor(() => expect(container.textContent).toContain('monthPoolRemain'))
    // 进度条填充 = 本月剩余占总额（36%），右侧比例 = 月度消耗率。
    const fill = container.querySelector('div[style*="width: 36%"]')
    expect(fill).not.toBeNull()
    expect(container.textContent).toContain('10%')
  })

  it('第二行为最近剩余复合条：三段互斥、按额度分宽、段内显示各自已用%', async () => {
    const { container } = renderWide(fullView)
    await waitFor(() => expect(container.textContent).toContain('recentRemain'))
    const segments = container.querySelectorAll('[data-expiring-segment]')
    expect(segments).toHaveLength(3)
    // 三段额度均为 40 → 等宽 1/3。
    for (const segment of segments) {
      expect((segment as HTMLElement).style.width).toBe('33.33333333333333%')
    }
    // 段内百分比 = 各自互斥已用率（2.5%→3%、5%、7.5%→8%）。
    const texts = Array.from(segments).map(segment => segment.textContent)
    expect(texts).toEqual(['3%', '5%', '8%'])
  })

  it('按额度大小分宽：额度大的段更宽', async () => {
    // 互斥后 段1=10(1天) 段2=30(2天) 段3=30(7天) → 总 70 → 1/7、3/7、3/7。
    const view = {
      ...fullView,
      tomorrow: { expiring: 10, used: 1, size: 10, usedRatio: 0.1 },
      dayAfter: { expiring: 40, used: 2, size: 40, usedRatio: 0.05 },
      week: { expiring: 70, used: 3, size: 70, usedRatio: 0.042857 },
    }
    const { container } = renderWide(view)
    await waitFor(() => expect(container.textContent).toContain('recentRemain'))
    const widths = Array.from(container.querySelectorAll('[data-expiring-segment]'))
      .map(segment => Number.parseFloat((segment as HTMLElement).style.width))
    expect(widths[0]).toBeCloseTo(100 / 7, 4)
    expect(widths[1]).toBeCloseTo(300 / 7, 4)
    expect(widths[2]).toBeCloseTo(300 / 7, 4)
  })

  it('无短期到期包时不渲染复合条（不留 0 宽灰轨）', async () => {
    const view = {
      ...fullView,
      tomorrow: { expiring: 0, used: 0, size: 0, usedRatio: 0 },
      dayAfter: { expiring: 0, used: 0, size: 0, usedRatio: 0 },
      week: { expiring: 0, used: 0, size: 0, usedRatio: 0 },
    }
    const { container } = renderWide(view)
    await waitFor(() => expect(container.textContent).toContain('monthPoolRemain'))
    expect(container.querySelectorAll('[data-expiring-segment]')).toHaveLength(0)
    expect(container.textContent).not.toContain('recentRemain')
  })

  it('旧 host view（无 monthPool）不崩溃，回落渲染且月度读数按 0 兜底', async () => {
    const oldView = { totalBalance: 500, totalSize: 1000, totalUsed: 500, totalUsedRatio: 0.5 }
    const { container } = renderRail(oldView)
    await waitFor(() => expect(container.textContent).toContain('0%'))
    expect(container.textContent).toContain('totalBalance: 500')
    expect(container.textContent).toContain('monthPoolRemain: 0 / monthSize: 0')
  })

  it('未读数前不渲染（showUsage 读取未完成 / 无数据 → 空）', () => {
    const remote = {
      usage: async () => ok({ loggedIn: true, view: undefined }),
      getSettings: async () => ok({ showUsage: true }),
    }
    const { container } = render(createElement(UsageIndicator as never, {
      remote: remote as never,
      t: (key: string) => key,
      wide: false,
    }))
    expect(container.textContent).toBe('')
  })
})
