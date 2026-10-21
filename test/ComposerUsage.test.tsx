import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createElement } from 'react'
import { USAGE_CACHE_TTL_MS } from '../src/constants.js'
import { USAGE_REFRESH_MS } from '../src/client/usage-feed.js'

// Modal 是 portal + 遮罩 + Escape 的官方实现；这里只关心「谁渲染了什么」，
// 所以按 open/onClose/className 语义做透传桩，不复制它的焦点管理。
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  // Toast 原语：真实实现走 portal 并自报完成。桩里渲染成一块带 text 的节点，
  // 够断言「失败时出现了提示」；onDone 由调用方在动画结束后触发，这里不自动调。
  Toast: ({ text }: { text: string }) => createElement('div', { role: 'status' }, text),
  Modal: ({ open, onClose, title, children, className }: {
    open: boolean; onClose: () => void; title: string; children?: unknown; className?: string
  }) => (open
    ? createElement('div', { role: 'dialog', 'aria-label': title, className },
        createElement('button', { 'aria-label': 'close', onClick: onClose }), children)
    : null),
}))

import { ComposerUsage } from '../src/client/ComposerUsage.jsx'
import { ensurePluginCss } from '../src/client/CodeBuddyTab.jsx'
import { usageFeed } from '../src/client/usage-feed.js'
import { en, zh } from '../src/client/locales.js'

const t = (key: string) => en[key as keyof typeof en] ?? key
const ok = <T,>(value: T): { ok: true; value: T } => ({ ok: true, value })

/** 与 CodeBuddyTab.test 里的完整 view 同口径，便于比对两处渲染的字段是否一致。 */
const view = {
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
}

function makeRemote(options: {
  composer?: boolean
  usage?: () => Promise<unknown>
  checkinStatus?: () => Promise<unknown>
  checkin?: () => Promise<unknown>
} = {}) {
  return {
    // 每个用例一个新对象：usageFeed 按 remote 身份缓存，新对象 = 新 feed = 干净状态。
    usage: (options.usage as never) ?? (async () => ok({ loggedIn: true, view, fetchedAt: 1_700_000_000_000 })),
    getSettings: async () => ok({ showUsage: true, showComposerUsage: options.composer ?? true, webSearch: false }),
    // 签到面：缺省给「读得到、活动开着、今天还没签」的桩，于是圆心默认可点。
    checkinStatus: (options.checkinStatus as never) ?? (async () => ok({
      available: true, active: true, checkedIn: false, streakDays: 20, dailyCredit: 100, todayCredit: 0,
    })),
    checkin: (options.checkin as never) ?? (async () => ok({ success: true, credit: 100, streakDays: 21 })),
  }
}

/** 「没有选择投影」用 null 表达——不能传 undefined，那会命中默认参数。 */
const NO_SELECTION = null

/** 会话选择投影桩：默认 CodeBuddy，可切成别的 provider 或「无选择」。 */
const projection = (provider: string | typeof NO_SELECTION) => (key: string) =>
  (key === 'modelSelection'
    ? (provider === NO_SELECTION ? undefined : { next: { provider, model: 'm' }, lastUsed: null })
    : undefined)

const renderPill = (
  remote: ReturnType<typeof makeRemote>,
  provider: string | typeof NO_SELECTION = 'codebuddy',
) => { lastRemote = remote; return render(createElement(ComposerUsage as never, {
  remote: remote as never,
  t,
  useProjection: projection(provider) as never,
  sessionId: 's-1',
})) }

const trigger = (): HTMLElement => screen.getByRole('button', { name: new RegExp(en.composerUsageTitle) })

/** 取当前用例的共享 feed（用于模拟「后台定时刷新」这一外部事件）。 */
let lastRemote: unknown
const usageFeedOf = () => usageFeed(lastRemote as never)
const queryTrigger = (): HTMLElement | null =>
  screen.queryByRole('button', { name: new RegExp(en.composerUsageTitle) })

/**
 * 走到「偏好已读到 + 首轮读数已落地」的稳定态。
 *
 * 用真定时器 + waitFor 而不是假定时器：这里验的是渲染结果而非时序。
 * 轮询周期是 10 秒，而本文件整体只跑 ~1.4 秒，所以周期定时器在用例存续期内
 * 不会自行触发，无需推进时钟——若哪天用例变慢到接近 10 秒，这里会开始不稳定。
 */
const settle = async (): Promise<void> => { await waitFor(() => { expect(trigger()).toBeTruthy() }) }

