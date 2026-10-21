import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { createElement } from 'react'
import type { UsageView } from '../src/remote-types.js'
import { STROKE, UsageRings } from '../src/client/UsageRings.jsx'
import { en, zh } from '../src/client/locales.js'
import { EXPIRY_COLORS, MORANDI, monthColor } from '../src/client/palette.js'
import { SEGMENT_GAP_RAD, daySegments } from '../src/client/usage-metrics.js'
import { shanghaiDayKey } from '../src/expiry-days.js'

const t = (key: string) => en[key as keyof typeof en] ?? key

/**
 * 相对今天第 n 天的到期时刻，形如 `YYYY-MM-DD 12:00:00`（上海墙上时间）。
 * 用相对天数而不是写死日期：分桶依赖「今天」，写死日期会让用例隔天失效。
 */
function farDay(offset: number): string {
  const now = Date.now() + offset * 86_400_000
  const wall = new Date(now + 8 * 3_600_000)
  return `${wall.toISOString().slice(0, 10)} 12:00:00`
}

function view(overrides: Partial<UsageView> = {}): UsageView {
  return {
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
    ...overrides,
  }
}

function renderRings(v: UsageView = view()) {
  return render(createElement(UsageRings as never, { view: v, t }))
}

/**
 * 相对今天第 n 天的上海日历月/日，与 farDay 同算法：组件按「今天」分桶，
 * 断言日期标签时必须用同一套换算，否则跨天/跨月必有一边先翻。
 */
function shanghaiMD(offset: number): [number, number] {
  const [, m, d] = shanghaiDayKey(new Date(Date.now() + offset * 86_400_000)).split('-').map(Number)
  return [m!, d!]
}

/**
 * 一条弧的**着色范围**（弧度制）：起点与张角。
 *
 * dasharray / dashoffset 给的是绘制中心线的长度；`stroke-linecap: round` 的两个
 * 端点各向外扩半个 stroke，所以着色范围 = 绘制长度 + STROKE，起点比 transform
 * 给的角早半个 stroke。只读 `dash − dashoffset` 会短一个 stroke、起点晚半个
 * stroke，量出来的缝隙凭空多出 STROKE/radius。
 */
