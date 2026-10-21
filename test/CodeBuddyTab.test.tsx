import { describe, it, expect, vi } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { createElement } from 'react'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: ({ children, ...rest }: { children?: unknown }) => createElement('button', rest, children),
  // Toast 原语：真实实现走 portal 并自报完成。桩里渲染成一块带 text 的节点，
  // 够断言「失败时出现了提示」；onDone 由调用方在动画结束后触发，这里不自动调。
  Toast: ({ text }: { text: string }) => createElement('div', { role: 'status' }, text),
  // 按官方原语的真实 DOM 与回调语义做桩：button[role=switch][aria-checked]，
  // 点击时把**目标状态**交给 onChange（而不是让调用方自己取反）。
  Switch: ({ checked, onChange, label, disabled }: {
    checked: boolean; onChange: (next: boolean) => void; label: string; disabled?: boolean
  }) => createElement('button', {
    type: 'button', role: 'switch', 'aria-checked': checked, 'aria-label': label,
    disabled, onClick: () => { onChange(!checked) },
  }, createElement('span', null)),
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

function renderCard(remote: ReturnType<typeof makeRemote>, injected: Record<string, unknown> = {}) {
  const { container } = render(
    createElement(CodeBuddyTab as never, {
      remote: remote as never,
      setShowUsage: async () => undefined,
      setShowComposerUsage: async () => undefined,
      setWaitOnRateLimit: async () => undefined,
      setWebSearch: async () => undefined,
      t: (key: string) => key,
      ...injected,
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
  describe('设置开关行', () => {
    const switches = (container: HTMLElement): HTMLButtonElement[] =>
      Array.from(container.querySelectorAll('button[role="switch"]'))

    it('所有开关都用官方 Switch 原语渲染，带可访问名与勾选态', async () => {
      // 回归：这几行曾经是自绘的 button（轨道+滑块全靠手写样式与十六进制色），
      // 与官方设置页不一致且没有焦点环。改用官方原语后，DOM 契约是
      // button[role=switch][aria-checked][aria-label]。
      const container = renderCard(makeRemote(partialView, { searchBackend: 'codebuddy' }))
      await waitFor(() => expect(switches(container)).toHaveLength(4))
      const rows = switches(container)
      expect(rows.map(r => r.getAttribute('aria-label')))
        .toEqual(['showUsage', 'showComposerUsage', 'waitOnRateLimit', 'webSearch'])
      // getSettings 桩返回 showUsage:true / webSearch:false；
      // showComposerUsage 缺席 → 按 schema 默认（开）；
      // waitOnRateLimit 缺席 → 按 schema 默认（429 不等，关）。
      expect(rows.map(r => r.getAttribute('aria-checked')))
        .toEqual(['true', 'true', 'false', 'false'])
    })

    it('开关行用与官方设置页同构的行容器，并成组相邻', async () => {
      const container = renderCard(makeRemote(partialView, { searchBackend: 'codebuddy' }))
      await waitFor(() => expect(switches(container)).toHaveLength(4))
      // 四行同属一个组（组内无 gap，靠官方行的下分隔线相邻）。
      const group = container.querySelector('.cb-setting-group')
      expect(group).not.toBeNull()
      expect(group?.querySelectorAll('.cb-setting-row')).toHaveLength(4)
      // 标题与说明各自带官方类名（尺寸/配色由注入的样式表提供）。
      const first = group?.querySelector('.cb-setting-row')
      expect(first?.querySelector('.cb-setting-title')?.textContent).toBe('showUsage')
      expect(first?.querySelector('.cb-setting-desc')?.textContent).toBe('showUsageDesc')
    })

    it('点击把目标状态交给 setter（官方 onChange 语义，不双重取反）', async () => {
      const setShowUsage = vi.fn(async () => undefined)
      const container = renderCard(makeRemote(partialView), { setShowUsage })
      // 已登录 → 四行都在（搜索行的显示与否只看登录态，徽标才看 searchBackend）。
      await waitFor(() => expect(switches(container)).toHaveLength(4))
      // aria-checked 初值 true → 点击应请求 false。
      switches(container)[0]?.click()
      await waitFor(() => expect(setShowUsage).toHaveBeenCalledWith(false))
    })

    it('429 等待开关读 host 的值，点击把目标状态交给 setWaitOnRateLimit', async () => {
      // host 报开 → 勾选；点击请求关。缺省值（旧 host 不发）是关。
      const setWaitOnRateLimit = vi.fn(async () => undefined)
      const remote = makeRemote(partialView)
      remote.getSettings = async () => ok({ showUsage: true, webSearch: false, waitOnRateLimit: true })
      const container = renderCard(remote, { setWaitOnRateLimit })
      await waitFor(() => expect(switches(container)).toHaveLength(4))
      const waitRow = switches(container)[2]
      expect(waitRow?.getAttribute('aria-checked')).toBe('true')
      waitRow?.click()
      await waitFor(() => expect(setWaitOnRateLimit).toHaveBeenCalledWith(false))
    })

    it('未登录时不渲染搜索开关行（该行整体隐藏）', async () => {
      // 未登录时插件不注册搜索 provider，暴露一个永远无效的开关只会误导。
      const container = renderCard(makeRemote(partialView, { loggedIn: false }))
      await waitFor(() => expect(switches(container)).toHaveLength(3))
      expect(switches(container).map(r => r.getAttribute('aria-label')))
        .toEqual(['showUsage', 'showComposerUsage', 'waitOnRateLimit'])
    })
  })

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
