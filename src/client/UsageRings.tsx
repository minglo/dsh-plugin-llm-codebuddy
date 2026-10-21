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

/** 画布边长；所有半径都相对它写死，缩放交给 CSS。导出供测试断言几何常量。 */
export const SIZE = 220
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

/**
 * 签到填充圆的半径：**第一环内缘再往内让出一个 RING_GAP**（47.5 − 8 = 39.5）。
 *
 * 让出这一个间隙是为了**与另外两环的间距一致**：中环与外环之间是 8px，
 * 中心盘与第一环之间也该是 8px。此前中心盘半径取 47.5（恰好贴住内缘），
 * 间距是 0——四层东西（中心盘 / 第一环 / 中环 / 外环）里只有这一处是
 * 零间隙，看着就像中心盘属于环、而不属于中心。
 *
 * 同时也因此不会盖住第一环的描边带（47.5–60.5），「已用积分」那条弧完好。
 */
const R_CHECKIN = R_INNER - STROKE / 2 - RING_GAP

/**
 * 压在填充色上的深墨文字色。
 *
 * 写死而不用主题 token：填充是低明度灰绿（{@link MORANDI.checked}，明度 56%），
 * 深墨在它上面是 4.77:1，深浅两套主题同一支笔都成立；而主题的
 * `--dsw-alias-label-primary` 在深色主题下是浅灰、浅色主题下是深灰，两者只有
 * 一种能在填充上读清。
 */
const CHECKED_INK = '#16201b'

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
/* 签到填充：圆心从**中心**长出去，一直铺到第一环的内缘，与三环同一条曲线、同一时长。
   遮罩里那颗白圆从 scale(0) 长到 scale(1)：它有多大，填充色与深墨文字就露多少。
   播完时遮罩恰好全开；静态几何（不透明圆 + 满遮罩）始终在 DOM 里，reduced-motion 下
   直接是满的，不依赖动画成立。 */
@keyframes cb-checkin-fill{from{transform:scale(0)}to{transform:scale(1)}}
@media (prefers-reduced-motion: no-preference){
  .cb-ring-arc{animation:cb-ring-grow ${ANIM_MS}ms cubic-bezier(.22,1,.36,1) backwards;
    transition:stroke-dashoffset 300ms ease}
  .cb-ring-static{transition:stroke-dashoffset 300ms ease,stroke-dasharray 300ms ease}
  .cb-ring-center{animation:cb-ring-fade 420ms ease-out 160ms backwards}
  /* 与三环同时起手、同一时长、同一条缓动：读起来是一次动作，不是两段。
     缩放的参照系写成 view-box + 绝对用户单位，而不是 fill-box/center：
     fill-box 的参照框是元素自身的包围盒，SVG 元素的默认 transform-box 在
     不同浏览器/版本间从 border-box 变到 view-box，绕原点缩放会让填充从
     左上角长出来；view-box + 110px 110px 指向 viewBox 的正中，无歧义。 */
  .cb-checkin-fill{animation:cb-checkin-fill ${ANIM_MS}ms cubic-bezier(.22,1,.36,1) backwards;
    transform-box:view-box;transform-origin:${CENTER}px ${CENTER}px}
}
/* 签到按钮的伪类态（几何在内联样式里，见 s.checkinHit）。
   悬停才出现的淡底是「这里可点」的提示：未签到时圆心是干净的（与签到态的
   绿盘形成颜色区分），若常驻一个底色就分不清「未签到」与「可点」。
   已签到/请求在飞时是 disabled，悬停不响应——点击也就不响应。 */
.cb-checkin-hit:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.16))}
.cb-checkin-hit:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.cb-checkin-hit:disabled{cursor:default}
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

/**
 * 圆心数值的字号：按字符数收窄，保证它**整体落在填充圆盘内**。
 *
 * 盘半径 39.5（直径 79），文字行所在高度上的弦长约 78.6px（行本身离圆心有偏移，
 * 弦比直径略短）。20px 粗体下每位数字约 13.9px，于是：
 *   ≤5 位（99999 → 69.6px）用 20px；
 *   6 位（20px 下 83.5px，超出）→ 16px（66.8px）；
 *   7 位 → 14px（68.2px）；
 *   8–9 位 → 12px（66.8 / 71.4px）；
 *   ≥10 位 → 11px（73.1px）。
 *
 * 收窄而不是截断：截断会让「1,234,567.89」变成「1,234,567.8」，读数直接是错的；
 * 收窄后数字仍是完整的，只是小一号。
 *
 * @param text - 已格式化好的数值文本。
 * @returns 字号（px）。
 */
