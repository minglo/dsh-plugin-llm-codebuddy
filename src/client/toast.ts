/**
 * 一次性提示条（宿主 Toast 原语）的最小封装。
 *
 * 为什么要有这层：Toast 是「自报完成」的组件——它自己播完动画后调 `onDone`，
 * 宿主（也就是本插件）要在这时把它卸载。而「同一段文字再显示一次」需要
 * **重挂载**才能重新开始动画周期，原语自己也这么说（用 per-show 序号做 key）。
 * 于是每处调用方都要自己维护「序号 + 卸载」两件事——那是同一段样板。
 *
 * 这里把它收成一个 hook：调用方拿 `show(text)` 与 `element`，把 element 渲染
 * 到自己那棵树里即可。
 */
import { useCallback, useState } from 'react'
import { createElement as h } from 'react'
import type { ReactNode } from 'react'
import { Toast } from '@deepseek-ai/dsh-client-ui-primitives'

/** 一次提示的序号：同一段文字再次显示时靠它重挂载、重新开始动画周期。 */
interface ToastState {
  text: string
  seq: number
}

export interface ToastHandle {
  /** 显示一条提示（同一段文字连着显示两次会重新开始动画）。 */
  show: (text: string) => void
  /** 渲染元素：调用方把它放进自己的树里（不渲染就等于没显示）。 */
  element: ReactNode
}

export function useToast(): ToastHandle {
  const [state, setState] = useState<ToastState | undefined>(undefined)
  const show = useCallback((text: string) => {
    setState(previous => ({ text, seq: (previous?.seq ?? 0) + 1 }))
  }, [])
  const element = state === undefined
    ? null
    : h(Toast, {
      key: state.seq,
      text: state.text,
      onDone: () => { setState(undefined) },
    })
  return { show, element }
}
