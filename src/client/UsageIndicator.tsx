import { useEffect, useState, createElement as h } from 'react'
import type { HTMLAttributes, ReactNode } from 'react'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { SettingsView, UsageResult } from '../remote-types.js'
import { subscribeLoginChange, subscribeUsagePrefChange } from './CodeBuddyTab.jsx'
import { finiteOr, formatCredits, unwrap, withTimeout } from './shared.js'
import { monthColor, SEGMENT_COLORS, tint } from './palette.js'

export interface UsageIndicatorInjected {
  remote: {
    usage(): Promise<RemoteResult<UsageResult>>
    getSettings(): Promise<RemoteResult<SettingsView>>
  }
  t: (key: string) => string
}

type Props = PropsRuntime<'sidebar.footer.action'> & InjectFace<UsageIndicatorInjected>

const READ_TIMEOUT_MS = 15_000

/** 段太窄时不渲染段内百分比：截断的「5(」比留白更难读，精确值仍在 tooltip 里。
 * 侧栏展开态两条合计约 160px，扣除三段间隙后每段能容纳「100%」的最小占比约 18%。
 */
const MIN_SEGMENT_LABEL_SHARE = 0.18

const s = {
  stack: { display: 'flex', flexDirection: 'column', gap: '5px', padding: '0 12px', width: '100%', boxSizing: 'border-box' as const },
  // 第一条：本月剩余 | 进度条 | 比例。
  wrap: { display: 'flex', alignItems: 'center', gap: '8px', height: '14px' },
  rowLabel: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)', flexShrink: 0, minWidth: '52px' },
  bar: { position: 'relative' as const, flex: 1, height: '6px', borderRadius: '999px', background: 'var(--dsw-alias-border-l2)', overflow: 'hidden' as const },
  fill: { position: 'absolute' as const, inset: 0, transformOrigin: 'left', transition: 'width 240ms ease' },
  pct: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)', minWidth: '34px', textAlign: 'right' as const },
  // 第二条：最近剩余 | 三段复合条（段内显示各自已用%）。
  segBar: { position: 'relative' as const, flex: 1, display: 'flex', gap: '2px', height: '13px', borderRadius: '999px', overflow: 'hidden' as const, background: 'var(--dsw-alias-border-l2)' },
  segment: { position: 'relative' as const, height: '100%', overflow: 'hidden' as const, display: 'flex', alignItems: 'center', justifyContent: 'center' },
  segFill: { position: 'absolute' as const, left: 0, top: 0, bottom: 0, transition: 'width 240ms ease' },
  segText: { position: 'relative' as const, fontSize: '9px', lineHeight: '13px', color: 'var(--dsw-alias-label-primary)', whiteSpace: 'nowrap' as const },
  rail: { display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', height: '36px' },
}

/** 侧边栏读数：总剩余 + 本月到期池 + 派生占比 + 互斥到期段。 */
interface UsageReading {
  /** 总剩余（未过期包余额合计）。 */
  totalBalance: number
  /** 本月到期池剩余（月底前不用就清零的部分）。 */
  monthRemain: number
  /** 本月已用 / 池 size（月度消耗率）。 */
  monthUsed: number
  monthSize: number
  monthUsedRatio: number
  /** 复合条：本月段占「总剩余」的宽长比例（clamp [0,1]）。 */
  monthShare: number
  /** 第二条复合条的三段（互斥区间，size>0 的才保留）。 */
  expiring: ExpiringSegment[]
}

/** 一个互斥到期段：`≤1天` / `1–2天` / `2–7天`。 */
interface ExpiringSegment {
  /** locale 键（段名，仅在 tooltip 展示）。 */
  key: string
  used: number
  size: number
  /** used / size，clamp [0,1]。 */
  usedRatio: number
  /** 段宽占整条的比例：按该段额度大小分配。 */
  share: number
  color: string
}

/**
 * 把 host 的**累计**窗口（7天 ⊇ 2天 ⊇ 1天）折成**互斥**三段。
 *
 * 累计值直接当三段用会重复计数（同一包在 ≤2天与 ≤7天里各算一次），且三段之和不等于
 * 任何有意义的整体。相邻两档相减即得互斥区间，且因同源同口径，相减不会遗漏或重复。
 */
