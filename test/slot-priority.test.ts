import { describe, expect, it } from 'vitest'
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-model-selection/client'

/**
 * single 槽的 shadowing 语义（宿主既有行为的刻画，不是本插件的实现）。
 *
 * 这条测的是「priority: -1」这个设计的**地基**：`conversation.input.model.label`
 * 是 single 槽，同一格里同优先级再注册会**抛错**，而不是后者覆盖前者。抛错
 * 会让整个客户端 fiber 挂掉，输入框里所有东西一起消失——比标签难看严重得多。
 * 所以本插件必须用 -1 从官方 `ui-deepseek-model-label-1017`（默认 0）手里
 * 赢下这一格；以下两条就是「0 会炸」与「-1 能赢」的直接证据。
 */

const Seat = () => null
const Official = () => null
const Ours = () => null

/** 建一个声明了 label 子槽的座位模型，返回 core。 */
function coreWithSeat(): SlotCore {
  const core = new SlotCore()
  // 裸 SlotCore 只有 root 一个先验声明；真实宿主里 `conversation.input.model`
  // 由 composer 座位声明。这里先用 root 的 children 把它声明出来，才能再往
  // 这个座位里注册（否则 register 会以「slot is not declared」拒绝）。
  core.register({
    name: 'root',
    children: { 'conversation.input.model': { kind: 'single', scope: 'session' } },
  }, Seat)
  core.register({
    name: 'conversation.input.model',
    children: { 'conversation.input.model.label': { kind: 'single', scope: 'session' } },
  }, Seat)
  return core
}

describe('single 槽的 shadowing 语义', () => {
  it('同优先级二次注册抛错', () => {
    const core = coreWithSeat()
    core.register({ name: 'conversation.input.model.label' }, Official) // 默认优先级 0
    expect(() => core.register({ name: 'conversation.input.model.label' }, Ours)).toThrow()
  })

  it('不同优先级可以共存，数值最小的渲染', () => {
    const core = coreWithSeat()
    core.register({ name: 'conversation.input.model.label' }, Official) // 官方占着 0
    core.register({ name: 'conversation.input.model.label', priority: -1 }, Ours)
    expect(core.entriesOfSlot('conversation.input.model.label')[0]?.component).toBe(Ours)
  })
})
