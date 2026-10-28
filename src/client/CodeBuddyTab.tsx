import { useEffect, useCallback, useRef, useState, createElement as h, Fragment } from 'react'
import type { ReactNode } from 'react'
import { Button, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { ChannelHealthView, ChannelVerdict, CheckinResultView, CheckinStatusView, LoginPoll, LoginStart, ProbeResultView, SearchBackendState, SettingsView, StatusView, UsageResult, UsageView } from '../remote-types.js'
import type { LocaleKey } from './locales.js'
import { finiteOr, unwrap, withTimeout } from './shared.js'
import { MORANDI } from './palette.js'
import { UsageRings } from './UsageRings.jsx'
import { emitLoginChange, emitUsagePrefChange } from './notifiers.js'
import { useCheckin, type CheckinBinding } from './use-checkin.js'
import { LOGIN_TIMEOUT_MS } from '../constants.js'

/** 配置卡片单次远程读取的硬超时：host 挂住时不能让卡片永远停在加载态。 */
const READ_TIMEOUT_MS = 15_000

/**
 * 自检调用的等待上限。
 *
 * 不能用 READ_TIMEOUT_MS：宿主侧三发各有 15 秒预算（PROBE_TIMEOUT_MS），最坏要
 * 45 秒。按 15 秒收尾会让按钮在宿主仍在跑时重新可点，用户以为「这次没反应」，
 * 而宿主只会把新点击并进同一个 in-flight Promise。留出 5 秒余量覆盖传输与排队。
 */
const PROBE_WAIT_MS = 50_000

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
    /**
     * 渠道自检的历史读数（宿主只读盘、零外呼）。
     *
     * 手写结构声明，**不会**随 `client/index.ts` 的 `CodeBuddyRemote` 自动扩张：
     * 那个接口描述的是网关的静态面，这里是卡片实际调用到的子集，两处都必须写。
     */
    channelHealth(): Promise<RemoteResult<ChannelHealthView>>
    /** 跑一次三发自检。点按钮才调；宿主另外单飞，两重保险。 */
    probe(): Promise<RemoteResult<ProbeResultView>>
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

/* 自检行：**独立容器**，刻意不塞进 .cb-setting-group。它右侧是按钮不是开关，
   而且组内行数被既有测试逐条量过（.cb-setting-row 与 button[role=switch] 的计数），
   混进去会让「开关组的形状」这条断言失去意义。独立成块后，行自带的
   下分隔线正好把它与下方的历史读数分开。 */
.cb-probe{display:flex;flex-direction:column}
.cb-probe-history{display:flex;flex-direction:column;gap:6px;padding:12px 0 0}
.cb-probe-line{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
/* 时刻用等宽数字：两行读数上下对齐，扫一眼就不会把日期与分钟读串。 */
.cb-probe-time{font-variant-numeric:tabular-nums;white-space:nowrap}
.cb-probe-error{margin:0;font-size:12px;line-height:18px;color:${MORANDI.urgent}}

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

/**
 * verdict → 文案键。机械映射，避免调用点临时起名导致两种说法并存。
 *
 * 键是 `ChannelVerdict`，但查表时按 `string` 取。**版本偏斜到不了这里**：wire 上的
 * verdict 由 descriptor 的 `z.enum` 先行校验，未知值会让整次 `probe()` 调用失败，
 * 客户端看到的是 `probeFailed`（未完成），不是 `probeUnknown`。下面的兜底仍然保留，
 * 用来防御绕过 wire 校验的调用（测试替身、直接复用组件的组合代码），绝不让键名或
 * 英文枚举上屏。
 */
const PROBE_KEY: Record<ChannelVerdict, LocaleKey> = {
  'healthy': 'probeHealthy',
  'rule-gone': 'probeRuleGone',
  'neutralization-broken': 'probeBroken',
  'inconsistent': 'probeInconsistent',
  'stage-failed': 'probeStageFailed',
  'channel-rejected': 'probeRejected',
  'auth': 'probeAuth',
  'rate-limited': 'probeRateLimited',
  'quota': 'probeQuota',
  'unavailable': 'probeUnavailable',
  'unreachable': 'probeUnreachable',
}

/**
 * verdict → 徽标圆点色。全部取自既有调色板（palette.test.ts 用 ΔE 锁死了色值，
 * 新增一个色要过同一套校验，收益不值）。
 *
 * 读法是「用户该做什么」，不是「严重程度」：
 *   · ok         —— 什么都不用做（规则在、中和有效）；
 *   · neutral    —— 没有可行动项（规则已消失、上游未分类失败、连不上——都是等或不管）；
 *   · urgent     —— 需要动手（中和失效＝该更新插件；渠道拒收＝请求头不合规）；
 *   · blocked    —— 先解决前置条件再谈渠道（凭据失效、限流、额度用尽）；
 *   · warn       —— 证据不足以下结论（自相矛盾、自检没跑完），别照着做决定。
 */
const PROBE_COLOR: Record<ChannelVerdict, string> = {
  'healthy': MORANDI.ok,
  'rule-gone': MORANDI.neutral,
  'neutralization-broken': MORANDI.urgent,
  'inconsistent': MORANDI.warn,
  'stage-failed': MORANDI.warn,
  'channel-rejected': MORANDI.urgent,
  'auth': MORANDI.blocked,
  'rate-limited': MORANDI.blocked,
  'quota': MORANDI.blocked,
  'unavailable': MORANDI.neutral,
  'unreachable': MORANDI.neutral,
}

/** 未知 verdict 的兜底色：不表态的暖灰。 */
const PROBE_COLOR_UNKNOWN = MORANDI.neutral

/**
 * 查表按字符串取，但只认**自有键**。
 *
 * 不能写 `table[verdict] ?? fallback`：`toString` / `__proto__` 这类名字在普通对象
 * 上会取到原型链成员，返回值是 truthy 的函数或对象，`??` 根本不会兜底——那个函数
 * 会被当成 LocaleKey 交给 `t()`，最终以「函数不能作为 React 子节点」收场。
 */
function probeKeyOf(verdict: string): LocaleKey {
  return Object.hasOwn(PROBE_KEY, verdict)
    ? PROBE_KEY[verdict as ChannelVerdict]
    : 'probeUnknown'
}

function probeColorOf(verdict: string): string {
  return (PROBE_COLOR as Record<string, string | undefined>)[verdict] ?? PROBE_COLOR_UNKNOWN
}

/**
 * `fingerprintGuess` → 文案键。
 *
 * 闭集只有三个取值；读的是 wire 上的字符串，仍按 string 查表兜底——旧客户端
 * 遇到新主机下发的新取值时，宁可说「未能定位」，也不把标识符原样打上屏。
 */
const FINGERPRINT_KEY: Record<'identity-sentence' | 'anywhere' | 'unknown', LocaleKey> = {
  'identity-sentence': 'probeFingerprintIdentity',
  'anywhere': 'probeFingerprintAnywhere',
  'unknown': 'probeFingerprintUnknown',
}

/** 指纹位置的可读文案。 */
function fingerprintText(guess: string, t: Translate): string {
  // `Object.hasOwn` 而不是裸查表：`'toString'` 这类名字会从原型上取到函数，
  // `??` 拦不住，而那正是「未知取值」最可能的样子。
  return t(Object.hasOwn(FINGERPRINT_KEY, guess)
    ? FINGERPRINT_KEY[guess as keyof typeof FINGERPRINT_KEY]
    : 'probeFingerprintUnknown')
}

/**
 * 判定句。`stage-failed` 的原文带 `{stage}` / `{status}` 占位符：设计文档要求
 * 逐字，所以这里用探针实测的那一阶段去填，而不是把占位符原样上屏或丢掉证据。
 * 找不到非 200 阶段（理论上不会发生）时用破折号占位，读数仍读得通。
 */
function probeSentence(result: ProbeResultView, t: Translate): string {
  const key = probeKeyOf(result.verdict)
  const text = t(key)
  if (key !== 'probeStageFailed') return text
  const failed = result.stages.find(stage => stage.status !== undefined && stage.status !== 200)
  return text
    .replace('{stage}', failed?.stage ?? '—')
    .replace('{status}', failed?.status === undefined ? '—' : String(failed.status))
}

/** 固定 `YYYY-MM-DD HH:mm`，不随运行环境 locale 变（同 ComposerUsage 的理由）。 */
function probeTime(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * 自检结论徽标：结构与 `searchBadge` 同构（圆点承载状态色 + 文字保持中性），
 * 但**允许换行**——判定句是完整一句话，窄卡片里 nowrap 会把它挤出可视区。
 */
function probeBadge(result: ProbeResultView, t: Translate): ReactNode {
  // flexShrink:1 + 可换行：判定句比卡片宽时折成两三行，而不是把按钮挤出可视区。
  // 不带类名：这里所有样式都在内联 style 里，加一个没有规则的类只会让后来者
  // 误以为 CSS 里有它的定义（`.cb-badge` 是例外——测试靠它定位搜索徽标）。
  return h('span', { style: { ...s.badge, whiteSpace: 'normal' as const, flexShrink: 1 } },
    h('span', { style: { ...s.badgeDot, background: probeColorOf(result.verdict) } }),
    probeSentence(result, t),
  )
}

/** 一行历史读数：「标签 时刻/兜底 [+ 徽标]」。 */
function probeLine(label: string, at: number | undefined, rest?: ReactNode): ReactNode {
  return h('div', { className: 'cb-probe-line' },
    h('span', null, label),
    at !== undefined ? h('span', { className: 'cb-probe-time' }, probeTime(at)) : null,
    rest ?? null,
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
  // 自检读数：`health` 是首屏从盘里读到的历史（含上次真实拦截），`probeResult`
  // 优先显示本次或历史（`lastProbe`）里的最近一次结论。
  const [health, setHealth] = useState<ChannelHealthView | undefined>(undefined)
  const [probeResult, setProbeResult] = useState<ProbeResultView | undefined>(undefined)
  const [probing, setProbing] = useState<boolean>(false)
  const [probeFailed, setProbeFailed] = useState<boolean>(false)
  const starting = useRef(false)
  /** 自检在飞。state 用于渲染，ref 用于拦同一 tick 内的第二次点击。 */
  const probingRef = useRef(false)
  /**
   * 组件是否仍挂载。
   *
   * runProbe 的 await 最长 50 秒（PROBE_WAIT_MS），用户完全可能在这期间关掉设置页。
   * 卸载后再 setState 是 React 不会替我们挡的泄漏；channelHealth 的读取用局部
   * `stopped` 旗标挡住了同一类问题，这里的窗口长得多，不能只靠「反正很快就回来」。
   */
  const mounted = useRef(true)

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

  // 渠道自检的历史读数。`channelHealth()` 只读落盘文件、零外呼——首屏因此可以放心
  // 调它，而 `probe()`（会打三发、消耗额度）只挂在按钮上，见 runProbe。
  //
  // 读不到时整行不出现，而不是报错：旧 host 没有这个方法（浏览器产物可单独替换）、
  // 文件损坏、超时，都只丢「上次结论」这一块读数，诊断失败不能连累整张卡片。
  useEffect(() => {
    let stopped = false
    void (async () => {
      try {
        const view = await withTimeout(unwrap(remote.channelHealth()), READ_TIMEOUT_MS)
        if (stopped) return
        setHealth(view)
        // 历史结论先上屏：用户点按钮之前看到的就是上一次跑出来的那一句。
        if (view.lastProbe !== undefined) setProbeResult(view.lastProbe)
      } catch {
        if (!stopped) setHealth(undefined)
      }
    })()
    return () => { stopped = true }
  }, [remote])

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

  /**
   * 跑一次自检。**只有这里会调 `probe()`**——挂载路径不许外呼（规格 §2）。
   *
   * 双重防重：`probingRef` 拦住同一帧里的第二次点击（state 尚未提交），`probing`
   * 负责按钮的 disabled。宿主自己也会单飞，但 UI 不能靠「反正宿主会并」来表现成
   * 点了没反应——重复点击期间按钮就该是禁用的。
   */
  const runProbe = useCallback(async () => {
    if (probingRef.current) return
    probingRef.current = true
    setProbing(true)
    setProbeFailed(false)
    try {
      const result = await withTimeout(unwrap(remote.probe()), PROBE_WAIT_MS)
      // 已卸载就只丢结果：ref 仍要复位（下面 finally），但不能再碰 React 状态。
      if (!mounted.current) return
      setProbeResult(result)
    } catch {
      // 调用本身失败（宿主拒绝、会话已释放）不产生 verdict：说「没启动」，
      // 而不是编一个结论。上一次的读数保持原样——它确实是「上次」发生的事。
      if (mounted.current) setProbeFailed(true)
    } finally {
      probingRef.current = false
      if (mounted.current) setProbing(false)
    }
  }, [remote])

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

  // 严格模式下 effect 会 mount → unmount → mount：重新挂载时必须把旗标复位，
  // 否则第二次挂载后的探针结果会被当成「已卸载」丢掉。
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

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

  // 自检行：只在已登录、且本部署真的跑渠道校验时出现。自建网关没有渠道校验，
  // 三发探针会恒报 `rule-gone`——那是误导性建议，整行藏掉比给个假结论好。
  const probeRow = signedIn && health?.applicable === true
    ? h('div', { className: 'cb-probe' },
        h('div', { className: 'cb-setting-row' },
          h('div', null,
            h('div', { className: 'cb-setting-head' },
              h('span', { className: 'cb-setting-title' }, t('probeTitle')),
            ),
            h('div', { className: 'cb-setting-desc' }, t('probeDesc')),
          ),
          h(Button, {
            variant: 'outline',
            size: 'md',
            disabled: probing,
            onClick: () => { void runProbe() },
          }, probing ? t('probeRunning') : t('probeRun')),
        ),
        h('div', { className: 'cb-probe-history' },
          probeFailed ? h('p', { className: 'cb-probe-error' }, t('probeFailed')) : null,
          // 上次自检：没有结论时也要有这一行——「从没跑过」本身是读数，
          // 空着会让人以为这一块没渲染出来。
          probeLine(
            t('probeLastRun'),
            probeResult?.at,
            probeResult !== undefined ? probeBadge(probeResult, t) : h('span', null, t('probeNever')),
          ),
          // 上次真实拦截由被动分类写入，与探针结果无关：自检自己的 11128 不写这里，
          // 所以这条读数永远是「真实请求」的现场。指纹猜测紧跟在时刻后面：
          // 「何时开始拦」与「拦的是哪种形状」是报障时仅有的两条线索。
          probeLine(
            t('probeLastBlock'),
            health.lastBlock?.at,
            health.lastBlock === undefined
              ? h('span', null, t('probeNever'))
              : h('span', null, fingerprintText(health.lastBlock.fingerprintGuess, t)),
          ),
        ),
      )
    : null

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
        // 自检行在开关组之外：它是「按钮 + 历史读数」，不是开关行。
        probeRow,
      )

  // 失败提示条浮在页面顶端（Toast 自己走 portal），与正文并列渲染。
  return h('div', { className: 'cb-body' }, body, checkin.toast)
}
