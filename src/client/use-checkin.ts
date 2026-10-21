/**
 * 签到的客户端接线：两处入口（插件配置页、输入框弹层）共用同一套行为。
 *
 * 行为只有四条，但每条都有讲究，所以收在这里而不是各写一遍：
 *
 * 1. **只有「读得到」且「活动开启」时圆心才可点。** 前者是接口可用性，后者是
 *    账号是否参与这个活动——不是一回事，都为真才给入口。
 * 2. **成功才刷新读数。** 签到会加积分，额度读数因此过期，要重新取一次；
 *    失败时读数没变，刷新只是白跑一次外呼。
 * 3. **失败才提示。** 成功是「颜色变了」这一事实，不需要再弹一条提示去重复它。
 * 4. **提示里带服务端的原因**（若有）。本地化的那句是主语，服务端那句是细节；
 *    网络错误没有服务端原因，就只有本地化的那一句。
 */
import { useCallback, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { checkinFeed, type CheckinRemote, type CheckinSnapshot } from './checkin-feed.js'
import { useToast } from './toast.js'

export interface CheckinBinding {
  /** 今日是否已签到（已签到时圆心铺填充色、按钮 disabled）。 */
  checked: boolean
  /** 是否给出签到入口：读得到状态、且账号参与这个活动。 */
  available: boolean
  /** 签到请求在飞：按钮 disabled，防双击发出两次写请求。 */
  pending: boolean
  /** 点圆心。 */
  onCheckin: () => void
  /** 失败提示条的元素（调用方渲染它）。 */
  toast: ReactNode
}

export function useCheckin(
  remote: CheckinRemote,
  t: (key: string) => string,
  options: { enabled?: boolean; onSuccess?: () => void | Promise<void> } = {},
): CheckinBinding {
  const feed = checkinFeed(remote)
  // 关掉的入口不订阅：订了就会在首个订阅者进来时读一次签到态——那是白跑的一趟外呼。
  const enabled = options.enabled !== false
  const snapshot = useSyncExternalStore(
    enabled ? feed.subscribe : NO_SUBSCRIPTION,
    enabled ? feed.getSnapshot : noSnapshot,
    enabled ? feed.getSnapshot : noSnapshot,
  )
  const { show, element } = useToast()

  const onCheckin = useCallback(() => {
    void (async () => {
      const result = await feed.checkin()
      if (result.ok) {
        // 签到加了积分，额度读数过期：重新取一次。失败时读数没变，不刷新。
        await options.onSuccess?.()
        return
      }
      const detail = result.message
      show(detail === undefined ? t('checkinFailed') : `${t('checkinFailed')} ${detail}`)
    })()
  }, [feed, options, show, t])

  return {
    checked: snapshot.checkedIn,
    available: snapshot.available && snapshot.active,
    pending: snapshot.pending,
    onCheckin,
    toast: element,
  }
}

/** 关掉时的稳定空态：必须是**同一个对象**，否则 useSyncExternalStore 每次都判成「变了」。 */
const EMPTY_SNAPSHOT: CheckinSnapshot = {
  available: false,
  active: false,
  checkedIn: false,
  streakDays: 0,
  dailyCredit: 0,
  todayCredit: 0,
  pending: false,
}
const noSnapshot = (): CheckinSnapshot => EMPTY_SNAPSHOT
const NO_SUBSCRIPTION = (): (() => void) => () => {}
