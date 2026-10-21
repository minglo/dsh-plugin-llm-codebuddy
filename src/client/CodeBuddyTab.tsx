import { useEffect, useCallback, useRef, useState, createElement as h, Fragment } from 'react'
import type { ReactNode } from 'react'
import { Button, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { CheckinResultView, CheckinStatusView, LoginPoll, LoginStart, SearchBackendState, SettingsView, StatusView, UsageResult, UsageView } from '../remote-types.js'
import { finiteOr, unwrap, withTimeout } from './shared.js'
import { MORANDI } from './palette.js'
import { UsageRings } from './UsageRings.jsx'
import { emitLoginChange, emitUsagePrefChange } from './notifiers.js'
import { useCheckin, type CheckinBinding } from './use-checkin.js'
import { LOGIN_TIMEOUT_MS } from '../constants.js'

/** 配置卡片单次远程读取的硬超时：host 挂住时不能让卡片永远停在加载态。 */
const READ_TIMEOUT_MS = 15_000

export interface CodeBuddyTabInjected {
  remote: {
    status(): Promise<RemoteResult<StatusView>>
    usage(): Promise<RemoteResult<UsageResult>>
    startLogin(): Promise<RemoteResult<LoginStart>>
    pollLogin(state: string): Promise<RemoteResult<LoginPoll>>
    logout(): Promise<RemoteResult<void>>
    getSettings(): Promise<RemoteResult<SettingsView>>
    /** 今日签到态。 */
    checkinStatus(): Promise<RemoteResult<CheckinStatusView>>
    /** 执行今日签到。 */
    checkin(): Promise<RemoteResult<CheckinResultView>>
  }
  setShowUsage(showUsage: boolean): Promise<void>
  /** 输入框工具行里的额度胶囊开关。 */
  setShowComposerUsage(showComposerUsage: boolean): Promise<void>
  /** 遇到 429 是否等待到重置时刻再重试。 */
  setWaitOnRateLimit(waitOnRateLimit: boolean): Promise<void>
  setWebSearch(webSearch: boolean): Promise<void>
  t: (key: string) => string
}

type Props = PropsRuntime<'plugins.bundle.config'> & PropsLocale<'settings.codebuddy'> & InjectFace<CodeBuddyTabInjected>
type Translate = Props['t']

type Phase = 'loading' | 'idle' | 'error'

/**
 * `plugins.item` 的 page 视图是**裸配置正文**，不是又一张卡片：列表卡片与详情页的
 * 标题、图标、返回面包屑都由 Plugins 页自己绘制（slot-contract.d.ts：
 * "The page draws the title, icon, and crumb itself"）。此前这里复刻了
 * `settings.plugins.tab` 时代的折叠外壳，浏览器里表现为详情页又嵌一张默认折叠、
 * 标题重复的卡片——配置全藏在折叠后的 body 里，用户读到的是「没有可配置的位置」。
 */
const CARD_CSS = `
.cb-body{display:flex;flex-direction:column}
.cb-setting-head{display:flex;align-items:center;gap:8px}

/* 设置行：取值逐字抄自官方 @deepseek-ai/dsh-client-ui-settings-general 的
   DeveloperToolsRow（.row/.title/.description），开关控件本身用官方 Switch 原语。
   抄而不是"照着自己写一个"，是为了让本卡片的开关行与官方设置页逐像素一致，
   以后官方调整尺寸/间距也能一眼看出该跟着改哪里。 */
.cb-setting-group{display:flex;flex-direction:column}
.cb-setting-row{border-bottom:.5px solid var(--dsw-alias-border-l2);justify-content:space-between;align-items:center;gap:24px;padding:16px 0;display:flex}
/* 官方行是分隔线列表的一员，总有一条线在其后；本卡片里最后一行就是组尾，
   留着会变成一条悬空的分隔线，故只在这里抑制。 */
.cb-setting-row:last-child{border-bottom:0}
/* 官方 .title 不写颜色（继承文档基色）。这里显式取同一个 token：
   本卡片的容器不是官方设置文档，继承色不保证一致。 */
.cb-setting-title{font-size:14px;line-height:20px;color:var(--dsw-alias-label-primary)}
.cb-setting-desc{color:var(--dsw-alias-label-secondary);margin-top:4px;font-size:12px;line-height:18px}

/* 输入框胶囊的触发按钮。悬停底色只能用真 CSS：inline style 无法表达 :hover，
   而且 inline 的 background 会盖过任何样式表规则（特异性最高的那一种）。
   颜色取主题交互底色 token，深浅两套主题各自成立。 */
.cb-pill{border:0;cursor:pointer;background:transparent;color:var(--dsw-alias-label-secondary);
  font:inherit;font-size:12px;line-height:20px;padding:4px 6px;border-radius:6px;white-space:nowrap;
  display:inline-flex;align-items:center;gap:5px;transition:background 120ms ease,color 120ms ease}
.cb-pill:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.16));color:var(--dsw-alias-label-primary)}
.cb-pill:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.cb-pill-dot{width:6px;height:6px;border-radius:999px;flex:none}

/* 额度弹层：官方 Modal 的 .dialog 固定 width:min(380px,100%)、.body 两侧各 24px
   内边距。圆环与图例并排需要「220px 圆环 + 18px 间距 + 图例宽」；图例宽＝
   色块 8 + 标签 + 数值 + 百分比 36 + 3×列间距 8，其中标签是最长的一项：
   英文 "Expiring this month" ≈ 118px、中文「本月到期」≈ 60px。
   按排版量出来：英文需要内容列 489px、中文 431px。取 560px（内容列 512px）
   让两种语言都能并排——比英文所需多 23px，留给宿主字体与 12px 字号的实际差异。
   窄屏下 min() 自适应，此时图例换行、圆环由 .cb-usage-body 的
   justify-content:center 居中（不会像修之前那样挂在左边）。
   选择器只作用于「带本类的 dialog」，不碰宿主其它弹窗。 */
.cb-usage-modal{width:min(560px,100%)}
.cb-usage-modal .cb-usage-body{display:flex;flex-direction:column;gap:12px;align-items:center}
/* 弹窗里圆环要居中，**插件页则保持左对齐**：详情页其余各行（用户 ID、开关…）都是
   左对齐的，把圆环整组摆到卡片中间会与上下文脱节。窄弹窗下两者换行，此时圆环独占
   一行，也必须居中——所以居中是加在弹窗这一层的，不是组件自带的。 */
.cb-usage-modal [data-usage-rings]{justify-content:center}
/* 说明文字要占满整宽才能保持单行（nowrap 在窄容器里会被迫溢出），所以单独给宽度。 */
.cb-usage-modal .cb-usage-note,.cb-usage-modal .cb-usage-error{width:100%;text-align:center}
.cb-usage-note{margin:0;font-size:12px;color:var(--dsw-alias-label-secondary);line-height:1.6;white-space:nowrap}
.cb-usage-error{margin:0;font-size:13px;color:var(--dsw-alias-label-secondary);line-height:1.6}
`
const CARD_CSS_TAG = 'dsh-plugin-llm-codebuddy/card.module.css'

function injectCardCss(): void {
  if (typeof document === 'undefined') return
  if (document.querySelector(`style[data-plugin-css=${JSON.stringify(CARD_CSS_TAG)}]`) !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-plugin-llm-codebuddy'
  tag.dataset.pluginCss = CARD_CSS_TAG
  tag.textContent = CARD_CSS
  document.head.appendChild(tag)
}

/** 胶囊也用到同一张样式表（.cb-pill 的 hover、.cb-usage-modal 的宽度）。 */
export function ensurePluginCss(): void {
  injectCardCss()
}

const s = {
  section: { display: 'flex', flexDirection: 'column' as const, gap: '12px', padding: '8px 0' },
  muted: { margin: 0, color: 'var(--dsw-alias-label-secondary)', fontSize: '14px' },
  error: { margin: 0, color: MORANDI.urgent, fontSize: '14px' },
  row: { display: 'flex', alignItems: 'center', gap: '12px', padding: '8px 0' },
  rowLabel: { color: 'var(--dsw-alias-label-secondary)', fontSize: '14px', minWidth: '160px' },
  rowValue: { color: 'var(--dsw-alias-label-primary)', fontSize: '14px', flex: 1, wordBreak: 'break-all' as const },
  // 额度行的标签比身份行短得多（「已用积分」4 字），沿用 160px 会把数字挤到换行。
  // 数字还额外 nowrap + 等宽数字：换行会把「1000 / 2000」读成两个数。
  actions: { display: 'flex', gap: '8px', marginTop: '8px' },
  // 生效态徽标：小圆点承载状态色，文字保持中性——避免整块彩色抢走标题注意力。
  badge: { display: 'inline-flex', alignItems: 'center', gap: '5px', flexShrink: 0, padding: '1px 8px', border: '.5px solid var(--dsw-alias-border-l2)', borderRadius: '999px', color: 'var(--dsw-alias-label-secondary)', fontSize: '11px', lineHeight: '16px', whiteSpace: 'nowrap' as const },
  badgeDot: { width: '6px', height: '6px', borderRadius: '999px', flexShrink: 0 },
}

function StatusRow({ label, value }: { label: string; value: string }) {
  return h('div', { style: s.row }, h('span', { style: s.rowLabel }, label), h('span', { style: s.rowValue }, value))
}

/**
 * 额度指标正文：同心圆环（中心总剩余，自内向外＝已用积分 / 本月到期 / 未来 7 天分段）。
 *
 * 抽成独立组件是为了让**两处入口渲染完全相同的指标**：插件配置卡片，以及
 * 输入框旁胶囊点开的弹层。用户在两处看到的是同一份额度，任何一处多一条少一条
 * 都会让人怀疑「哪个才是真的」。
 *
 * 旧 host（缺 totalSize / monthPool）**仍然渲染圆环**——它优雅降级（空轨、7 个空段），
 * 比整块消失好；但必须在上面挂一句「暂时读不到」，否则图例里那个 `50 / 0` 会被
 * 当成真实的「总额度是 0」。判据取两个分母都缺失，而不是原来的 `totalSize > 0`：
 * 那只够判断整体口径，而圆环还依赖本月口径。
 *
 * @param props - 读数、翻译函数，以及签到接线（缺省 = 圆心不可点）。
 */
export function UsageMetrics({ view, t, checkin }: {
  view: UsageView
  t: Translate
  /** 签到接线；给出时圆心可点。 */
  checkin?: CheckinBinding
}): ReactNode {
  const degraded = finiteOr(view.totalSize, 0) <= 0 && finiteOr(view.monthPool?.size, 0) <= 0
  return h(Fragment, null,
    degraded ? h('p', { style: s.muted }, t('usageError')) : null,
    h(UsageRings, {
      view,
      t,
      checked: checkin?.checked === true,
      // 只有「读得到状态且账号参与活动」才给入口；否则圆心是纯展示。
      ...(checkin?.available === true
        ? { onCheckin: checkin.onCheckin, checkinPending: checkin.pending }
        : {}),
    }),
  )
}

/**
 * 生效态徽标：搜索此刻到底走的是谁。读 host 报来的**实际**选择字段，而非开关
 * 意图——「开关开着但未登录」这类意图与效果不一致的情况，正是用户要确认的。
 * 三态各自带自己的颜色与文案，不靠颜色单独表意（色盲与深浅色主题下都能读）。
 */
function searchBadge(state: SearchBackendState, t: Translate): ReactNode {
  const view: Record<SearchBackendState, { label: string; color: string }> = {
    codebuddy: { label: t('searchOn'), color: MORANDI.ok },
    default: { label: t('searchOff'), color: MORANDI.neutral },
    unavailable: { label: t('searchBlocked'), color: MORANDI.blocked },
  }
  const { label, color } = view[state]
  // 类名 cb-badge 没有对应的 CSS 规则——样式全部来自下面的内联 s.badge。
  // 它保留是因为测试用它定位这枚徽标（CodeBuddyTab.test.tsx 有三处选择器）；
  // 删掉它会让那三条断言静默失去目标。
  return h('span', { className: 'cb-badge', style: s.badge, title: t('searchBadgeHint') },
    h('span', { style: { ...s.badgeDot, background: color } }),
    label,
  )
}

export function CodeBuddyTab(props: Props): ReactNode {
  // `plugins.bundle.config` 只渲染 `page` 视图（契约原文：`view: 'page'` only），
  // 卡片标题/简介由 Plugins 页按包的 locale 元数据绘制，故这里不再有 summary 分支。
  const { remote, setShowUsage, setShowComposerUsage, setWaitOnRateLimit, setWebSearch, t } = props
  return h(CodeBuddyTabBody, { remote, setShowUsage, setShowComposerUsage, setWaitOnRateLimit, setWebSearch, t })
}

/**
 * 正文只吃注入面，不吃 owner/标准 props。
 *
 * 不能写成 `Omit<Props, 'view' | 'form'>`：`Props` 里含 `PropsRuntime`，而
 * `PropsRuntime` 会随任一被 import 的客户端包（ui-session、ui-conversation…）
 * 合并进来的 `GlobalStandardProps`（useSessions / useWorkspaces…）一起变长——
 * 只要本包再多类型引用一个客户端包，这里就会突然少几个「必填」prop 而编译失败。
 * 正文本来就不使用它们，直接按注入面声明即可。
 */
function CodeBuddyTabBody({ remote, setShowUsage, setShowComposerUsage, setWaitOnRateLimit, setWebSearch, t }: CodeBuddyTabInjected): ReactNode {
  const [phase, setPhase] = useState<Phase>('loading')
  const [status, setStatus] = useState<StatusView | undefined>(undefined)
  const [usage, setUsage] = useState<UsageView | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [loginState, setLoginState] = useState<string | undefined>(undefined)
  // 三个开关的初值都与 schema 默认一致（showUsage 关 / showComposerUsage 开 /
  // waitOnRateLimit 关）：读取偏好前的首帧不能显示成相反的状态，否则开关会先亮
  // 一下再跳回去，用户看到的是自己的设置被短暂改写。
  const [showUsagePref, setShowUsagePref] = useState<boolean>(false)
  const [showComposerUsagePref, setShowComposerUsagePref] = useState<boolean>(true)
  const [waitOnRateLimitPref, setWaitOnRateLimitPref] = useState<boolean>(false)
  const [webSearchPref, setWebSearchPref] = useState<boolean>(false)
  const [searchBackend, setSearchBackend] = useState<SearchBackendState | undefined>(undefined)
  const starting = useRef(false)

  const refresh = useCallback(async () => {
    try {
      const st = await withTimeout(unwrap(remote.status()), READ_TIMEOUT_MS)
      setStatus(st)
      // 每次 status 都刷新徽标：登录态、开关、接管三者的变化都汇集于此。
      setSearchBackend(st.searchBackend)
      if (st.loggedIn) {
        const u = await withTimeout(unwrap(remote.usage()), READ_TIMEOUT_MS)
        setUsage(u.loggedIn ? u.view : undefined)
      }
      setPhase('idle')
    } catch {
      setError(t('usageError'))
      setPhase('error')
    }
  }, [remote, t])

  useEffect(() => { void refresh() }, [refresh])

  // 签到：圆心可点。成功后重取读数（签到加了积分，额度变了）。
  const checkin = useCheckin(remote, t, { onSuccess: refresh })

  // 开关初值：读远程 getSettings；失败沿用 schema 默认
  // （showUsage 关 / showComposerUsage 开 / waitOnRateLimit 关 / webSearch 关）。
  useEffect(() => {
    let stopped = false
    unwrap(remote.getSettings())
      .then(value => {
        if (stopped) return
        setShowUsagePref(value.showUsage ?? false)
        // 旧 host 不发该字段 → 按 schema 默认（开）。
        setShowComposerUsagePref(value.showComposerUsage ?? true)
        // 旧 host 不发该字段 → 按 schema 默认（关）。
        setWaitOnRateLimitPref(value.waitOnRateLimit ?? false)
        setWebSearchPref(value.webSearch)
      })
      .catch(() => { /* 读取失败：保留默认值，等待用户显式切换 */ })
    return () => { stopped = true }
  }, [remote])

  useEffect(() => {
    if (loginState === undefined) return
    const startedAt = Date.now()
    let stopped = false
    const tick = async (): Promise<void> => {
      if (stopped) return
      try {
        const result = await unwrap(remote.pollLogin(loginState))
        if (stopped) return
        if (result.done) { setLoginState(undefined); await refresh(); emitLoginChange(); return }
        if (Date.now() - startedAt >= LOGIN_TIMEOUT_MS) {
          setLoginState(undefined); setError(t('timeout')); setPhase('error'); return
        }
        // 仅成功/仍在轮询时续排；出错不续排（下方 catch 收尾）。
        window.setTimeout(tick, 1500)
      } catch {
        if (stopped) return
        setLoginState(undefined)
        setError(t('loginError'))
        setPhase('error')
      }
    }
    void tick()
    return () => { stopped = true }
  }, [loginState, remote, refresh, t])

  const startLogin = useCallback(async () => {
    if (starting.current) return // 双击守卫：in-flight 期间忽略后续点击
    starting.current = true
    setError(undefined)
    try {
      const start = await unwrap(remote.startLogin())
      window.open(start.authUrl, '_blank', 'noopener')
      setLoginState(start.state)
    } catch {
      setError(t('loginError'))
      setPhase('error')
    } finally {
      starting.current = false
    }
  }, [remote, t])

  const toggleShowUsage = useCallback(async (next: boolean) => {
    setShowUsagePref(next) // 乐观更新
    try {
      await setShowUsage(next)
      emitUsagePrefChange() // 通知侧边栏指示器重读开关
    } catch {
      setShowUsagePref(!next) // 失败回滚
      setError(t('usageError'))
    }
  }, [setShowUsage, t])

  const toggleShowComposerUsage = useCallback(async (next: boolean) => {
    setShowComposerUsagePref(next) // 乐观更新
    try {
      await setShowComposerUsage(next)
      emitUsagePrefChange() // 通知输入框胶囊重读开关
    } catch {
      setShowComposerUsagePref(!next) // 失败回滚
      setError(t('usageError'))
    }
  }, [setShowComposerUsage, t])

  const toggleWaitOnRateLimit = useCallback(async (next: boolean) => {
    setWaitOnRateLimitPref(next) // 乐观更新
    try {
      await setWaitOnRateLimit(next)
      // 不刷 status：429 开关只影响下一次请求的裁决，界面没有要随之更新的徽标。
    } catch {
      setWaitOnRateLimitPref(!next) // 失败回滚
      setError(t('usageError'))
    }
  }, [setWaitOnRateLimit, t])

  const toggleWebSearch = useCallback(async (next: boolean) => {
    setWebSearchPref(next) // 乐观更新
    try {
      await setWebSearch(next)
      // 开关提交后 host 已同步接管/让出（settings onChange → webSync.setEnabled），
      // 重读 status 让徽标立刻反映新后端，而不是等下一次挂载。
      await refresh()
    } catch {
      setWebSearchPref(!next) // 失败回滚
      setError(t('usageError'))
    }
  }, [setWebSearch, refresh, t])

  const logout = useCallback(async () => {
    try {
      await unwrap(remote.logout())
      setStatus({ loggedIn: false })
      setUsage(undefined)
      emitLoginChange()
    } catch {
      setError(t('loginError'))
      setPhase('error')
    }
  }, [remote, t])

  useEffect(() => { injectCardCss() }, [])

  const signedIn = status?.loggedIn === true

  /**
   * 一行「标题 + 说明 + 开关」，与官方设置页同构：左侧文字块，右侧开关原语。
   *
   * 开关用官方 `Switch`（`@deepseek-ai/dsh-client-ui-primitives`）而不是自绘——
   * 自绘版要自己维护轨道/滑块的尺寸与配色，且没有焦点环，深浅两套主题下容易漂移。
   * 官方原语的 `onChange` 直接给出**目标状态**，所以这里把值透传给调用方，
   * 不再让调用点各自写一次 `!current`（那是双重取反，容易错）。
   */
  const settingSwitch = (label: string, desc: string, on: boolean, onChange: (next: boolean) => void, badge?: ReactNode): ReactNode =>
    h('div', { className: 'cb-setting-row' },
      h('div', null,
        h('div', { className: 'cb-setting-head' },
          h('span', { className: 'cb-setting-title' }, label),
          badge ?? null,
        ),
        h('div', { className: 'cb-setting-desc' }, desc),
      ),
      h(Switch, { checked: on, onChange, label }),
    )

  const switchRow = settingSwitch(t('showUsage'), t('showUsageDesc'), showUsagePref, next => { void toggleShowUsage(next) })

  // 输入框胶囊开关：与侧栏开关分成两行——两处入口的诉求不同，用户常常只想要
  // 其中一个（侧栏常驻读数 vs 输入框旁随手可点）。同一份 emitUsagePrefChange
  // 通知，两个入口各自重读自己关心的字段。
  const composerUsageRow = settingSwitch(
    t('showComposerUsage'),
    t('showComposerUsageDesc'),
    showComposerUsagePref,
    next => { void toggleShowComposerUsage(next) },
  )

  // 429 等待开关：请求策略，与登录态无关，故不随 signedIn 隐藏。
  const waitOnRateLimitRow = settingSwitch(
    t('waitOnRateLimit'),
    t('waitOnRateLimitDesc'),
    waitOnRateLimitPref,
    next => { void toggleWaitOnRateLimit(next) },
  )

  // 搜索接管开关只在已登录时出现：未登录时插件根本不注册 provider
  // （见 web-sync 的不变式），此时暴露一个永远无效的开关只会误导。
  // 徽标读的是 host 报来的实际选择字段：开关是「意图」，徽标是「效果」——
  // 两者不一致（开关开着但接管失败）时，徽标是唯一能看出来的地方。
  const webSearchRow = settingSwitch(
    t('webSearch'),
    t('webSearchDesc'),
    webSearchPref,
    next => { void toggleWebSearch(next) },
    searchBackend !== undefined ? searchBadge(searchBackend, t) : undefined,
  )

  const body = phase === 'loading'
    ? h('div', { style: s.section }, h('p', { style: s.muted }, t('loading')))
    : h('div', { style: s.section },
        error !== undefined ? h('p', { style: s.error }, error) : null,
        signedIn
          ? h(Fragment, null,
              status?.userId !== undefined ? h(StatusRow, { label: t('userId'), value: status.userId }) : null,
              status?.tenantId !== undefined ? h(StatusRow, { label: t('tenantId'), value: status.tenantId }) : null,
              status?.enterpriseId !== undefined ? h(StatusRow, { label: t('enterpriseId'), value: status.enterpriseId }) : null,
              // 指标正文与输入框胶囊弹层共用同一个 UsageMetrics：两处入口渲染
              // 完全相同的字段，用户不会看到两份对不上的额度。
              usage !== undefined ? h(UsageMetrics, { view: usage, t, checkin }) : h('p', { style: s.muted }, t('usageError')),
              h('div', { style: s.actions },
                h(Button, { variant: 'outline', size: 'md', onClick: () => { void logout() } }, t('signOut')),
              ),
            )
          : h(Fragment, null,
              h('p', { style: s.muted }, loginState !== undefined ? t('waiting')
                // 凭据还在但过期了：说出 remedy，而不是报一个光秃秃的「未登录」——
                // 后者读起来像「这里从没发生过什么」，掩盖了缺的是重新登录。
                : status?.expired === true ? t('expired')
                  : t('notSignedIn')),
              h('div', { style: s.actions },
                h(Button, { variant: 'primary', size: 'md', disabled: loginState !== undefined, onClick: () => { void startLogin() } }, loginState !== undefined ? t('signingIn') : t('signIn')),
              ),
            ),
        // 四行同属一组：官方行样式自带下分隔线与 16px 纵向内距，靠相邻成列表；
        // 若散落在 section 的 gap 里，行距会变成「gap + 内距」而比官方松。
        h('div', { className: 'cb-setting-group' },
          switchRow,
          composerUsageRow,
          waitOnRateLimitRow,
          // 搜索接管开关只在已登录时出现（见 webSearchRow 的说明）。
          signedIn ? webSearchRow : null,
        ),
      )

  // 失败提示条浮在页面顶端（Toast 自己走 portal），与正文并列渲染。
  return h('div', { className: 'cb-body' }, body, checkin.toast)
}