/** 走到「已稳定、但按预期什么都不渲染」——等一个微任务让 getSettings/usage 落地。 */
const settleEmpty = async (): Promise<void> => {
  await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
  await Promise.resolve()
}

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('ComposerUsage（输入框工具行的额度胶囊）', () => {
  it('触发按钮显示当月已用率，读数来自共享轮询器', async () => {
    renderPill(makeRemote())
    await settle()
    expect(trigger().textContent).toContain('CodeBuddy')
    // monthPool used 40 / size 400 = 10%。
    expect(trigger().textContent).toContain('10%')
  })

  it('只在选中 CodeBuddy 模型时渲染：换到别的 provider 即消失', async () => {
    // 额度是 CodeBuddy 账号的属性；用别的 provider 时它既不相关也无意义。
    renderPill(makeRemote(), 'deepseek')
    await settleEmpty()
    expect(queryTrigger()).toBeNull()
  })

  it('没有会话 / 尚无选择投影时不渲染（不猜 provider）', async () => {
    renderPill(makeRemote(), NO_SELECTION)
    await settleEmpty()
    expect(queryTrigger()).toBeNull()
  })

  it('非 CodeBuddy provider 时不订阅共享读数（不为无关模型打网关）', async () => {
    const usage = vi.fn(async () => ok({ loggedIn: true, view }))
    renderPill(makeRemote({ usage }), 'deepseek')
    await settleEmpty()
    expect(usage).not.toHaveBeenCalled()
  })

  it('点击打开 Modal，指标与插件配置页同源（圆环中心 + 三环图例）', async () => {
    renderPill(makeRemote())
    await settle()

    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(trigger())
    const dialog = within(screen.getByRole('dialog'))
    // 圆环的图例与配置卡片共用 UsageMetrics：中心是总剩余，图例是已用/本月/按天。
    // 本用例的 details 为空——没有可成的段，天分区（标题 + 天行）整个不渲染，
    // 所以只断言剩下不动的两行。这里逐个断言键而不是查文案：旧用例断的
    // tomorrowExpiring 与曾经的 expiringDay0 文案相同，只查文案会「因为巧合而
    // 通过」，查不到标签是否真的换了。
    for (const key of ['totalUsed', 'monthSize'] as const) {
      expect(dialog.getByText(en[key]), key).toBeTruthy()
    }
    // 天分区缺席：标题也不应出现（全空时整个分区隐藏，不是留空标题）。
    expect(dialog.queryByText(en.expiryByDay)).toBeNull()
    // 数字同样来自同一份 view：中心总剩余 1000、整体 1000 / 2000、本月 40 / 400。
    expect(dialog.getByText('1000')).toBeTruthy()
    expect(dialog.getByText('1000 / 2000')).toBeTruthy()
    expect(dialog.getByText('40 / 400')).toBeTruthy()
  })

  it('弹层带上加宽类，让指标数字不换行', async () => {
    // 官方 .dialog 固定 380px（内容列 332px），放不下「圆环 + 图例」也放不下指标数字。
    renderPill(makeRemote())
    await settle()
    fireEvent.click(trigger())
    expect(screen.getByRole('dialog').className).toContain('cb-usage-modal')
  })

  it('弹层把圆环居中（插件详情页则保持左对齐）', async () => {
    // 用户报的「弹窗里同心圆没有居中」：内容列放不下时图例换行，圆环会靠左挂着。
    // 居中写在弹窗这条 CSS 规则里、而不是组件自带——详情页其余各行左对齐，
    // 整组居中会与上下文脱节。jsdom 不做布局，所以这里断言**规则存在且范围正确**。
    //
    // 样式由插件的 apply() 在加载时注入（`ensurePluginCss`），入口是 CodeBuddyTab；
    // 本文件只渲染胶囊，所以显式走一次同一条注入路径，而不是假设副作用已经发生。
    ensurePluginCss()
    renderPill(makeRemote())
    await settle()
    fireEvent.click(trigger())
    const dialog = screen.getByRole('dialog')
    const css = Array.from(dialog.ownerDocument.querySelectorAll('style[data-plugin-css]'))
      .map(node => node.textContent ?? '')
      .join('\n')
    expect(css).toContain('.cb-usage-modal [data-usage-rings]{justify-content:center}')
    // 弹窗整列居中；圆环自身的样式不带居中（插件页保持左对齐，见 UsageRings 用例）。
    expect(css).toContain('.cb-usage-modal .cb-usage-body{display:flex;flex-direction:column;gap:12px;align-items:center}')
  })

  it('说明是一行：更新时间 + 刷新周期，不带订阅时长等冗余文案', async () => {
    renderPill(makeRemote())
    await settle()
    fireEvent.click(trigger())
    const dialog = within(screen.getByRole('dialog'))
    const note = dialog.getByText(new RegExp(en.composerUsageHint))
    expect(note.className).toContain('cb-usage-note')
    // 固定格式 YYYY/MM/DD HH:mm:ss，不随 locale 吐长文本把单行挤成两行。
    expect(note.textContent).toMatch(/\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}/)
  })

  it('打开弹窗时主动读一次，关闭不产生额外请求', async () => {
    // 打开是「用户现在就要看」的显式意图：等下一轮客户端定时器（10 秒）才更新是错的，
    // 弹出的可能是一分钟前的数字。关闭则不该有任何请求。
    const usage = vi.fn(async () => ok({ loggedIn: true, view }))
    renderPill(makeRemote({ usage }))
    await settle()
    expect(usage).toHaveBeenCalledTimes(1)

    fireEvent.click(trigger())
    expect(screen.queryByRole('dialog')).not.toBeNull()
    await waitFor(() => { expect(usage).toHaveBeenCalledTimes(2) }) // 打开触发的重读

    fireEvent.click(within(screen.getByRole('dialog')).getByLabelText('close'))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(usage).toHaveBeenCalledTimes(2)
  })

  it('点圆心签到：成功则圆心铺色、按钮停用，并刷新读数', async () => {
    // 用户的要求串成一条：点圆心 → 签到成功 → 颜色变了（圆心铺填充）→ 读数刷新。
    let checked = false
    const usage = vi.fn(async () => ok({ loggedIn: true, view }))
    const checkin = vi.fn(async () => {
      checked = true
      return ok({ success: true, credit: 100, streakDays: 21 })
    })
    const checkinStatus = vi.fn(async () => ok({
      available: true, active: true, checkedIn: checked, streakDays: 20, dailyCredit: 100, todayCredit: 0,
    }))
    renderPill(makeRemote({ usage, checkin, checkinStatus }))
    await settle()
    fireEvent.click(trigger())
    // 用弹层元素本身做 DOM 查询：within() 只给角色查询，不给 querySelector。
    const dialog = screen.getByRole('dialog')
    await waitFor(() => { expect(dialog.querySelector('.cb-checkin-hit')).not.toBeNull() })

    // 未签到时圆心可点，且没有填充层。
    const hit = dialog.querySelector('.cb-checkin-hit') as HTMLButtonElement
    expect(hit.disabled).toBe(false)
    expect(dialog.querySelector('[data-checkin-layer]')).toBeNull()

    fireEvent.click(hit)
    // 签到成功后：圆心铺上填充色、按钮停用（已签到点击不响应）。
    await waitFor(() => { expect(dialog.querySelector('[data-checkin-layer]')).not.toBeNull() })
    expect((dialog.querySelector('.cb-checkin-hit') as HTMLButtonElement).disabled).toBe(true)
    expect(checkin).toHaveBeenCalledTimes(1)
    // 读数刷新：签到加了积分，额度读数过期。
    await waitFor(() => { expect(usage.mock.calls.length).toBeGreaterThan(2) })
  })

  it('签到失败才提示；成功不提示', async () => {
    const checkin = vi.fn(async () => ok({ success: false, message: '活动未开启', credit: 0, streakDays: 0 }))
    renderPill(makeRemote({ checkin }))
    await settle()
    fireEvent.click(trigger())
    const dialog = screen.getByRole('dialog')
    await waitFor(() => { expect(dialog.querySelector('.cb-checkin-hit')).not.toBeNull() })
    fireEvent.click(dialog.querySelector('.cb-checkin-hit') as HTMLButtonElement)

    // 失败：出现提示，且圆心不变色（没有填充层）。
    await waitFor(() => { expect(screen.getByRole('status')).not.toBeNull() })
    expect(screen.getByRole('status').textContent).toContain(en.checkinFailed)
    expect(screen.getByRole('status').textContent).toContain('活动未开启')
    expect(dialog.querySelector('[data-checkin-layer]')).toBeNull()
  })

  it('弹窗开着时后台刷新失败，弹窗不会凭空消失', async () => {
    const usage = vi.fn(async () => ok({ loggedIn: true, view }))
    renderPill(makeRemote({ usage }))
    await settle()
    fireEvent.click(trigger())
    expect(screen.queryByRole('dialog')).not.toBeNull()
    // 先等「打开时主动读一次」落地，否则随后那次刷新会被单飞守卫跳过，
    // 用例测的就不是「后台刷新失败」这条路径了。
    await waitFor(() => { expect(usage).toHaveBeenCalledTimes(2) })

    usage.mockRejectedValueOnce(new Error('gateway down'))
    usageFeedOf().refresh()
    await waitFor(() => { expect(usage).toHaveBeenCalledTimes(3) })

    // 弹窗还在（回归点），且数字确实清空了——此时给出「暂时读不到」
    // 而不是一串过期的旧数字。
    expect(screen.queryByRole('dialog')).not.toBeNull()
    await waitFor(() => {
      expect(within(screen.getByRole('dialog')).getByText(en.composerUsageUnavailable)).toBeTruthy()
    })
  })

  it('开关关闭时不渲染胶囊，也不产生任何外呼', async () => {
    const usage = vi.fn(async () => ok({ loggedIn: true, view }))
    renderPill(makeRemote({ usage, composer: false }))
    await settleEmpty()
    expect(queryTrigger()).toBeNull()
    expect(usage).not.toHaveBeenCalled()
  })

  it('未登录时不渲染胶囊（不占输入框工具行的视觉重量）', async () => {
    renderPill(makeRemote({ usage: async () => ok({ loggedIn: false }) }))
    await settleEmpty()
    expect(queryTrigger()).toBeNull()
  })

  it('读失败时不渲染胶囊，等下一轮或登录态变化重试', async () => {
    renderPill(makeRemote({ usage: async () => { throw new Error('gateway down') } }))
    await settleEmpty()
    expect(queryTrigger()).toBeNull()
  })

  it('按钮的 aria-label 带出本月剩余，读屏用户不必打开弹层', async () => {
    renderPill(makeRemote())
    await settle()
    expect(trigger().getAttribute('aria-label')).toContain('360')
  })
})