export function exclusiveSegments(view: UsageResult['view']): ExpiringSegment[] {
  if (view === undefined) return []
  const cumulative = [
    { key: 'expiringWithin1d', bucket: view.tomorrow },
    { key: 'expiring1to2d', bucket: view.dayAfter },
    { key: 'expiring2to7d', bucket: view.week },
  ]
  const raw = cumulative.map(({ key, bucket }, index) => ({
    key,
    index,
    used: finiteOr(bucket?.used, 0),
    size: finiteOr(bucket?.size, 0),
  }))
  // 相邻相减并夹到非负：host 数据异常（后档小于前档）时按 0 处理，不产出负宽段。
  const exclusive = raw.map((segment, position) => {
    const previous = position === 0 ? undefined : raw[position - 1]
    return {
      key: segment.key,
      index: segment.index,
      used: Math.max(segment.used - (previous?.used ?? 0), 0),
      size: Math.max(segment.size - (previous?.size ?? 0), 0),
    }
  })
  const kept = exclusive.filter(segment => segment.size > 0)
  const total = kept.reduce((sum, segment) => sum + segment.size, 0)
  return kept.map(segment => ({
    key: segment.key,
    used: segment.used,
    size: segment.size,
    usedRatio: segment.size > 0 ? Math.min(Math.max(segment.used / segment.size, 0), 1) : 0,
    share: total > 0 ? segment.size / total : 0,
    color: SEGMENT_COLORS[segment.index % SEGMENT_COLORS.length] ?? SEGMENT_COLORS[0],
  }))
}

/**
 * 归一化 host 返回的 view：host 与 client 是两个独立产物（tsc / tsup 分别产出），
 * 只重建其一就会拿到缺字段的旧结构（如无 totalUsed / monthPool）。这里按「有则取、
 * 无则按剩余口径兜底」消化，避免一次版本错配让整个侧边栏抛 Cannot read properties of undefined。
 * 旧 host（无 monthPool）退化为「仅总剩余」，复合段与月度消耗率按 0 兜底、不抛。
 */
function toReading(view: UsageResult['view']): UsageReading | undefined {
  if (view === undefined) return undefined
  const totalBalance = view.totalBalance !== undefined ? finiteOr(view.totalBalance, 0) : finiteOr(view.totalSize, 0)
  const pool = view.monthPool
  const monthSize = pool !== undefined ? finiteOr(pool.size, 0) : 0
  const monthUsed = pool !== undefined ? finiteOr(pool.used, 0) : 0
  const monthRemain = view.monthPoolRemain !== undefined
    ? finiteOr(view.monthPoolRemain, 0)
    : pool !== undefined ? finiteOr(pool.expiring, 0) : 0
  const monthUsedRatio = monthSize > 0 ? Math.min(Math.max(monthUsed / monthSize, 0), 1) : 0
  const monthShare = totalBalance > 0 ? Math.min(Math.max(monthRemain / totalBalance, 0), 1) : 0
  return { totalBalance, monthRemain, monthUsed, monthSize, monthUsedRatio, monthShare, expiring: exclusiveSegments(view) }
}

