/**
 * 输入框工具行（模型选择器左侧）的额度胶囊：`CodeBuddy · 本月用量 x%`。
 *
 * 位置是官方 slot `conversation.input.right`（kind: list，replaceRisk: none）：
 * 宿主在 composer 的 standardControls 里 `renderSlot('conversation.input.right', {})`
 * 然后才渲染模型选择器，所以胶囊正好落在它左边，与 opencode-go 的同伴并存。
 *
 * 三件事刻意如此：
 *
 * 1. **只在选中 CodeBuddy 模型时出现**。额度是 CodeBuddy 账号的属性，用别的
 *    provider 时它既不相关也无意义。判据取自宿主的 `modelSelection` projection
 *    （会话已确认的选择），不自己猜 provider 列表——同 provider 判定由宿主
 *    的投影负责，插件只读结论。
 * 2. **读数来自共享轮询器**（`usage-feed`），与侧栏指示器共用同一次请求。
 * 3. **弹层用官方 Modal**，指标正文与插件配置卡片共用 `UsageMetrics` 组件，
 *    两处渲染的字段因此必然一致。
 */
import { useCallback, useEffect, useState, useSyncExternalStore, createElement as h } from 'react'
import type { ReactNode } from 'react'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { CheckinResultView, CheckinStatusView, SettingsView, UsageResult } from '../remote-types.js'
import { CODEBUDDY_PROVIDER } from '../constants.js'
import { subscribeUsagePrefChange } from './notifiers.js'
import { formatCredits, unwrap } from './shared.js'
import { monthColor } from './palette.js'
import { toReading } from './usage-metrics.js'
import { EMPTY_USAGE_SNAPSHOT, usageFeed, type UsageSnapshot } from './usage-feed.js'
import { useCheckin } from './use-checkin.js'
import { UsageMetrics } from './CodeBuddyTab.jsx'

export interface ComposerUsageInjected {
  remote: {
    usage(): Promise<RemoteResult<UsageResult>>
    getSettings(): Promise<RemoteResult<SettingsView>>
    /** 今日签到态。 */
    checkinStatus(): Promise<RemoteResult<CheckinStatusView>>
    /** 执行今日签到。 */
    checkin(): Promise<RemoteResult<CheckinResultView>>
  }
  t: (key: string) => string
}

/**
 * 本地化走 inject 的 `t`（与 UsageIndicator 同款），不叠 `PropsLocale`：
 * 两处都声明 `t` 时组件 props 是两个函数类型的交叉，运行期谁胜出取决于
 * renderer 的组装顺序，读代码的人无法一眼判断，属于没必要的不确定。
 */
type Props = PropsRuntime<'conversation.input.right'> & InjectFace<ComposerUsageInjected>

/**
 * 胶囊本体。
 *
 * 门控叠加两层：**当前是 CodeBuddy 会话** 且 **偏好开关打开** 且 **有读数**。
 * 任一不成立就返回 null——未登录、还没读到、读失败同样不渲染：显示一个
 * 「--」或「暂不可用」的常驻胶囊，会把输入框工具行的视觉重量分给一个
 * 没有信息量的控件。
 */