describe('ComposerUsage 面对旧 host', () => {
  it('getSettings 不含 showComposerUsage 时按 schema 默认（开）显示', async () => {
    // host 与 client 是两个独立产物：浏览器 bundle 可经 HMR 单独替换。
    // 字段缺失必须回落到 schema 默认值（开），而不是让三态判定把「字段缺失」
    // 永远当成「还没读到偏好」，导致胶囊永不出现。
    const remote = {
      usage: async () => ok({ loggedIn: true, view }),
      getSettings: async () => ok({ showUsage: true, webSearch: false }),
    }
    renderPill(remote)
    await settle()
    expect(trigger().textContent).toContain('CodeBuddy')
  })
})

describe('说明行的文案', () => {
  it('渲染成「更新于 <时刻> 读数每 60 秒刷新一次」，单行且无分隔符', async () => {
    // 60 秒是**宿主**拉取的周期（USAGE_CACHE_TTL_MS），不是客户端轮询周期。
    // 客户端每 10 秒来问一次只让它更早看到已刷新出来的值，数据年龄上限不变——
    // 这句文案必须说 60 秒，否则等于告诉用户数字最多只有 10 秒旧。
    renderPill(makeRemote())
    await settle()
    fireEvent.click(trigger())
    const note = within(screen.getByRole('dialog')).getByText(new RegExp(en.composerUsageHint))
    expect(note.textContent).toBe(
      `${en.composerUsageUpdated} 2023/11/15 06:13:20 ${en.composerUsageHint}`)
    expect(en.composerUsageHint).toContain('60')
  })

  it('文案里的秒数是宿主 TTL，不是客户端轮询周期（两个数不能混）', async () => {
    // 这两个周期是**不同**的东西，用户最容易看错，代码注释也踩过坑：
    //   · 客户端 USAGE_REFRESH_MS  = 10 秒：每 10 秒向宿主问一次读数
    //   · 宿主   USAGE_CACHE_TTL_MS = 60 秒：宿主多久真的去打一次 CodeBuddy
    // 弹窗里这句说明描述的是**数据年龄上限**，所以必须写宿主 TTL。
    // 写成客户端的 10 秒，等于告诉用户数字最多只有 10 秒旧——是错的。
    // 这里把两个数都从常量算出来比对，改任一侧或改文案都会红。
    const hostSeconds = USAGE_CACHE_TTL_MS / 1000
    const clientSeconds = USAGE_REFRESH_MS / 1000
    expect(hostSeconds).not.toBe(clientSeconds)
    // zh 用「秒」，en 用「seconds」——两侧都要绑到宿主 TTL。
    expect(zh.composerUsageHint).toContain(`${hostSeconds} 秒`)
    expect(en.composerUsageHint).toContain(`${hostSeconds} seconds`)
    // 文案里不能出现客户端的 10 秒：那会把数据年龄上限说小 6 倍。
    expect(zh.composerUsageHint).not.toContain(`${clientSeconds} 秒`)
    expect(en.composerUsageHint).not.toContain(`${clientSeconds} seconds`)
  })
})
