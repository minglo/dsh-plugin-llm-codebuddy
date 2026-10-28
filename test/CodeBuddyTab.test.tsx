import { describe, it, expect, vi } from 'vitest'
import { act, render, waitFor } from '@testing-library/react'
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
    // 首屏只读历史（零外呼）；probe 只在点击时被调用。
    channelHealth: async () => ok({ applicable: true }),
    probe: async () => ok({ verdict: 'healthy', at: 1, model: 'm1', stages: [] }),
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

  describe('渠道自检', () => {
    it('renders the row only when the deployment runs the channel check', async () => {
      const container = renderCard(makeRemote(partialView, { searchBackend: 'codebuddy' }))
      await waitFor(() => expect(container.querySelector('.cb-probe')).not.toBeNull())
      const notApplicable = renderCard({
        ...makeRemote(partialView),
        channelHealth: async () => ok({ applicable: false }),
      })
      await waitFor(() => expect(notApplicable.querySelector('.cb-probe')).toBeNull())
    })

    it('hides the row while signed out even when the deployment is applicable', async () => {
      // 未登录时探针跑不出有意义的结论（连凭据都没有），applicable 再真也不出现。
      // 没有这条，把显示条件里的 `signedIn &&` 删掉不会有人发现。
      let release: ((value: unknown) => void) | undefined
      const channelHealth = vi.fn(() => new Promise(resolve => { release = resolve }))
      const container = renderCard({
        ...makeRemote(partialView, { loggedIn: false }),
        channelHealth,
      })
      await waitFor(() => expect(container.textContent).toContain('notSignedIn'))
      await waitFor(() => expect(channelHealth).toHaveBeenCalled())
      // 明确等历史读数落进 state 再断言「没有这一行」：早一步断言只是还没渲染。
      await act(async () => { release?.(ok({ applicable: true })) })
      expect(container.querySelector('.cb-probe')).toBeNull()
    })

    it('shows the stored verdict on the first screen without probing', async () => {
      // 首屏显示的是盘里的历史结论：`channelHealth()` 只读文件，一次外呼都没有。
      const container = renderCard({
        ...makeRemote(partialView, { searchBackend: 'codebuddy' }),
        channelHealth: async () => ok({ applicable: true, lastProbe: { verdict: 'auth', at: 1, model: '', stages: [] } }),
      })
      await waitFor(() => expect(container.textContent).toContain('probeAuth'))
      expect(container.querySelector('.cb-probe')?.textContent).toContain('probeLastRun')
    })

    it('renders the last real block fingerprint location as readable copy', async () => {
      // fingerprintGuess 一路传到浏览器，但卡片曾经从不渲染它。闭集三值必须映射成
      // 人话，不能把 'identity-sentence' 这种内部标识符原样打上屏。
      const container = renderCard({
        ...makeRemote(partialView, { searchBackend: 'codebuddy' }),
        channelHealth: async () => ok({
          applicable: true,
          lastBlock: { at: 2, fingerprintGuess: 'identity-sentence' },
        }),
      })
      await waitFor(() => expect(container.textContent).toContain('probeFingerprintIdentity'))
      expect(container.textContent).not.toContain('identity-sentence')
    })

    it('falls back for an inherited member instead of printing a function', async () => {
      // `'toString'` 是「未知取值」最可能的样子：裸查表会从原型上取到函数，`??` 拦不住。
      const container = renderCard({
        ...makeRemote(partialView, { searchBackend: 'codebuddy' }),
        channelHealth: async () => ok({
          applicable: true,
          lastBlock: { at: 2, fingerprintGuess: 'toString' },
        }),
      })
      await waitFor(() => expect(container.textContent).toContain('probeFingerprintUnknown'))
      expect(container.textContent).not.toContain('function')
    })

    it('does not probe on mount', async () => {
      // 自检只能由点击触发：首屏只读历史。
      const channelHealth = vi.fn(async () => ok({ applicable: true }))
      const probe = vi.fn(async () => ok({ verdict: 'healthy', at: 1, model: 'm1', stages: [] }))
      renderCard({ ...makeRemote(partialView, { searchBackend: 'codebuddy' }), channelHealth, probe })
      await waitFor(() => expect(channelHealth).toHaveBeenCalled())
      expect(probe).not.toHaveBeenCalled()
    })

    it('runs the probe on click and shows the verdict', async () => {
      const container = renderCard(makeRemote(partialView, { searchBackend: 'codebuddy' }))
      await waitFor(() => expect(container.querySelector('.cb-probe')).not.toBeNull())
      container.querySelector<HTMLButtonElement>('.cb-probe button')?.click()
      await waitFor(() => expect(container.textContent).toContain('probeHealthy'))
    })

    it('falls back to probeUnknown for a verdict this client does not know', async () => {
      // 新主机可以下发本版本没见过的 verdict：兜底文案上屏，**绝不**打出原始枚举。
      const container = renderCard({
        ...makeRemote(partialView, { searchBackend: 'codebuddy' }),
        probe: async () => ok({ verdict: 'brand-new-verdict', at: 1, model: 'm1', stages: [] }),
      })
      await waitFor(() => expect(container.querySelector('.cb-probe')).not.toBeNull())
      container.querySelector<HTMLButtonElement>('.cb-probe button')?.click()
      await waitFor(() => expect(container.textContent).toContain('probeUnknown'))
      expect(container.textContent).not.toContain('brand-new-verdict')
    })

    it('falls back to probeUnknown for an inherited member such as toString', async () => {
      // 查表若直接 `table[verdict] ?? fallback`，'toString' 会取到 Object.prototype
      // 上的函数（truthy），兜底不生效，函数被当成翻译结果交给 React。
      const container = renderCard({
        ...makeRemote(partialView, { searchBackend: 'codebuddy' }),
        probe: async () => ok({ verdict: 'toString', at: 1, model: 'm1', stages: [] }),
      })
      await waitFor(() => expect(container.querySelector('.cb-probe')).not.toBeNull())
      container.querySelector<HTMLButtonElement>('.cb-probe button')?.click()
      await waitFor(() => expect(container.textContent).toContain('probeUnknown'))
      expect(container.textContent).not.toContain('toString')
    })

    it('fills {stage}/{status} with the failing observation', async () => {
      // 设计文档要求判定句逐字保留占位符语义：段名与状态码是复核判定唯一的证据。
      // 用真实的模板替换 `t`，否则测试里的 t 只返回键名，占位符路径根本没被走到。
      const t = (key: string): string =>
        key === 'probeStageFailed' ? '第 {stage} 步返回 HTTP {status}' : key
      const container = renderCard({
        ...makeRemote(partialView, { searchBackend: 'codebuddy' }),
        channelHealth: async () => ok({
          applicable: true,
          lastProbe: {
            verdict: 'stage-failed', at: 1, model: 'm1',
            stages: [{ stage: 'A', status: 200 }, { stage: 'B', status: 502 }],
          },
        }),
      }, { t })
      await waitFor(() => expect(container.textContent).toContain('第 B 步返回 HTTP 502'))
    })

    it('uses an em dash when a stage-failed verdict has no non-200 stage', async () => {
      // 理论上 stage-failed 必有失败阶段；手写/偏斜的 wire 数据可能没有。
      // 此时读数仍要读得通：两个占位符都落破折号，而不是把 {stage} 原样上屏。
      const t = (key: string): string =>
        key === 'probeStageFailed' ? '第 {stage} 步返回 HTTP {status}' : key
      const container = renderCard({
        ...makeRemote(partialView, { searchBackend: 'codebuddy' }),
        channelHealth: async () => ok({
          applicable: true,
          lastProbe: {
            verdict: 'stage-failed', at: 1, model: 'm1',
            stages: [{ stage: 'A', status: 200 }],
          },
        }),
      }, { t })
      await waitFor(() => expect(container.textContent).toContain('第 — 步返回 HTTP —'))
    })

    it('reports a rejected probe and keeps the previous reading', async () => {
      // 调用失败（宿主拒绝 / 会话已释放）不编 verdict：说「没完成」，但上一次的
      // 结论仍留在屏上——它确实是「上次」发生的事，不该被一次失败抹掉。
      const container = renderCard({
        ...makeRemote(partialView, { searchBackend: 'codebuddy' }),
        channelHealth: async () => ok({
          applicable: true,
          lastProbe: { verdict: 'auth', at: 1, model: '', stages: [] },
        }),
        probe: async () => { throw new Error('host refused') },
      })
      await waitFor(() => expect(container.textContent).toContain('probeAuth'))
      container.querySelector<HTMLButtonElement>('.cb-probe button')?.click()
      await waitFor(() => expect(container.textContent).toContain('probeFailed'))
      expect(container.textContent).toContain('probeAuth')
    })

    it('shows the running label while the probe is in flight', async () => {
      let release: ((value: unknown) => void) | undefined
      const probe = vi.fn(() => new Promise(resolve => { release = resolve }))
      const container = renderCard({ ...makeRemote(partialView, { searchBackend: 'codebuddy' }), probe })
      await waitFor(() => expect(container.querySelector('.cb-probe')).not.toBeNull())
      const button = container.querySelector<HTMLButtonElement>('.cb-probe button')
      button?.click()
      await waitFor(() => expect(button?.textContent).toBe('probeRunning'))
      release?.(ok({ verdict: 'healthy', at: 1, model: 'm1', stages: [] }))
      await waitFor(() => expect(button?.textContent).toBe('probeRun'))
    })

    it('keeps the card when the health read fails, with the rejection handled', async () => {
      // 只断言 DOM 不够：Vitest 会吸收未处理的拒绝，把 effect 里的 try/catch 删掉
      // 这些断言照样全绿。这里直接监听 process 的 unhandledRejection——读数失败
      // 必须被 effect 接住，绝不能漏成进程级未处理拒绝。
      const escaped: unknown[] = []
      const onUnhandled = (reason: unknown): void => { escaped.push(reason) }
      process.on('unhandledRejection', onUnhandled)
      try {
        let fail: ((error: Error) => void) | undefined
        const channelHealth = vi.fn(() => new Promise((_resolve, reject) => { fail = reject }))
        const container = renderCard({
          ...makeRemote(partialView, { searchBackend: 'codebuddy' }),
          channelHealth,
        })
        await waitFor(() => expect(channelHealth).toHaveBeenCalled())
        await act(async () => { fail?.(new Error('unreadable')) })
        // unhandledRejection 在微任务队列清空后的下一拍才判定：等一个宏任务。
        await new Promise(resolve => setTimeout(resolve, 0))

        expect(escaped).toEqual([])
        // 诊断读不到只丢自检这一块：卡片其余部分（用户 ID、额度、开关）照常渲染。
        expect(container.querySelector('.cb-setting-group')).not.toBeNull()
        expect(container.querySelector('.cb-probe')).toBeNull()
        expect(container.textContent).toContain('u-1')
      } finally {
        process.off('unhandledRejection', onUnhandled)
      }
    })

    it('disables the button while the probe is in flight', async () => {
      let release: (v: unknown) => void = () => {}
      const probe = vi.fn(() => new Promise(resolve => { release = resolve }))
      const container = renderCard({ ...makeRemote(partialView, { searchBackend: 'codebuddy' }), probe })
      await waitFor(() => expect(container.querySelector('.cb-probe')).not.toBeNull())
      // 点击两次：第二次不能真的发出第二轮（按钮此刻已 disabled，ref 是同一帧的兜底）。
      const button = container.querySelector<HTMLButtonElement>('.cb-probe button')
      button?.click()
      button?.click()
      await waitFor(() => expect(button?.disabled).toBe(true))
      release(ok({ verdict: 'healthy', at: 1, model: 'm1', stages: [] }))
      await waitFor(() => expect(button?.disabled).toBe(false))
      expect(probe).toHaveBeenCalledTimes(1)
    })
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