export function centerValueFontSize(text: string): number {
  if (text.length <= 5) return 20
  if (text.length === 6) return 16
  if (text.length === 7) return 14
  if (text.length <= 9) return 12
  return 11
}

const s = {
  // 允许换行：弹窗内容列放不下「220px 圆环 + 图例」时，图例会折到第二行，
  // 而不是把圆环挤扁。**是否居中由容器决定**（弹窗那条规则见 CodeBuddyTab 的
  // .cb-usage-modal）：插件详情页其余各行都是左对齐的，圆环整组摆到卡片中间会与
  // 上下文脱节，所以组件本身默认左对齐。
  wrap: { display: 'flex', flexWrap: 'wrap' as const, alignItems: 'center', gap: '18px' },
  svg: { width: `${SIZE}px`, height: `${SIZE}px`, flexShrink: 0 },
  // 圆环 + 签到按钮的共同容器：相对定位，按钮据此绝对定位到圆心。
  svgWrap: { position: 'relative' as const, width: `${SIZE}px`, height: `${SIZE}px`, flexShrink: 0 },
  /**
   * 圆心的签到按钮：正好盖住填充圆盘（R_CHECKIN*2），浮在 SVG 之上。
   *
   * 几何写在**内联**样式里而不是样式表：这张表的注入发生在插件加载时，而圆环的
   * 样式表是组件自己注入的（useEffect）——若几何也放在表里，首帧按钮会退回
   * `position: static`，在容器里撑出一块 79px 的空白，把布局顶一下。悬停底色与
   * 焦点环这类伪类留在表里（内联样式表达不了伪类）。
   */
  checkinHit: {
    position: 'absolute' as const,
    left: '50%',
    top: '50%',
    transform: 'translate(-50%, -50%)',
    width: `${R_CHECKIN * 2}px`,
    height: `${R_CHECKIN * 2}px`,
    borderRadius: '50%',
    border: 0,
    padding: 0,
    background: 'transparent',
    cursor: 'pointer',
  },
  centerLabel: { fontSize: '11px', fill: 'var(--dsw-alias-label-secondary)' },
  centerValue: { fontSize: '20px', fontWeight: 600, fill: 'var(--dsw-alias-label-primary)' },
  // 已签到态的中心文字：与填充圆同一个深墨（4.77:1）。只被签到遮罩剪裁后渲染，
  // 因此它永远落在已经铺满填充色的区域上——见 center 处的说明。
  centerLabelInk: { fontSize: '11px', fill: CHECKED_INK },
  centerValueInk: { fontSize: '20px', fontWeight: 600, fill: CHECKED_INK },
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
 * @param props - 读数、翻译函数、签到态与签到回调。
 */
export function UsageRings({ view, t, checked = false, onCheckin, checkinPending = false }: {
  view: UsageView
  t: (key: string) => string
  /** 今日是否已签到：已签到时圆心铺填充色，且点击不再响应。 */
  checked?: boolean
  /** 点圆心签到。缺省 = 圆心不可点（纯展示）。 */
  onCheckin?: () => void
  /** 签到请求在飞：圆心不可再点（防双击发出两次写请求）。 */
  checkinPending?: boolean
}): ReactNode {
  useEffect(() => { injectRingsCss() }, [])

  // 同一页面上可能同时挂着插件卡片与弹窗两副圆环，遮罩 id 必须互不冲突。
  // useId 自带分隔符（React 18 是 `:r0:`），id 里不允许有标点，去掉。
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '')
  const sweepMaskId = `cb-sweep-${uid}`
  const checkinMaskId = `cb-checkin-${uid}`

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
  //
  // 已签到时分成**三层**，自下而上：
  //   1. 主题色文字（.cb-ring-center）——签到前全程可见；
  //   2. 绿色填充圆——被签到遮罩剪裁，圆盘从中心长到第一环内缘；
  //   3. 深墨文字——**同一个遮罩**，所以只出现在已铺上填充色的区域。
  //
  // 为什么深墨字必须跟着遮罩走，而不能直接换色：填充是逐渐铺满的，中途背景
  // 半深半浅，任何单一文字色都有一段时间读不清（实测深墨在 40% 铺度的深色卡片
  // 上只有 1.8:1）。跟着遮罩走，深墨字出现的地方一定是已经铺满绿的地方，
  // 对比度恒定 4.77:1；没铺到的地方仍是主题色字压在卡片底色上。
  //
  // 遮罩剪掉的主题色文字不会被绿色盖住——绿色在遮罩里，未铺到处根本不存在，
  // 于是两层文字在任何一个像素上都不重叠，不会出现「重影」。
  //
  // **两行字都必须整体落在盘内**：标签用短措辞（totalBalanceShort），数值按
  // 字符数收字号（centerValueFontSize）。否则标签会横跨盘边被切成两半颜色——
  // 那正是英文完整措辞（126.7px）在 95px 盘上会出的事。
  const balanceText = formatCredits(totalBalance)
  const valueSize = centerValueFontSize(balanceText)
  // 数值行随字号收窄时**基线也要跟着抬**：SVG 的 y 是基线，字号变小后同样的
  // 基线会让这一行整体下坠、在盘里偏下。抬 (20 − size)/2 让两行在盘里居中。
  const valueY = CENTER + 16 - (20 - valueSize) / 2
  const center = h(Fragment, null,
    h('g', { className: 'cb-ring-center' },
      h('text', { x: CENTER, y: CENTER - 6, textAnchor: 'middle', style: s.centerLabel }, t('totalBalanceShort')),
      h('text', { x: CENTER, y: valueY, textAnchor: 'middle', style: { ...s.centerValue, fontSize: `${valueSize}px` } }, balanceText),
    ),
    checked ? h('g', { mask: `url(#${checkinMaskId})`, 'data-checkin-layer': '' },
      h('circle', {
        'data-checkin-fill': '',
        cx: CENTER,
        cy: CENTER,
        r: R_CHECKIN,
        fill: MORANDI.checked,
      }),
      h('g', { 'data-checkin-ink': '' },
        h('text', { x: CENTER, y: CENTER - 6, textAnchor: 'middle', style: s.centerLabelInk }, t('totalBalanceShort')),
        h('text', { x: CENTER, y: valueY, textAnchor: 'middle', style: { ...s.centerValueInk, fontSize: `${valueSize}px` } }, balanceText),
      ),
    ) : null,
  )

  return h('div', { style: s.wrap, 'data-usage-rings': '' },
    // 圆环本体 + 圆心的签到按钮，同在一个相对定位的盒子里。
    //
    // 按钮是 **HTML** 按钮而不是 SVG 里的 <g role="button">：SVG 的 role="img"
    // 会让整棵子树对读屏软件变成装饰性的，里面的东西键盘到不了。而签到是一个
    // 真按钮——要有焦点环、要有 aria-label、要在已签到时真的 disabled（而不是
    // 「点了没反应」）。所以它浮在 SVG 之上。
    h('div', { style: s.svgWrap },
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
        // 签到遮罩：与扫光同构，但剪的是「中心圆盘」而不是「外环弧」。白圆从
        // scale(0) 长到 scale(1)，长到哪里，填充色与深墨字就露到哪里。
        // 静态态（reduced-motion / jsdom）里白圆是满尺寸，遮罩全开 = 直接是满色。
        checked ? h('mask', {
          id: checkinMaskId,
          maskUnits: 'userSpaceOnUse',
          x: 0, y: 0, width: SIZE, height: SIZE,
        },
          h('rect', { x: 0, y: 0, width: SIZE, height: SIZE, fill: '#000' }),
          h('circle', {
            className: 'cb-checkin-fill',
            cx: CENTER,
            cy: CENTER,
            r: R_CHECKIN,
            fill: '#fff',
          }),
        ) : null,
      ),
      // 中心组（主题色文字 + 签到填充层）排在**环之前**。
      //
      // 顺序不是审美问题而是正确性问题：填充圆的半径恰好等于第一环的内缘
      // （47.5），两者相切。填充若画在环之后，相切处两条抗锯齿边会互相混色，
      // 缝里出现一道脏边；画在环之前则由环的描边压住接缝，接缝干净。
      //
      // 文字不受影响：中心文字最宽约 55px（半径 27.5），远在第一环内缘之内。
      center,
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
      ),
      // 圆心的签到按钮。浮在 SVG 之上、正好盖住填充圆盘。
      //
      // 已签到 → disabled：点击**真的不响应**（不是「点了没反应」的假按钮）。
      // 请求在飞 → 也 disabled：否则双击会发出两次写请求。
      onCheckin === undefined ? null : h('button', {
        type: 'button',
        className: 'cb-checkin-hit',
        style: s.checkinHit,
        disabled: checked || checkinPending,
        'aria-label': checkinPending
          ? t('checkinPending')
          : checked ? t('checkinDone') : t('checkinCta'),
        title: checkinPending
          ? t('checkinPending')
          : checked ? t('checkinDone') : t('checkinCta'),
        onClick: () => {
          if (checked || checkinPending) return
          onCheckin()
        },
      }),
    ),
    h('div', { style: s.legend, 'data-usage-legend': '' },
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