function paintedRange(circle: Element): { start: number; angle: number } {
  const radius = Number.parseFloat(circle.getAttribute('r') ?? '0')
  const dash = Number.parseFloat((circle.getAttribute('stroke-dasharray') ?? '').split(' ')[0] ?? '0')
  const offset = Number.parseFloat(circle.getAttribute('stroke-dashoffset') ?? '0')
  const rotate = Number.parseFloat(/rotate\(([-\d.]+)/.exec(circle.getAttribute('transform') ?? '')?.[1] ?? '0')
  // 弧长 → 弧度（除以半径），与位置同单位才能相减。
  return {
    start: ((rotate + 90) * Math.PI) / 180 - STROKE / 2 / radius,
    angle: (dash - offset + STROKE) / radius,
  }
}

describe('UsageRings（同心圆环）', () => {
  it('draws one arc group per granted day, skipping empty days', () => {
    const { container } = renderRings(view({
      details: [
        { name: 'a', cycleEndTime: farDay(0), remain: 50, size: 100, used: 50 },
        { name: 'b', cycleEndTime: farDay(3), remain: 20, size: 100, used: 80 },
      ],
    }))
    const groups = container.querySelectorAll('[data-day-segment]')
    expect(groups).toHaveLength(2)
    expect(Array.from(groups).map(g => g.getAttribute('data-day-segment'))).toEqual(['0', '3'])
  })

  it('puts the total remaining credits in the centre', () => {
    const { container } = renderRings()
    const svg = container.querySelector('svg')
    expect(svg?.textContent).toContain(en.totalBalance)
    expect(svg?.textContent).toContain('1000')
  })

  it('renders three concentric radii, inner to outer', () => {
    const { container } = renderRings()
    const radii = Array.from(container.querySelectorAll('circle'))
      .map(circle => Number(circle.getAttribute('r')))
    // 轨道 3 条 + （已用/本月/每天实心）若干；三个轨道半径必须互不相同且递增。
    const tracks = [...new Set(radii)].sort((a, b) => a - b)
    expect(tracks.length).toBeGreaterThanOrEqual(3)
    expect(tracks[0]).toBeLessThan(tracks[1] as number)
    expect(tracks[1]).toBeLessThan(tracks[2] as number)
  })

  it('colours the used ring and the month ring from the shared palette', () => {
    const { container } = renderRings()
    const strokes = Array.from(container.querySelectorAll('circle'))
      .map(circle => circle.getAttribute('stroke'))
    // 已用积分走灰紫；本月走 monthColor（此处 ratio 0.1 → 低档）。
    expect(strokes).toContain(MORANDI.used)
    expect(strokes).toContain(monthColor(0.1))
  })

  it('labels granted days with their calendar dates, skipping empty days', () => {
    const { container } = renderRings(view({
      details: [
        { name: 'a', cycleEndTime: farDay(0), remain: 50, size: 100, used: 50 },
        { name: 'b', cycleEndTime: farDay(3), remain: 20, size: 100, used: 80 },
      ],
    }))
    // 有额度的天写实际日期，不再是「X天内到期」。
    const [m0, d0] = shanghaiMD(0)
    const [m3, d3] = shanghaiMD(3)
    expect(container.textContent).toContain(`Expires ${m0}/${d0}`)
    expect(container.textContent).toContain(`Expires ${m3}/${d3}`)
    // 空天没有行：既不写日期，也不留占位。
    const [m1, d1] = shanghaiMD(1)
    expect(container.textContent).not.toContain(`Expires ${m1}/${d1}`)
    expect(container.textContent).toContain(en.expiryByDay)
  })

  it('writes the date label as “M月D日到期” in Chinese', () => {
    const zhT = (key: string): string => zh[key as keyof typeof zh] ?? key
    const { container } = render(createElement(UsageRings as never, {
      view: view({
        details: [{ name: 'a', cycleEndTime: farDay(0), remain: 50, size: 100, used: 50 }],
      }),
      t: zhT,
    }))
    const [m, d] = shanghaiMD(0)
    expect(container.textContent).toContain(`${m}月${d}日到期`)
  })

  it('hides the expiry section when no day was granted', () => {
    // 7 天全空 = 不成段：标题和天分区整个不渲染，而不是留一节空标题。
    // 默认 view 的 details 为空，正好覆盖这个状态。
    const { container } = renderRings()
    expect(container.querySelectorAll('[data-day-segment]')).toHaveLength(0)
    expect(container.querySelectorAll('[data-day-progress]')).toHaveLength(0)
    expect(container.textContent).not.toContain(en.expiryByDay)
    // 内、中两圈不受影响：扫光弧还在（遮着一个空组，无事发生）。
    expect(container.querySelectorAll('.cb-ring-arc')).toHaveLength(3)
  })

  it('shows real per-day numbers in the legend rather than only the ring', () => {
    const { container } = renderRings(view({
      details: [{ name: 'x', cycleEndTime: farDay(2), remain: 1, size: 4, used: 3 }],
    }))
    // 有额度的那天给出精确的 used / size，精确值有出处。
    expect(container.textContent).toContain('3 / 4')
  })

  it('survives a stale view with no monthPool or details', () => {
    // 旧 host：不能抛、不能整块消失（历史上裸属性读让卡片只剩标题）。
    // 无 details = 没有可成的段，外圈分段与图例分区一并缺席，但其余部分照常。
    const stale = {
      totalBalance: 50,
      totalSize: 0,
      totalUsed: 0,
      totalUsedRatio: 0,
    } as unknown as UsageView
    const { container } = renderRings(stale)
    expect(container.querySelector('[data-usage-rings]')).not.toBeNull()
    expect(container.querySelectorAll('[data-day-segment]')).toHaveLength(0)
  })

  it('carries an accessible summary instead of raw arcs', () => {
    const { container } = renderRings()
    expect(container.querySelector('svg')?.getAttribute('aria-label')).toContain('1000')
  })

  it('still draws a granted day even when its allowance is tiny', () => {
    // 最小宽度下限的回归点：极小额度不能被"优化"到不落笔——有额度就必须有可见的段。
    const { container } = renderRings(view({
      details: [
        { name: 'huge', cycleEndTime: farDay(0), remain: 9000, size: 10000, used: 1000 },
        { name: 'tiny', cycleEndTime: farDay(1), remain: 1, size: 1, used: 0 },
      ],
    }))
    const tiny = container.querySelector('[data-day-segment="1"] circle')
    expect(tiny).not.toBeNull()
    const total = 2 * Math.PI * Number(tiny?.getAttribute('r'))
    const offset = Number.parseFloat(tiny?.getAttribute('stroke-dashoffset') ?? `${total}`)
    expect(total - offset, '极小额度仍应落笔一段可见弧').toBeGreaterThan(0)
  })

  it('paints every day with its own colour and a shared neutral track', () => {
    // 用户要的读法：未用部分与另外两环**同一个中性色**，已用部分才是当天的颜色。
    const { container } = renderRings(view({
      details: [
        { name: 'a', cycleEndTime: farDay(0), remain: 0, size: 100, used: 100 },
        { name: 'b', cycleEndTime: farDay(3), remain: 50, size: 100, used: 50 },
      ],
    }))
    const trackStrokes = Array.from(container.querySelectorAll('[data-day-segment] circle'))
      .map(circle => circle.getAttribute('stroke'))
    // 中性轨道出现在每一天的未用部分上（与内/中环的轨道同色）。
    expect(trackStrokes).toContain('var(--dsw-alias-border-l2)')
    // 已用部分用当天自己的颜色：第 0 天与第 3 天各自出现。
    const progressStrokes = Array.from(container.querySelectorAll('[data-day-progress] circle'))
      .map(circle => circle.getAttribute('stroke'))
    expect(progressStrokes).toContain(EXPIRY_COLORS[0])
    expect(progressStrokes).toContain(EXPIRY_COLORS[3])
  })

  it('leaves a real gap between day segments instead of butting them together', () => {
    const { container } = renderRings(view({
      details: [
        { name: 'a', cycleEndTime: farDay(0), remain: 50, size: 100, used: 50 },
        { name: 'b', cycleEndTime: farDay(1), remain: 50, size: 100, used: 50 },
      ],
    }))
    // 相邻两天的**整段**弧之间必须留出 SEGMENT_GAP_RAD 的缝隙，不能首尾相接。
    //
    // 原用例只数了弧的条数（≥2），间隙为 0 也照样通过。注意不要拿「已用弧」来量：
    // 已用弧只占段宽的一部分，两段之间的空档主要来自 usedRatio，与缝隙无关
    // （把 SEGMENT_GAP_RAD 置 0 那种写法依然会绿）。这里取每天最长的弧——即铺满
    // 整段的**中性弧**，它的起止才是段的真实边界。
    //
    // 量的是**着色范围**（见 paintedRange），而不是 dasharray。
    const outer = Array.from(container.querySelectorAll<SVGCircleElement>('[data-day-segment]'))
      .map(seg => Array.from(seg.querySelectorAll<SVGCircleElement>('circle'))
        .map(paintedRange)
        .sort((a, b) => b.angle - a.angle)[0])
      .filter((arc): arc is { start: number; angle: number } => arc !== undefined)
    expect(outer).toHaveLength(2)

    const onRing = [...outer].sort((a, b) => a.start - b.start)
    const gaps = onRing.map((arc, i) => {
      const next = onRing[(i + 1) % onRing.length]!
      const nextStart = i + 1 < onRing.length ? next.start : next.start + 2 * Math.PI
      return nextStart - (arc.start + arc.angle)
    })
    // 本用例的主张是「**有**真缝隙、没有首尾相接」——所以必须先断言严格为正。
    // 只写 toBeCloseTo(SEGMENT_GAP_RAD) 是不够的：把常量改成 0 时两边同时变 0，
    // 断言照样通过（那正是原来的毛病换了个写法）。
    for (const gap of gaps) expect(gap, '相邻两天之间必须有真缝隙').toBeGreaterThan(0)
    // 再绑定到声明的段缝隙值：缝隙存在，且正是约定的那个宽度。
    for (const gap of gaps) expect(gap).toBeCloseTo(SEGMENT_GAP_RAD, 6)
  })

  it('rounds every arc end, so day segments look like the inner rings', () => {
    // 用户报的「每个分段都是直角」：曾经分段弧没给 cap，Arc 默认 butt，段全是直角。
    // 段与内/中环一样走圆头，才读得出「同一种语法」。这里连内/中环一起断：三环的
    // 端点形状必须一致，不能只把外环改圆。
    const { container } = renderRings(view({
      details: [
        { name: 'a', cycleEndTime: farDay(0), remain: 50, size: 100, used: 50 },
        { name: 'b', cycleEndTime: farDay(1), remain: 0, size: 0, used: 0 },
      ],
    }))
    // 只查**弧**：轨道是整圈，本来就没有端点（`Track` 不设 linecap）。
    const arcs = Array.from(container.querySelectorAll('circle[stroke-dashoffset]'))
    expect(arcs.length).toBeGreaterThan(0)
    for (const arc of arcs) {
      expect(arc.getAttribute('stroke-linecap'), `r=${arc.getAttribute('r')} 的弧端点`).toBe('round')
    }
  })

  it('tucks the round caps inside each segment, which is what keeps gaps real', () => {
    // 圆头端点各向外扩半个 stroke，直接按段宽画圆头的话，圆头会伸进缝隙里把两段
    // 连成一片。Arc 把绘制长度内缩一个 stroke、起点前移半个 stroke，圆头于是整个
    // 收在段内：第 k 段的着色范围正好是 [start, start + span]，不多不少。
    //
    // 正因为如此，缝隙**不受圆头半径约束**——上一条用例量的「相邻段着色间距
    // == SEGMENT_GAP_RAD」对任何正值都成立。（曾在这里断言缝隙必须宽过半个
    // stroke，那是错的：它把「圆头外溢」当成了约束，而内缩之后并不存在外溢。）
    const v = view({
      details: [
        { name: 'a', cycleEndTime: farDay(0), remain: 50, size: 100, used: 50 },
        { name: 'b', cycleEndTime: farDay(3), remain: 20, size: 100, used: 80 },
      ],
    })
    const { container } = renderRings(v)
    const expected = daySegments(v)
    // 按天数对上号再比：跳过空天后，DOM 顺序与数组下标不再是"第几天 = 下标"。
    const groups = Array.from(container.querySelectorAll('[data-day-segment]'))
    expect(groups).toHaveLength(2)
    for (const group of groups) {
      const day = Number(group.getAttribute('data-day-segment'))
      const want = expected.find(s => s.day === day)!
      const range = paintedRange(group.querySelector('circle')!)
      expect(range.start).toBeCloseTo(want.start, 6)
      expect(range.start + range.angle).toBeCloseTo(want.start + want.span, 6)
    }
  })

  it('wraps instead of squashing, and leaves centring to the container', () => {
    // 弹窗内容列放不下「220px 圆环 + 图例」时，图例必须折到第二行而不是把圆环挤扁。
    // 居中**不在这里**做：插件详情页其余各行左对齐，圆环整组居中会脱节；弹窗那条
    // `.cb-usage-modal [data-usage-rings]{justify-content:center}` 见 CodeBuddyTab。
    const { container } = renderRings()
    const wrap = container.querySelector('[data-usage-rings]') as HTMLElement
    const style = wrap.getAttribute('style') ?? ''
    expect(style).toContain('flex-wrap: wrap')
    expect(style).not.toContain('justify-content: center')
  })

  it('keeps each legend value next to its label instead of pushed to the far edge', () => {
    // 用户报的「label 与数值距离太远」：标签原来是 flex:1，会把数值一路推到容器
    // 最右边，容器越宽离得越远。改成网格后四列各自成列、列间距恒定 8px。
    const { container } = renderRings()
    const legend = container.querySelector('[data-usage-rings] > div') as HTMLElement
    const style = legend.getAttribute('style') ?? ''
    expect(style).toContain('display: grid')
    expect(style).toContain('column-gap: 8px')
    // 图例贴合内容（不是 flex:1 拉伸），否则右侧会多出一块死白。
    expect(style).toContain('flex: 0 1 auto')
    // 同一行的标签与数值是**相邻**的网格项，中间没有撑开的元素。
    const children = Array.from(legend.children)
    const labelIndex = children.findIndex(child => child.textContent === en.totalUsed)
    expect(labelIndex).toBeGreaterThan(-1)
    const label = children[labelIndex] as HTMLElement
    const value = children[labelIndex + 1] as HTMLElement
    // 标签不再带 flex-grow：它是网格项，宽度由内容决定。
    expect(label.getAttribute('style')).not.toContain('flex')
    expect(value.textContent).toBe('1000 / 2000')
    // 同一套列模板让所有行共用列宽（原先单独一条用例只断言了这一行，setup 与上
    // 面完全重复，故并入此处）。
    expect(style).toContain('grid-template-columns: 8px auto auto auto')
  })

  it('grows each arc from zero on open, and stays static under reduced motion', () => {
    // 用户要的「打开增加一个动画过程」：弧长从 0 顺时针长出来。
    const { container } = renderRings()
    const arcs = Array.from(container.querySelectorAll('.cb-ring-arc'))
    expect(arcs.length).toBeGreaterThan(0)
    for (const arc of arcs) {
      const style = arc.getAttribute('style') ?? ''
      // 起点是「整圈」（不可见），终点是该元素自己的终值；两者由内联变量给出，
      // 所以同一条 keyframes 能服务半径各异的弧。
      expect(style).toContain('--cb-from')
      expect(style).toContain('--cb-to')
    }
    // 动画声明在样式表里、且包在 prefers-reduced-motion 守卫内——
    // 静态几何（inline 的 dashoffset 终值）不依赖动画，reduced-motion 下照常显示。
    const css = container.ownerDocument.querySelector('style[data-plugin-css*="rings"]')?.textContent ?? ''
    expect(css).toContain('cb-ring-grow')
    expect(css).toContain('prefers-reduced-motion')
  })

  it('holds each ring long enough to read, not a blink', () => {
    // 用户报的「两个内环的动画时间太短」：620ms 里一圈还没扫完眼睛就跟丢了。
    const { container } = renderRings()
    const css = container.ownerDocument.querySelector('style[data-plugin-css*="rings"]')?.textContent ?? ''
    const duration = Number(/cb-ring-grow\s+(\d+)ms/.exec(css)?.[1])
    expect(Number.isNaN(duration), '样式表里应能读出生长动画时长').toBe(false)
    expect(duration).toBeGreaterThanOrEqual(1000)
  })

  it('sweeps the outer ring as one arc from 12 o’clock, not seven cascades', () => {
    const { container } = renderRings(view({
      details: [
        { name: 'a', cycleEndTime: farDay(0), remain: 50, size: 100, used: 50 },
        { name: 'b', cycleEndTime: farDay(3), remain: 20, size: 100, used: 80 },
      ],
    }))
    const sweep = container.querySelector('[data-ring-sweep]')
    expect(sweep).not.toBeNull()
    const radius = Number(sweep?.getAttribute('r'))
    const total = 2 * Math.PI * radius
    // 终值是「整圈」：dashoffset 归零，扫满一整周而不是停在某一段。
    expect(sweep?.getAttribute('style')).toContain('--cb-to: 0')
    expect(sweep?.getAttribute('stroke-dasharray')).toBe(`${total} ${total}`)
    // 起点落在 12 点方向，顺时针为正——与内/中环同一个起手。
    expect(sweep?.getAttribute('transform')).toBe('rotate(-90 110 110)')
    // 外环自己不再逐段播动画：全环只有遮罩里那一条弧带 keyframes。
    const dayArcs = Array.from(container.querySelectorAll('[data-day-segment] circle, [data-day-progress] circle'))
    expect(dayArcs.length).toBeGreaterThan(0)
    for (const arc of dayArcs) {
      expect(arc.getAttribute('style') ?? '').not.toContain('--cb-from')
    }
  })

  it('shows the whole segmented ring from the start, and only sweeps colour in', () => {
    // 用户报的「每段都是扫到了再出现」：把中性轨也关进扫光遮罩里，整环就得先被扫一遍
    // 才成形，读的人会以为这个环还不存在。正确形态与内/中环一致——轨道先在，
    // 实心弧再长；这里断的就是「谁在遮罩里、谁在遮罩外」。
    const { container } = renderRings(view({
      details: [
        { name: 'a', cycleEndTime: farDay(0), remain: 50, size: 100, used: 50 },
        { name: 'b', cycleEndTime: farDay(3), remain: 20, size: 100, used: 80 },
      ],
    }))
    // 唯一挂遮罩的元素（<mask> 本身带的是 id，不是 mask 属性）。
    const masked = container.querySelector('[mask]')
    expect(masked).not.toBeNull()
    // 7 天中性轨全在遮罩之外 → 开场即可见。
    const tracks = Array.from(container.querySelectorAll('[data-day-segment]'))
    expect(tracks).toHaveLength(2)
    for (const track of tracks) expect(masked?.contains(track)).toBe(false)
    // 已用彩色弧全在遮罩之内 → 跟着 12 点那道扫光逐段变过去。
    const progress = Array.from(container.querySelectorAll('[data-day-progress]'))
    expect(progress).toHaveLength(2)
    for (const arc of progress) expect(masked?.contains(arc)).toBe(true)
  })

  it('still colours each day only up to its used ratio', () => {
    // 「进度到哪里变色到哪里」这条不因为改成整体扫光而变：彩色弧照旧静态画满到
    // usedRatio，剩下的段宽仍是中性轨，扫光只改变「什么时候变过去」。
    const { container } = renderRings(view({
      details: [{ name: 'a', cycleEndTime: farDay(0), remain: 50, size: 100, used: 50 }],
    }))
    const track = container.querySelector('[data-day-segment="0"] circle')!
    const progress = container.querySelector('[data-day-progress="0"] circle')!
    // 整段 + 半段（usedRatio 0.5），彩色弧恰好是中性轨的一半，不是整段。
    expect(paintedRange(progress).angle).toBeCloseTo(paintedRange(track).angle / 2, 6)
    expect(progress.getAttribute('stroke')).toBe(EXPIRY_COLORS[0])
    // 两者起点必须重合，否则「颜色从段首开始铺」这条读法就断了。
    expect(progress.getAttribute('transform')).toBe(track.getAttribute('transform'))
  })

  it('staggers the three rings inner-to-outer, one animated arc per ring', () => {
    const { container } = renderRings()
    // 每个环**只有一条**带动画的弧：内环、中环，外环那条是遮罩里的扫光。
    // 段各自播动画时这个数会涨到十几条，正是「分段进度」的成因。
    const arcs = Array.from(container.querySelectorAll('.cb-ring-arc'))
    expect(arcs).toHaveLength(3)
    // React 序列化后的形式是 `animation-delay: 0ms;`——冒号后有一个空格。
    const delayOf = (arc: Element): number =>
      Number(/animation-delay:\s*(\d+)ms/.exec(arc.getAttribute('style') ?? '')?.[1])
    // **按延迟本身断，不按文档顺序**：扫光活在 <defs> 里，排在最前面。
    const delays = arcs.map(delayOf).sort((a, b) => a - b)
    expect(delays[0]).toBe(0)
    expect(delays[0]).toBeLessThan(delays[1] as number)
    expect(delays[1]).toBeLessThan(delays[2] as number)
    expect(delayOf(container.querySelector('[data-ring-sweep]')!)).toBe(delays[2])
  })

})
