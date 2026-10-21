/**
 * 同心圆环指标：中心总剩余，内→外三环为「已用积分 / 本月到期 / 未来 7 天分段」。
 *
 * 四件事刻意如此：
 *
 * 1. **三环同一种语法**：每一环都是「空轨 = 未用（中性色），实心 = 已用（该口径的颜色）」。
 *    连分段环的每一天也是这样——未用部分与另外两环**同一个中性色**，已用部分才是
 *    当天自己的颜色。于是不必记「这环画的是剩余还是已用」。
 * 2. **分段环按当天额度分配角宽**：宽度严格随 size 占比，只有发过额度的天才成段，
 *    空天直接跳过。段的位置因此不固定——认段靠日期文字（「10月4日到期」）与当天
 *    颜色，不靠位置。段与段之间留真实缝隙。
 * 3. **7 天各有可分辨的颜色**。配色不能只讲「连续性」：相邻两档若只有 ΔE≈4，肉眼读到的
 *    是一片渐变而不是 7 个独立段（这正是上一版「看不明白」的原因）。现在的色阶按
 *    「相邻可分辨（ΔE ≥ 11）」挑，见 palette.ts 与 palette.test.ts。
 * 4. **打开时三环的实心弧都从 12 点长出来**，三环错开。外环的实心弧是 7 条彩色弧，
 *    由 {@link SweepHead} 的遮罩按角度逐段揭开（见 {@link UsageRings}）——起点与
 *    内/中环完全相同，而不是七段各自从段首长。`prefers-reduced-motion` 下完全不播——
 *    动画只是呈现，静态几何始终在 DOM 里（测试读的就是它）。
 */
import { Fragment, useEffect, useId } from 'react'
import { createElement as h } from 'react'
import type { ReactNode } from 'react'
import type { UsageView } from '../remote-types.js'
import { formatCredits, finiteOr } from './shared.js'
import { MORANDI, monthColor } from './palette.js'
import { daySegments, type DaySegment } from './usage-metrics.js'

/** 画布边长；所有半径都相对它写死，缩放交给 CSS。 */
const SIZE = 220
const CENTER = SIZE / 2
/** stroke 宽度。三环同宽，视觉重量一致。导出供测试量「圆头实际着色范围」。 */
export const STROKE = 13
/** 环与环之间的净间隙（从外环内缘到内环外缘）。 */
const RING_GAP = 8
/** 未用部分的中性色。三环共用同一个 token，这是「同一种语法」的落点。 */
const TRACK_COLOR = 'var(--dsw-alias-border-l2)'

/** 环半径：由内向外。内环留出中心文字的直径。 */
const R_INNER = 54
const R_MIDDLE = R_INNER + STROKE + RING_GAP
const R_OUTER = R_MIDDLE + STROKE + RING_GAP

/** 生长动画时长，与下面的 CSS 保持一致。三环同一时长，一条曲线走到底。 */
const ANIM_MS = 1000
/** 内环先、中环次之、外环最后，让眼睛跟着「由内向外」走一遍。 */
const MIDDLE_DELAY_MS = 120
const OUTER_DELAY_MS = 240

/** 整圈对应的弧长（用于 stroke-dasharray）。 */
function circumference(radius: number): number {
  return 2 * Math.PI * radius
}

/** 段起始角：弧度转度，0 = 12 点方向。DayTrack 与 DayProgress 共用同一份换算。 */
function segmentStartDeg(segment: DaySegment): number {
  return (segment.start * 180) / Math.PI
}

const RINGS_CSS_TAG = 'dsh-plugin-llm-codebuddy/rings.module.css'
/**
 * 生长动画：把 `stroke-dashoffset` 从「整圈」（不可见）动到元素自己的终值。
 *
 * 用 dashoffset 而不是 dasharray：dashoffset 是**单个数值**、浏览器原生可插值，
 * 不需要 calc() 或 @property；起止值经 `--cb-from` / `--cb-to` 由每个元素自带，
 * 于是同一条 keyframes 能服务半径各异的弧。静态终值写在 inline style 上，
 * 所以即使完全不播动画（reduced-motion、jsdom），DOM 里的几何也是正确的。
 */
