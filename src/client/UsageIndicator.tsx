import { useEffect, useState, useSyncExternalStore, createElement as h } from 'react'
import type { HTMLAttributes, ReactNode } from 'react'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { SettingsView, UsageResult } from '../remote-types.js'
import { subscribeUsagePrefChange } from './notifiers.js'
import { formatCredits, unwrap } from './shared.js'
import { monthColor, tint } from './palette.js'
import { toReading } from './usage-metrics.js'
import { EMPTY_USAGE_SNAPSHOT, usageFeed, type UsageSnapshot } from './usage-feed.js'

export interface UsageIndicatorInjected {
  remote: {
    usage(): Promise<RemoteResult<UsageResult>>
    getSettings(): Promise<RemoteResult<SettingsView>>
  }
  t: (key: string) => string
}

type Props = PropsRuntime<'sidebar.footer.action'> & InjectFace<UsageIndicatorInjected>

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
export function UsageIndicator({ remote, t, wide }: Props): ReactNode {
  // 初值与 schema 默认一致（**关**）：读取偏好前的首帧不能先显示出来再消失，
  // 那会让默认关掉的用户看到一个闪烁的指示器。
  const [showUsage, setShowUsage] = useState<boolean>(false)

  useEffect(() => {
    void unwrap(remote.getSettings())
      // `?? false`：旧 host 不发该字段时按 schema 默认（关）处理。裸读会得到
      // undefined，`showUsage ? ...` 判成假值虽然结果相同，但那属于巧合而非约定。
      .then(s => setShowUsage(s.showUsage ?? false))
      .catch(() => setShowUsage(false))
  }, [remote])

  // 开关变化（设置页切换成功后 emitUsagePrefChange）：重读偏好并据此启停订阅。
  useEffect(() => subscribeUsagePrefChange(() => {
    void unwrap(remote.getSettings())
      .then(s => setShowUsage(s.showUsage ?? false))
      .catch(() => setShowUsage(false))
  }), [remote])

  // 读数来自共享 feed：与输入框胶囊同一次请求，不再各开一个定时器。
  // 未显示时不订阅——开关关掉的入口不产生任何外呼，也不读共享读数。
  const feed = usageFeed(remote)
  const snapshot = useSyncExternalStore(
    showUsage ? feed.subscribe : NO_SUBSCRIPTION,
    showUsage ? feed.getSnapshot : noSnapshot,
    showUsage ? feed.getSnapshot : noSnapshot,
  )
  const reading = snapshot.loggedIn ? toReading(snapshot.view) : undefined

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

/** 关闭态：不订阅任何东西，也不读共享读数（开关关掉的入口零成本）。 */
const NO_SUBSCRIPTION = (): (() => void) => () => {}
const noSnapshot = (): UsageSnapshot => EMPTY_USAGE_SNAPSHOT
