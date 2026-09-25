import { describe, it, expect, vi } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { createElement } from 'react'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: ({ children, ...rest }: { children?: unknown }) => createElement('button', rest, children),
}))

import { CodeBuddyTab } from '../src/client/CodeBuddyTab.jsx'

const ok = <T,>(value: T): { ok: true; value: T } => ({ ok: true, value: value })

function makeRemote(view: unknown, status: Record<string, unknown> = {}) {
  return {
    status: async () => ok({ loggedIn: true, userId: 'u-1', ...status }),
    usage: async () => ok({ loggedIn: true, view }),
    startLogin: async () => ok({ authUrl: '', state: '' }),
    pollLogin: async () => ok({ done: true }),
    logout: async () => ok(undefined),
    getSettings: async () => ok({ showUsage: true, webSearch: false }),
  }
}

function renderCard(remote: ReturnType<typeof makeRemote>) {
  const { container } = render(
    createElement(CodeBuddyTab as never, {
      remote: remote as never,
      setShowUsage: async () => undefined,
      setWebSearch: async () => undefined,
      t: (key: string) => key,
    }),
  )
  return container
}

/** A view built by an older host half: present, but missing totalSize/totalBalance/monthPool. */
const partialView = {
  totalUsed: 50,
  totalUsedRatio: 0.25,
  tomorrow: { expiring: 2, used: 1, size: 2, usedRatio: 0.5 },
  dayAfter: { expiring: 3, used: 1, size: 2, usedRatio: 0.5 },
  week: { expiring: 4, used: 1, size: 2, usedRatio: 0.5 },
  details: [],
}

describe('CodeBuddyTab', () => {
  it('renders the config body unconditionally, with no summary branch to fall into', async () => {
    // plugins.bundle.config 只渲染 page 视图，且详情页的标题/简介由 Plugins 页按包的
    // locale 元数据绘制。组件因此不该再有 summary 分支（那会让 view 缺失时渲染成
    // 一行简介、配置消失）。这里锁定「无论如何都给出配置正文」。
    const container = renderCard(makeRemote(partialView))
    await waitFor(() => expect(container.querySelector('.cb-body')).not.toBeNull())
    expect(container.querySelector('.cb-header')).toBeNull()
    expect(container.querySelector('.cb-card')).toBeNull()
  })

  it('keeps the body when the usage view lacks totalSize/totalBalance', async () => {
    // Regression: unguarded usage.totalBalance.toFixed() / usage.totalSize>0 threw
    // on a stale view, blanking the whole card below its title.
    const container = renderCard(makeRemote(partialView))
    await waitFor(() => expect(container.querySelector('.cb-body')).not.toBeNull())
    const body = container.querySelector('.cb-body')
    expect(body?.textContent).toContain('u-1')
    // 缺 totalSize → 明细档走 usageError 兜底文案（不渲染四条进度条），
    // 整体条退回 totalBalance 兜底显示 50.0 / 0.0 而非抛错。
    expect(body?.textContent).toContain('usageError')
    expect(body?.textContent).toContain('50 / 0')
  })

  it('renders full usage numbers when the view is complete', async () => {
    const container = renderCard(makeRemote({
      ...partialView,
      totalBalance: 100,
      totalSize: 200,
      // 本月到期条必须取 monthPool（与侧边栏同口径），旧 monthly 语义已移除。
      monthPool: { expiring: 30, used: 10, size: 40, usedRatio: 0.25 },
      monthPoolRemain: 30,
      monthPoolExpiring: 30,
    }))
    await waitFor(() => expect(container.querySelector('.cb-body')).not.toBeNull())
    const body = container.querySelector('.cb-body')
    expect(body?.textContent).toContain('100')
    expect(body?.textContent).toContain('50 / 200')
    expect(body?.textContent).toContain('10 / 40') // 本月到期 = monthPool 口径（used/size）
    // 完整 view：明细档条渲染（usageError 文案不再出现）。
    expect(body?.textContent).not.toContain('usageError')
  })

  describe('search backend badge', () => {
    const badgeText = (container: HTMLElement): string | undefined =>
      container.querySelector('.cb-badge')?.textContent ?? undefined

    it('shows the active badge when the takeover is live', async () => {
      const container = renderCard(makeRemote(partialView, { searchBackend: 'codebuddy' }))
      await waitFor(() => expect(badgeText(container)).toBe('searchOn'))
    })

    it('shows the not-taken-over badge when another provider holds the slot', async () => {
      const container = renderCard(makeRemote(partialView, { searchBackend: 'default' }))
      await waitFor(() => expect(badgeText(container)).toBe('searchOff'))
    })

    it('distinguishes a failed takeover from a deliberate opt-out', async () => {
      // 意图（开关开）与效果（未接管）不一致时，徽标是唯一能看出来的地方：
      // 'unavailable' 与 'default' 必须是不同文案，不能合并成一个「未生效」。
      const container = renderCard(makeRemote(partialView, { searchBackend: 'unavailable' }))
      await waitFor(() => expect(badgeText(container)).toBe('searchBlocked'))
    })

    it('renders no badge when the host does not report a backend', async () => {
      // 旧 host 不发该字段 → 不渲染，而不是猜一个状态显示。
      const container = renderCard(makeRemote(partialView))
      await waitFor(() => expect(container.querySelector('.cb-body')).not.toBeNull())
      expect(container.querySelector('.cb-badge')).toBeNull()
    })

    it('renders no badge while signed out because the whole search row is hidden', async () => {
      // 未登录时插件根本不注册 provider，搜索行（连同徽标）一并隐藏——与
      // 「暴露一个永远无效的开关只会误导」是同一条既有不变式。此时「不是
      // CodeBuddy」无需徽标说明：行本身就不在。
      const remote = {
        ...makeRemote(partialView, { searchBackend: 'default' }),
        status: async () => ok({ loggedIn: false, searchBackend: 'default' }),
      }
      const container = renderCard(remote)
      await waitFor(() => expect(container.textContent).toContain('notSignedIn'))
      expect(container.querySelector('.cb-badge')).toBeNull()
    })
  })
})