export function UsageIndicator({ remote, t, wide }: Props): ReactNode {
  const [showUsage, setShowUsage] = useState<boolean>(true)
  const [reading, setReading] = useState<UsageReading | undefined>(undefined)
  const [refreshKey, setRefreshKey] = useState<number>(0)

  useEffect(() => {
    void unwrap(remote.getSettings()).then(s => setShowUsage(s.showUsage)).catch(() => setShowUsage(true))
  }, [remote])

  // C1：登录态变化（CodeBuddyTab 登录/退出成功后 emitLoginChange）立即重拉，
  // 不等下一次 60s 轮询。
  useEffect(() => subscribeLoginChange(() => setRefreshKey(k => k + 1)), [])

  // 开关变化（设置页切换成功后 emitUsagePrefChange）：重读偏好并据此启停轮询。
  useEffect(() => subscribeUsagePrefChange(() => {
    void unwrap(remote.getSettings()).then(s => setShowUsage(s.showUsage)).catch(() => setShowUsage(true))
  }), [remote])

  useEffect(() => {
    if (!showUsage) return
    let stopped = false
    const read = async (): Promise<void> => {
      if (stopped) return
      try {
        const u = await withTimeout(unwrap(remote.usage()), READ_TIMEOUT_MS)
        if (stopped || !u.loggedIn || u.view === undefined) { setReading(undefined); return }
        // 与 showUsageDesc「已用额度进度」对齐：已用 ÷ 未过期奖励积分合计。
        setReading(toReading(u.view))
      } catch {
        // 网关失败/本地故障：清空读数，等待下一轮轮询或登录态变化重试。
        if (stopped) return
        setReading(undefined)
      }
    }
    void read()
    const timer = window.setInterval(read, 60_000)
    return () => { stopped = true; window.clearInterval(timer) }
  }, [remote, showUsage, refreshKey])

  if (!showUsage || reading === undefined) return null
  const pct = Math.min(Math.max(reading.monthUsedRatio * 100, 0), 100)
  const monthPct = Math.min(Math.max(reading.monthShare * 100, 0), 100)
  const usedPct = Math.round(pct)
  const tooltip = [
    `${t('monthUsed')}: ${formatCredits(reading.monthUsed)} / ${t('monthUsedRate')}: ${usedPct}%`,
    `${t('monthPoolRemain')}: ${formatCredits(reading.monthRemain)} / ${t('monthSize')}: ${formatCredits(reading.monthSize)}`,
    `${t('totalBalance')}: ${formatCredits(reading.totalBalance)}`,
    // 段名只在此处出现（段内放百分比），故每段都给出名称与精确数值。
    ...reading.expiring.map(segment =>
      `${t(segment.key)}: ${formatCredits(segment.used)} / ${formatCredits(segment.size)} (${Math.round(segment.usedRatio * 100)}%)`),
  ].join('\n')

  if (wide) {
    // 复合条：灰轨 = 总剩余；高亮段 = 本月剩余（月底清零部分）——一眼看「总剩虽多，
    // 本月能自由花的只是一小段」。条长 = 本月段占总剩余的比例，非消耗率。
    const anchor = h('div', { style: s.stack } as HTMLAttributes<HTMLDivElement>,
      h('div', { style: s.wrap },
        h('span', { style: s.rowLabel }, t('monthPoolRemain')),
        h('div', { style: s.bar },
          h('div', { style: { ...s.fill, width: `${monthPct}%`, background: monthColor(reading.monthUsedRatio) } }),
        ),
        h('span', { style: s.pct }, `${Math.round(pct)}%`),
      ),
      // 第二条：同一进度条分三段（按额度大小分配宽度），每段显示自己的已用百分比。
      // 无任何短期到期包时整条隐藏，而不是留一条 0 宽的灰轨。
      reading.expiring.length === 0 ? null : h('div', { style: s.wrap },
        h('span', { style: s.rowLabel }, t('recentRemain')),
        h('div', { style: s.segBar },
          reading.expiring.map(segment => h('div', {
            key: segment.key,
            style: { ...s.segment, width: `${segment.share * 100}%`, background: tint(segment.color) },
            'data-expiring-segment': segment.key,
          },
            h('div', { style: { ...s.segFill, width: `${segment.usedRatio * 100}%`, background: segment.color } }),
            segment.share >= MIN_SEGMENT_LABEL_SHARE
              ? h('span', { style: s.segText }, `${Math.round(segment.usedRatio * 100)}%`)
              : null,
          )),
        ),
      ),
    )
    return h(Tooltip, { label: tooltip, side: 'top', children: anchor })
  }
  // 56px rail：只放迷你刻度 + 月度消耗率数字，双剩余数进 tooltip。
  return h(Tooltip, {
    label: tooltip,
    side: 'right',
    children: h('div', { style: s.rail } as HTMLAttributes<HTMLDivElement>, `${Math.round(pct)}%`),
  })
}