export function ComposerUsage({ remote, t, useProjection }: Props): ReactNode {
  // 三态：undefined = 还没读到偏好。**不能**先用 true 起步——那会在每次会话
  // 开始时先订阅、先打一次网关，再把开关关掉；关掉本功能的用户不该为它付费。
  const [showUsage, setShowUsage] = useState<boolean | undefined>(undefined)
  const [open, setOpen] = useState<boolean>(false)

  useEffect(() => {
    let stopped = false
    void unwrap(remote.getSettings())
      // 旧 host 不发该字段 → 按 schema 默认（**开**）。写成 undefined 会让三态
      // 判定把「字段缺失」永远当成「还没读到」，胶囊永远不出现；回落值必须与
      // schema 默认一致，否则等于绕过用户的选择。
      .then(s => { if (!stopped) setShowUsage(s.showComposerUsage ?? true) })
      .catch(() => { if (!stopped) setShowUsage(true) })
    return () => { stopped = true }
  }, [remote])

  // 开关变化（设置页切换成功后 emitUsagePrefChange）：重读偏好并据此启停订阅。
  useEffect(() => subscribeUsagePrefChange(() => {
    void unwrap(remote.getSettings())
      .then(s => setShowUsage(s.showComposerUsage ?? true))
      .catch(() => setShowUsage(true))
  }), [remote])

  // 当前会话是否在用 CodeBuddy：读宿主的 modelSelection 投影（`next` 是「下一条
  // 请求将使用的选择」，已包含用户刚在模型选择器里做的切换）。`useProjection`
  // 是会话作用域的标准 prop；没有会话时它返回 undefined，等价于「不是」。
  const selection = useProjection('modelSelection')
  const isCodeBuddy = selection?.next?.provider === CODEBUDDY_PROVIDER

  const enabled = showUsage === true && isCodeBuddy
  // 未显示时不订阅共享 feed：关掉开关的入口不产生任何外呼，也不读别人的读数。
  const feed = usageFeed(remote)
  const snapshot: UsageSnapshot = useSyncExternalStore(
    enabled ? feed.subscribe : NO_SUBSCRIPTION,
    enabled ? feed.getSnapshot : noSnapshot,
    enabled ? feed.getSnapshot : noSnapshot,
  )

  const reading = snapshot.loggedIn ? toReading(snapshot.view) : undefined

  /**
   * 签到：弹层里的圆心可点。成功后重取读数（签到加了积分，额度变了）。
   *
   * `enabled` 跟胶囊同一个开关：关掉时既不订阅签到态、也不产生任何外呼。
   */
  const checkin = useCheckin(remote, t, { enabled, onSuccess: () => feed.read() })

  /**
   * 打开弹窗时**主动读一次**。
   *
   * 打开是「用户现在就要看」的显式意图，等下一轮 10 秒定时器才更新是错的——
   * 那意味着弹出的可能是一分钟前的数字。订阅本身已保证有新读数时会重渲染，
   * 这里只是不等待。请求落在宿主侧缓存上：TTL（60 秒）内的重复读取不会真的再打
   * CodeBuddy 网关，所以「点开就刷新」不会带来额外的出站成本。
   * 注意这次读取只能拿到宿主**已有**的那份读数——它不会让上游提前刷新，所以
   * 点开看到的数字仍可能最多有 60 秒旧（这与弹窗里「读数每 60 秒刷新一次」一致）。
   */
  const onOpen = useCallback(() => {
    setOpen(true)
    feed.read()
  }, [feed])

  // 关掉开关时连弹层一起关：否则用户会留下一个开着却不再更新的窗口。
  useEffect(() => { if (!enabled) setOpen(false) }, [enabled])

  // 弹窗的可见性只看 `open`，**不看 `reading`**：后者在一轮失败的刷新后会变
  // undefined，若参与判定就会让用户正看着的弹窗凭空消失（网关抖一下就关窗）。
  // 正文里的数字由 `reading` 单独决定是否渲染。
  if (!enabled) return null
  if (reading === undefined && !open) return null

  const pct = reading === undefined
    ? undefined
    : Math.round(Math.min(Math.max(reading.monthUsedRatio * 100, 0), 100))
  return h('span', null,
    // 按钮只在有读数时渲染：没有数字可显示时，一个「CodeBuddy · --」的胶囊
    // 只是占位噪音。
    reading === undefined ? null : h('button', {
      type: 'button',
      className: 'cb-pill',
      'aria-haspopup': 'dialog',
      'aria-expanded': open,
      'aria-label': `${t('composerUsageTitle')}: ${t('monthPoolRemain')} ${formatCredits(reading.monthRemain)}`,
      title: `${t('totalBalance')}: ${formatCredits(reading.totalBalance)}`,
      onClick: onOpen,
    },
      h('span', { className: 'cb-pill-dot', style: { background: usageColor(reading.monthUsedRatio) } }),
      // 用专门的短标签（「本月」/「month」）而不是 monthUsedRate 那句完整
      // 措辞：触发按钮与模型选择器同处一行，长文案会把工具行挤到换行。
      `CodeBuddy · ${t('composerUsageShort')} ${pct}%`,
    ),
    h(Modal, {
      open,
      onClose: () => { setOpen(false) },
      title: t('composerUsageTitle'),
      closeLabel: t('composerUsageClose'),
      // 宽度由 .cb-usage-modal 覆盖官方 .dialog 的 380px：内容列放得下
      // 「标签 + 不换行的数字」。
      className: 'cb-usage-modal',
    },
      h('div', { className: 'cb-usage-body' },
        // 指标正文与插件配置卡片是同一个组件：两处入口渲染完全相同的字段。
        // 只在真有读数时渲染：一轮失败的刷新会把 view 清空，那时给「暂无数据」
        // 比给一串上一秒还正确的旧数字更诚实。
        snapshot.view === undefined
          ? h('p', { className: 'cb-usage-error' }, t('composerUsageUnavailable'))
          : h(UsageMetrics, { view: snapshot.view, t, checkin }),
        // 单行说明：「更新于 <时刻> 读数每 60 秒刷新一次」。
        // 不要再加分隔符或补语——文案要短到能稳定占一行（.cb-usage-note 带 nowrap）。
        // 也不能替用户把「界面每 10 秒取一次」补进去：那句话量出来 408px，会撑破窄弹窗。
        snapshot.updatedAt === undefined
          ? null
          : h('p', { className: 'cb-usage-note' },
              `${t('composerUsageUpdated')} ${formatTimestamp(snapshot.updatedAt)} ${t('composerUsageHint')}`,
            ),
      ),
    ),
    // 失败提示条浮在页面顶端（Toast 自己走 portal），与胶囊并列渲染。
    checkin.toast,
  )
}

/**
 * 时间戳格式化：固定 `YYYY/MM/DD HH:mm:ss`，不随运行环境 locale 变。
 *
 * 用固定格式而不是 `toLocaleString()`：后者在窄弹层里可能吐出「2026年9月26日
 * 下午3:55:40」这类长文本，把单行说明挤成两行——而「保持一行」正是这次的要求。
 */
function formatTimestamp(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} `
    + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/**
 * 胶囊圆点的语义色：直接复用侧栏的**月度预警档位**（`monthColor`）。
 *
 * 刻意不用 `var(--dsw-alias-state-*)`：主题别名会解析回高饱和系统色
 * （#e5484d 之类），把整套莫兰迪灰调覆盖掉——见 palette.ts 的说明。而且此处
 * 要表达的就是「本月花得快不快」，与侧栏那个数字是同一个信号，同源才读得一致。
 */
function usageColor(ratio: number): string {
  return monthColor(ratio)
}

/** 关闭态：不订阅任何东西，也不读共享读数（开关关掉的入口零成本）。 */
const NO_SUBSCRIPTION = (): (() => void) => () => {}
const noSnapshot = (): UsageSnapshot => EMPTY_USAGE_SNAPSHOT