const RINGS_CSS = `
@keyframes cb-ring-grow{from{stroke-dashoffset:var(--cb-from)}to{stroke-dashoffset:var(--cb-to)}}
@keyframes cb-ring-fade{from{opacity:0}to{opacity:1}}
@media (prefers-reduced-motion: no-preference){
  .cb-ring-arc{animation:cb-ring-grow ${ANIM_MS}ms cubic-bezier(.22,1,.36,1) backwards;
    transition:stroke-dashoffset 300ms ease}
  .cb-ring-static{transition:stroke-dashoffset 300ms ease,stroke-dasharray 300ms ease}
  .cb-ring-center{animation:cb-ring-fade 420ms ease-out 160ms backwards}
}
`

function injectRingsCss(): void {
  if (typeof document === 'undefined') return
  if (document.querySelector(`style[data-plugin-css=${JSON.stringify(RINGS_CSS_TAG)}]`) !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-plugin-llm-codebuddy'
  tag.dataset.pluginCss = RINGS_CSS_TAG
  tag.textContent = RINGS_CSS
  document.head.appendChild(tag)
}

/**
 * 一段圆弧：从 12 点方向顺时针起算。
 *
 * 实现用「整圈 dash + dashoffset 缩短」而不是 `dasharray: L, C-L`：这样弧长只由
 * 一个数值控制，动画、`stroke-linecap` 与 0 值（画不出来）三件事都不必特判。
 * @param props - 半径、起始角、弧长、颜色、端点形状、动画延迟与是否播放入场动画。
 */
function Arc({ radius, startDeg, length, color, opacity = 1, cap = 'butt', delayMs = 0, animate = true }: {
  radius: number
  /** 起始角，度。0 = 12 点方向，顺时针为正。 */
  startDeg: number
  length: number
  color: string
  opacity?: number
  cap?: 'butt' | 'round'
  delayMs?: number
  /** false = 静态几何（分段环），只走数据刷新时的 transition，不播打开动画。 */
  animate?: boolean
}): ReactNode {
  const total = circumference(radius)
  const painted = Math.min(Math.max(length, 0), total)
  // 0 长不落笔：`stroke-linecap: round` 会把 0 长画成一个点，而「0%」与「几乎为 0」必须分得开。
  if (painted <= 0) return null
  // 圆头端点各向外扩半个 stroke。不补偿的话：相邻两段的圆头会伸进彼此之间的缝隙
  // （见 SEGMENT_GAP_RAD），七段连成一片；而内/中环的弧也会比数据多出 13px。
  // 于是把绘制长度内缩一个 stroke、起点前移半个 stroke，着色范围正好等于请求长度。
  const inset = cap === 'round' && painted > STROKE ? STROKE : 0
  const drawn = painted - inset
  const offset = total - drawn
  // 起点前移只在内缩时成立：退回平头（极小弧）的那条分支不能移，否则那一小段
  // 会被整体挪偏半个 stroke。
  const shiftDeg = inset > 0 ? (STROKE / 2 / radius) * (180 / Math.PI) : 0
  return h('circle', {
    className: animate ? 'cb-ring-arc' : 'cb-ring-static',
    cx: CENTER,
    cy: CENTER,
    r: radius,
    fill: 'none',
    stroke: color,
    strokeWidth: STROKE,
    strokeOpacity: opacity,
    // 比一个 stroke 还短的弧画不出圆头，退回平头——否则「已用 2%」会被整段吞掉。
    strokeLinecap: inset > 0 ? 'round' : 'butt',
    // 旋转让 0 角落在 12 点方向；SVG 的 y 轴向下，所以顺时针即正角。
    transform: `rotate(${-90 + startDeg + shiftDeg} ${CENTER} ${CENTER})`,
    // 整圈一个 dash：可见长度 = 整圈 − dashoffset，且从弧的起点向顺时针方向增长。
    strokeDasharray: `${total} ${total}`,
    strokeDashoffset: offset,
    style: animate
      // keyframes 的起止值：从「整圈」（不可见）长到自己的终值。
      ? { '--cb-from': `${total}`, '--cb-to': `${offset}`, animationDelay: `${delayMs}ms` }
      : {},
  })
}

/** 一整环的轨道（底色），让「一环有多少」在没有剩余时也可见。 */
function Track({ radius }: { radius: number }): ReactNode {
  return h('circle', {
    cx: CENTER,
    cy: CENTER,
    r: radius,
    fill: 'none',
    stroke: TRACK_COLOR,
    strokeWidth: STROKE,
  })
}

/**
 * 一条图例：色块 + 标签 + 数值（+ 可选百分比）。
 *
 * 返回的是**四个兄弟节点**而不是一个包起来的 div：图例本身是一个 CSS Grid，
 * 四个格子（色块/标签/数值/百分比）按列对齐，所以「标签」与「数值」的距离恒为
 * 列间距 8px。此前标签是 `flex:1`，会把数值一路推到容器最右边——容器越宽、
 * 两者离得越远，正是「距离太远」的成因。
 */
function LegendRow({ color, label, value, pct }: {
  color: string
  label: string
  value: string
  pct?: number
}): ReactNode {
  return h(Fragment, null,
    h('span', { style: { ...s.legendDot, background: color } }),
    h('span', { style: s.legendLabel }, label),
    h('span', { style: s.legendValue }, value),
    pct === undefined
      ? h('span', { style: s.legendPct })
      : h('span', { style: s.legendPct }, `${Math.round(pct)}%`),
  )
}

/**
 * 图例里某一天的日期标签：「10月4日到期」。占位符的形状由 locale 的 `expiryDate`
 * 决定，这里只做替换，不拼字符串——中英文语序不同，拼字符串会写死一种语序。
 */
function formatDayLabel(t: (key: string) => string, segment: DaySegment): string {
  return t('expiryDate').replace('{M}', String(segment.month)).replace('{D}', String(segment.dayOfMonth))
}

const s = {
  // 允许换行：弹窗内容列放不下「220px 圆环 + 图例」时，图例会折到第二行，
  // 而不是把圆环挤扁。**是否居中由容器决定**（弹窗那条规则见 CodeBuddyTab 的
  // .cb-usage-modal）：插件详情页其余各行都是左对齐的，圆环整组摆到卡片中间会与
  // 上下文脱节，所以组件本身默认左对齐。
  wrap: { display: 'flex', flexWrap: 'wrap' as const, alignItems: 'center', gap: '18px' },
  svg: { width: `${SIZE}px`, height: `${SIZE}px`, flexShrink: 0 },
  centerLabel: { fontSize: '11px', fill: 'var(--dsw-alias-label-secondary)' },
  centerValue: { fontSize: '20px', fontWeight: 600, fill: 'var(--dsw-alias-label-primary)' },
  // Grid 而不是若干个 flex 行：四列跨行共享，标签/数值/百分比各自成列对齐，
  // 且列宽只由内容决定（justifyContent: start），容器再宽也不会把标签与数值拉开。
  legend: {
    display: 'grid',
    gridTemplateColumns: '8px auto auto auto',
    justifyContent: 'start',
    alignItems: 'center',
    columnGap: '8px',
    rowGap: '3px',
    // 贴合内容而不是拉伸：flex-basis auto 时图例宽度＝它自己的内容宽。若让它
    // flex:1 撑满，多出来的空间会变成图例右侧的一块死白（早先标签用 flex:1
    // 撑开则是把「数值」推到最右边，即用户报的「距离太远」）。
    flex: '0 1 auto',
    minWidth: 0,
  },
  legendDot: { width: '8px', height: '8px', borderRadius: '2px' },
  legendLabel: { color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap' as const },
  // 数值左对齐（网格列的起点）＝与标签紧邻；百分比定宽右对齐，让 0% 与 100% 对齐。
  legendValue: { color: 'var(--dsw-alias-label-primary)', whiteSpace: 'nowrap' as const, fontVariantNumeric: 'tabular-nums' },
  legendPct: { color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap' as const, minWidth: '36px', textAlign: 'right' as const, fontVariantNumeric: 'tabular-nums' },
  // 小节标题跨满四列。
  legendHeading: { gridColumn: '1 / -1', fontSize: '11px', color: 'var(--dsw-alias-label-secondary)', marginTop: '4px' },
  legendDays: { display: 'contents' as const },
}

/**
 * 7 天段的**中性轨**：未用的部分（与内/中环的轨道同色），段与段之间**不画**，留出真缝隙。
 *
 * 7 天各自的角宽已由 {@link daySegments} 算好（含没额度那天的最小宽度与段间隙）。
 *
 * 这是**静态几何且完全不被动画遮罩覆盖**：环的形状是数据，不是过程，一开场就该完整在。
 * 已用的彩色部分在 {@link DayProgress}，那里才跟着扫光走。
 */
function DayTrack({ segments }: { segments: DaySegment[] }): ReactNode {
  return h('g', null,
    ...segments.map(segment => h('g', { key: segment.day, 'data-day-segment': segment.day },
      h(Arc, {
        radius: R_OUTER,
        startDeg: segmentStartDeg(segment),
        length: segment.span * R_OUTER,
        color: TRACK_COLOR,
        cap: 'round',
        animate: false,
      }),
    )),
  )
}

/**
 * 7 天段的**已用彩色弧**，落在 {@link SweepHead} 的扫光遮罩里。
 *
 * 与中性轨分家是刻意的：轨一开场就在（环的形状是数据，不是过程），只有颜色跟着进度
 * 变——和内/中环「轨道先在、实心弧再长」完全同构。把中性轨也关进遮罩的话，整环得先被
 * 扫一遍才成形，读的人会以为这个环还不存在。
 */
function DayProgress({ segments }: { segments: DaySegment[] }): ReactNode {
  return h('g', null,
    ...segments.map(segment => segment.usedRatio > 0
      ? h('g', { key: segment.day, 'data-day-progress': segment.day },
          h(Arc, {
            radius: R_OUTER,
            startDeg: segmentStartDeg(segment),
            // 已用部分占该段宽度的 usedRatio；颜色是当天自己的颜色。
            length: segment.span * segment.usedRatio * R_OUTER,
            color: segment.color,
            cap: 'round',
            animate: false,
          }),
        )
      : null),
  )
}

/**
 * 外环的「整圈扫光」：一条白色弧，从 12 点顺时针扫满一整周。
 *
 * 它是 {@link UsageRings} 生成的一层遮罩，**只盖住** {@link DayProgress} 那 7 条彩色弧：
 * 扫到哪里，那一段就变到什么程度的颜色；扫过去就停在 `usedRatio` 处不动。中性轨在遮罩
 * 之外，全程可见。
 *
 * 为什么必须用遮罩而不是让每段自己长：分段弧的起点是各自的段首，各自播动画只能得到
 * 「七段依次长出来」，拼不成一道从 12 点起手的扫光。把动画收到遮罩上之后，外环与
 * 内/中环**共用同一条 keyframes、同一套 `--cb-from`/`--cb-to`、同一个 12 点起点**，
 * 全环只有一次缓动——「同一种语法」在这里才真正成立。
 *
 * 起止值与 {@link Arc} 同构：`--cb-from` 是整圈（不可见），`--cb-to` 是 0（扫满）。
 * 圆头让推进的「笔头」也是圆的，与彩色弧自身的圆头同半径，接缝处看不出错位；终态
 * dashoffset 为 0、遮罩全开，`prefers-reduced-motion` 下彩色弧直接是满的。
 * @param props - 外环半径与动画延迟。
 */
function SweepHead({ radius, delayMs }: { radius: number; delayMs: number }): ReactNode {
  const total = circumference(radius)
  return h('circle', {
    className: 'cb-ring-arc',
    'data-ring-sweep': '',
    cx: CENTER,
    cy: CENTER,
    r: radius,
    fill: 'none',
    stroke: '#fff',
    strokeWidth: STROKE,
    strokeLinecap: 'round',
    // 起点同样落在 12 点方向：与内/中环同一个起手。
    transform: `rotate(-90 ${CENTER} ${CENTER})`,
    strokeDasharray: `${total} ${total}`,
    strokeDashoffset: 0,
    style: { '--cb-from': `${total}`, '--cb-to': '0', animationDelay: `${delayMs}ms` },
  })
}

/**
 * 同心圆环主体。中心是总剩余；三环自内向外为已用积分、本月到期、未来 7 天分段。
 *
 * 三环是同一种语法：**轨道静态、实心弧按进度长**。前两环的实心弧就是 {@link Arc} 自己
 * （dashoffset 从整圈长到终值）；外环的实心弧是 7 条彩色弧，被 {@link SweepHead} 的
 * 遮罩按 12 点起手的角度逐段揭开——动画只有一处，段的几何各自只有一份。
 * @param props - 读数与翻译函数。
 */
export function UsageRings({ view, t }: { view: UsageView; t: (key: string) => string }): ReactNode {
  useEffect(() => { injectRingsCss() }, [])

  // 同一页面上可能同时挂着插件卡片与弹窗两副圆环，遮罩 id 必须互不冲突。
  // useId 自带分隔符（React 18 是 `:r0:`），id 里不允许有标点，去掉。
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '')
  const sweepMaskId = `cb-sweep-${uid}`

  const totalBalance = finiteOr(view.totalBalance, 0)
  const totalSize = finiteOr(view.totalSize, 0)
  const totalUsed = finiteOr(view.totalUsed, 0)
  const totalRatio = totalSize > 0 ? Math.min(Math.max(totalUsed / totalSize, 0), 1) : 0
  const pool = view.monthPool
  const monthUsed = finiteOr(pool?.used, 0)
  const monthSize = finiteOr(pool?.size, 0)
  const monthRatio = monthSize > 0 ? Math.min(Math.max(monthUsed / monthSize, 0), 1) : 0
  const segments = daySegments(view)

  // 中心文字用 SVG text 而不是 HTML 覆盖层：跟着 SVG 一起缩放，不会在窄容器里错位。
  const center = h('g', { className: 'cb-ring-center' },
    h('text', { x: CENTER, y: CENTER - 6, textAnchor: 'middle', style: s.centerLabel }, t('totalBalance')),
    h('text', { x: CENTER, y: CENTER + 16, textAnchor: 'middle', style: s.centerValue }, formatCredits(totalBalance)),
  )

  return h('div', { style: s.wrap, 'data-usage-rings': '' },
    h('svg', {
      viewBox: `0 0 ${SIZE} ${SIZE}`,
      style: s.svg,
      role: 'img',
      // 读屏用户拿到的是一句话总结，而不是七段弧的几何。
      'aria-label': `${t('totalBalance')} ${formatCredits(totalBalance)}`,
    },
      h('defs', null,
        // 扫光遮罩：全黑为「还没变到」，白色弧扫到哪里就露出哪里。
        h('mask', {
          id: sweepMaskId,
          maskUnits: 'userSpaceOnUse',
          x: 0, y: 0, width: SIZE, height: SIZE,
        },
          h('rect', { x: 0, y: 0, width: SIZE, height: SIZE, fill: '#000' }),
          h(SweepHead, { radius: R_OUTER, delayMs: OUTER_DELAY_MS }),
        ),
      ),
      // 内环：已用积分。灰紫——整体消耗是独立维度，与到期色阶不共色。
      h(Track, { radius: R_INNER }),
      totalRatio > 0 ? h(Arc, {
        radius: R_INNER,
        startDeg: 0,
        length: totalRatio * circumference(R_INNER),
        color: MORANDI.used,
        cap: 'round',
      }) : null,
      // 中环：本月到期池。预警色随消耗率升档（与侧栏同一个信号、同一函数）。
      h(Track, { radius: R_MIDDLE }),
      monthRatio > 0 ? h(Arc, {
        radius: R_MIDDLE,
        startDeg: 0,
        length: monthRatio * circumference(R_MIDDLE),
        color: monthColor(monthRatio),
        cap: 'round',
        delayMs: MIDDLE_DELAY_MS,
      }) : null,
      // 外环：未来 7 天分段。中性轨全程可见；只有已用的彩色弧被扫光遮罩逐段揭开。
      h(DayTrack, { segments }),
      h('g', { mask: `url(#${sweepMaskId})` }, h(DayProgress, { segments })),
      center,
    ),
    h('div', { style: s.legend },
      h(LegendRow, {
        color: MORANDI.used,
        label: t('totalUsed'),
        value: `${formatCredits(totalUsed)} / ${formatCredits(totalSize)}`,
        pct: totalRatio * 100,
      }),
      h(LegendRow, {
        color: monthColor(monthRatio),
        label: t('monthSize'),
        value: `${formatCredits(monthUsed)} / ${formatCredits(monthSize)}`,
        pct: monthRatio * 100,
      }),
      // 天分区：有额度的天才有行；7 天全空时标题带分区整个不渲染，
      // 而不是留一节空标题（"没有到期项"本身就是一种读数：不用显示）。
      ...(segments.length === 0 ? [] : [
        h('div', { style: s.legendHeading, key: 'heading' }, t('expiryByDay')),
        h('div', { style: s.legendDays, key: 'days' },
          segments.map(segment => h(LegendRow, {
            key: segment.day,
            color: segment.color,
            label: formatDayLabel(t, segment),
            value: `${formatCredits(segment.used)} / ${formatCredits(segment.size)}`,
            pct: segment.usedRatio * 100,
          })),
        ),
      ]),
    ),
  )
}
