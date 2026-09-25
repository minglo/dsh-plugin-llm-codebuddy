import { useEffect, useCallback, useRef, useState, createElement as h, Fragment } from 'react'
import type { ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { LoginPoll, LoginStart, SearchBackendState, SettingsView, StatusView, UsageResult, UsageView } from '../remote-types.js'
import { finiteOr, formatCredits, unwrap, withTimeout } from './shared.js'
import { MORANDI, monthColor, SEGMENT_COLORS } from './palette.js'

/** 登录态变化通知器：CodeBuddyTab 登录/退出成功后 emit，UsageIndicator 订阅后立即重拉。 */
const loginChangeListeners = new Set<() => void>()
export function emitLoginChange(): void {
  for (const l of loginChangeListeners) l()
}
export function subscribeLoginChange(listener: () => void): () => void {
  loginChangeListeners.add(listener)
  return () => { loginChangeListeners.delete(listener) }
}

/** showUsage 开关变化通知器：CodeBuddyTab 切换成功后 emit，UsageIndicator 订阅后重读 getSettings。 */
const usagePrefChangeListeners = new Set<() => void>()
export function emitUsagePrefChange(): void {
  for (const l of usagePrefChangeListeners) l()
}
export function subscribeUsagePrefChange(listener: () => void): () => void {
  usagePrefChangeListeners.add(listener)
  return () => { usagePrefChangeListeners.delete(listener) }
}

/** 网关 Client face 返回 RemoteResult 包装：统一解包，失败按错误抛出让调用方走错误分支。 */
const READ_TIMEOUT_MS = 15_000

export interface CodeBuddyTabInjected {
  remote: {
    status(): Promise<RemoteResult<StatusView>>
    usage(): Promise<RemoteResult<UsageResult>>
    startLogin(): Promise<RemoteResult<LoginStart>>
    pollLogin(state: string): Promise<RemoteResult<LoginPoll>>
    logout(): Promise<RemoteResult<void>>
    getSettings(): Promise<RemoteResult<SettingsView>>
  }
  setShowUsage(showUsage: boolean): Promise<void>
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

const s = {
  section: { display: 'flex', flexDirection: 'column' as const, gap: '12px', padding: '8px 0' },
  title: { margin: 0, fontSize: '18px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
  muted: { margin: 0, color: 'var(--dsw-alias-label-secondary)', fontSize: '14px' },
  error: { margin: 0, color: MORANDI.urgent, fontSize: '14px' },
  row: { display: 'flex', alignItems: 'center', gap: '12px', padding: '8px 0' },
  rowLabel: { color: 'var(--dsw-alias-label-secondary)', fontSize: '14px', minWidth: '160px' },
  rowValue: { color: 'var(--dsw-alias-label-primary)', fontSize: '14px', flex: 1, wordBreak: 'break-all' as const },
  actions: { display: 'flex', gap: '8px', marginTop: '8px' },
  bar: { position: 'relative' as const, flex: 1, height: '6px', borderRadius: '999px', background: 'var(--dsw-alias-border-l2)', overflow: 'hidden' as const },
  fill: { position: 'absolute' as const, inset: 0, transformOrigin: 'left', transition: 'width 240ms ease' },
  settingRow: { display: 'flex', alignItems: 'center', gap: '12px', padding: '8px 0' },
  settingLabel: { fontSize: '14px', color: 'var(--dsw-alias-label-primary)', flex: 1 },
  settingDesc: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' },
  // 生效态徽标：小圆点承载状态色，文字保持中性——避免整块彩色抢走标题注意力。
  badge: { display: 'inline-flex', alignItems: 'center', gap: '5px', flexShrink: 0, padding: '1px 8px', border: '.5px solid var(--dsw-alias-border-l2)', borderRadius: '999px', color: 'var(--dsw-alias-label-secondary)', fontSize: '11px', lineHeight: '16px', whiteSpace: 'nowrap' as const },
  badgeDot: { width: '6px', height: '6px', borderRadius: '999px', flexShrink: 0 },
  switchTrackOn: { display: 'inline-flex', alignItems: 'center', width: '40px', height: '22px', padding: '2px', borderRadius: '999px', border: 'none', cursor: 'pointer', background: MORANDI.accent, transition: 'background 160ms ease', flexShrink: 0 } as const,
  switchTrackOff: { display: 'inline-flex', alignItems: 'center', width: '40px', height: '22px', padding: '2px', borderRadius: '999px', border: 'none', cursor: 'pointer', background: 'var(--dsw-alias-border-l2, #d0d7de)', transition: 'background 160ms ease', flexShrink: 0 } as const,
  switchThumbOn: { width: '18px', height: '18px', borderRadius: '999px', background: '#ffffff', transform: 'translateX(18px)', transition: 'transform 160ms ease' } as const,
  switchThumbOff: { width: '18px', height: '18px', borderRadius: '999px', background: 'var(--dsw-alias-label-primary, #1f2328)', transform: 'translateX(0)', transition: 'transform 160ms ease' } as const,
}

function StatusRow({ label, value }: { label: string; value: string }) {
  return h('div', { style: s.row }, h('span', { style: s.rowLabel }, label), h('span', { style: s.rowValue }, value))
}

/**
 * host 与 client 是两个独立产物（tsc / tsup 分别产出），只重建其一就会拿到缺字段的
 * 旧 view（如无 totalUsed / monthPool）。以下取值器按「有则取、无则兜底」消化，
 * 避免一次版本错配让整个设置页抛 Cannot read properties of undefined。
 */
function barProps(bucket: UsageView['monthPool'] | undefined): { used: number; size: number; ratio: number } {
  const used = finiteOr(bucket?.used, 0)
  const size = finiteOr(bucket?.size, 0)
  const raw = finiteOr(bucket?.usedRatio, 0)
  return { used, size, ratio: Math.min(Math.max(raw, 0), 1) }
}

/** 整体已用条的取值：缺 totalSize（旧 host）时退回 totalBalance，避免显示 0.0 / 0.0。 */
function totalBarProps(view: UsageView): { used: number; size: number; ratio: number } {
  const used = finiteOr(view.totalUsed, 0)
  // totalSize 非有限（NaN/undefined）→ 退回 totalBalance，再兜底 0。
  const size = finiteOr(view.totalSize, finiteOr(view.totalBalance, 0))
  const raw = finiteOr(view.totalUsedRatio, 0)
  return { used, size, ratio: Math.min(Math.max(raw, 0), 1) }
}

/**
 * 到期档进度条：条长 = 该档已用率（used / size），右侧标注「已用 X / Y」——
 * 数字与条长同源，避免百分比被误读成「占总余额的比例」（旧口径的坑）。
 */
function UsageBar({ label, used, size, ratio, color }: { label: string; used: number; size: number; ratio: number; color: string }) {
  const pct = Math.min(Math.max(ratio * 100, 0), 100)
  return h('div', { style: s.row },
    h('span', { style: s.rowLabel }, label),
    h('div', { style: s.bar }, h('div', { style: { ...s.fill, width: `${pct}%`, background: color } })),
    h('span', { style: s.rowValue }, `${formatCredits(used)} / ${formatCredits(size)}`),
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
  return h('span', { className: 'cb-badge', style: s.badge, title: t('searchBadgeHint') },
    h('span', { style: { ...s.badgeDot, background: color } }),
    label,
  )
}

export function CodeBuddyTab(props: Props): ReactNode {
  // `plugins.bundle.config` 只渲染 `page` 视图（契约原文：`view: 'page'` only），
  // 卡片标题/简介由 Plugins 页按包的 locale 元数据绘制，故这里不再有 summary 分支。
  const { remote, setShowUsage, setWebSearch, t } = props
  return h(CodeBuddyTabBody, { remote, setShowUsage, setWebSearch, t })
}

function CodeBuddyTabBody({ remote, setShowUsage, setWebSearch, t }: Omit<Props, 'view' | 'form'>): ReactNode {
  const [phase, setPhase] = useState<Phase>('loading')
  const [status, setStatus] = useState<StatusView | undefined>(undefined)
  const [usage, setUsage] = useState<UsageView | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [loginState, setLoginState] = useState<string | undefined>(undefined)
  const [showUsagePref, setShowUsagePref] = useState<boolean>(true)
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

  // 开关初值：读远程 getSettings；失败沿用 schema 默认（showUsage true / webSearch false）。
  useEffect(() => {
    let stopped = false
    unwrap(remote.getSettings())
      .then(value => {
        if (stopped) return
        setShowUsagePref(value.showUsage)
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
        if (Date.now() - startedAt >= 10 * 60 * 1000) {
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

  /** 一行「标题 + 说明 + 开关」。两个开关共用同一形状，避免样式漂移。 */
  const settingSwitch = (label: string, desc: string, on: boolean, toggle: () => void, badge?: ReactNode): ReactNode =>
    h('div', { style: s.settingRow },
      h('div', { style: s.settingLabel },
        h('div', { className: 'cb-setting-head' },
          h('span', null, label),
          badge ?? null,
        ),
        h('div', { style: s.settingDesc }, desc),
      ),
      h('button', {
        role: 'switch',
        'aria-checked': on,
        'aria-label': label,
        onClick: toggle,
        style: on ? s.switchTrackOn : s.switchTrackOff,
      },
        h('span', { style: on ? s.switchThumbOn : s.switchThumbOff }),
      ),
    )

  const switchRow = settingSwitch(t('showUsage'), t('showUsageDesc'), showUsagePref, () => { void toggleShowUsage(!showUsagePref) })

  // 搜索接管开关只在已登录时出现：未登录时插件根本不注册 provider
  // （见 web-sync 的不变式），此时暴露一个永远无效的开关只会误导。
  // 徽标读的是 host 报来的实际选择字段：开关是「意图」，徽标是「效果」——
  // 两者不一致（开关开着但接管失败）时，徽标是唯一能看出来的地方。
  const webSearchRow = settingSwitch(
    t('webSearch'),
    t('webSearchDesc'),
    webSearchPref,
    () => { void toggleWebSearch(!webSearchPref) },
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
              usage !== undefined
                ? h(Fragment, null,
                    h(StatusRow, { label: t('totalBalance'), value: formatCredits(finiteOr(usage.totalBalance, 0)) }),
                    h(UsageBar, {
                      label: t('totalUsed'),
                      ...totalBarProps(usage),
                      // 灰紫：整体消耗是独立维度，不能与到期色阶（暖→绿）共色。
                      color: MORANDI.used,
                    }),
                    // 判据用 totalSize>0：用完的包仍有 size，仍要显示已用率。
                    // finiteOr(...) 而非裸读：host/client 是两个独立产物，只重建其一会拿到缺字段的
                    // 旧 view，裸属性读会抛并让整张卡片静默消失（只剩标题）。
                    // 本月到期 = monthPool（CycleEnd 落在本月自然月的全部账户），与侧边栏复合条同口径。
                    // 配色与侧栏一致：本月池走 monthColor（同色相内升降明度），三档到期窗口依次
                    // 取 SEGMENT_COLORS 的连续色阶，与侧栏三段条是同一套色。
                    finiteOr(usage.totalSize, 0) > 0
                      ? h(Fragment, null,
                          h(UsageBar, { label: t('monthSize'), ...barProps(usage.monthPool), color: monthColor(barProps(usage.monthPool).ratio) }),
                          h(UsageBar, { label: t('tomorrowExpiring'), ...barProps(usage.tomorrow), color: SEGMENT_COLORS[0] }),
                          h(UsageBar, { label: t('dayAfterExpiring'), ...barProps(usage.dayAfter), color: SEGMENT_COLORS[1] }),
                          h(UsageBar, { label: t('weekExpiring'), ...barProps(usage.week), color: SEGMENT_COLORS[2] }),
                        )
                      : h('p', { style: s.muted }, t('usageError')),
                  )
                : h('p', { style: s.muted }, t('usageError')),
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
        switchRow,
        signedIn ? webSearchRow : null,
      )

  return h('div', { className: 'cb-body' }, body)
}
