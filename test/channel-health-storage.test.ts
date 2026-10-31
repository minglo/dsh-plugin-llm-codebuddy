import { Context } from '@deepseek-ai/cordis'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
// 三个包的导出形状各不相同，导入方式必须逐个对齐：
//   · `dsh-storage` 只有 default（Service 子类）；
//   · `dsh-storage-json` / `dsh-storage-domain` 只有 apply/name/inject，没有 default。
// 混用会让 cordis 收到 undefined 并在 plugin() 里抛「invalid plugin」。
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import { readChannelHealth, recordChannelBlock, saveProbeResult } from '../src/channel-health.js'

/**
 * 真实 storage 栈的集成测试：一次「写、关、重开、读回」。
 *
 * 其余健康态用例都用内存介质，测的是本插件自己的记账逻辑；这一条补的是它们
 * 测不到的那一半——记录确实经过 `defineDomain` 的 schema 校验、落在 json 后端
 * 上、并且能在**新进程**（新 Context + 新 DomainFacility）里读回来。夹具形状
 * 与 table/key 名一旦写错，只有这里会红。
 */
describe('channel health on the real storage stack', () => {
  let ctx: Context | undefined

  afterEach(async () => {
    await ctx?.fiber.dispose()
    ctx = undefined
  })

  async function mount(root: string): Promise<Context> {
    const composed = new Context()
    await composed.plugin(Storage)
    await composed.plugin(StorageJson, { root })
    await composed.plugin(StorageDomain, { backend: 'json' })
    return composed
  }

  it('round-trips blocks and the probe verdict through a reopened domain', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cb-health-storage-'))
    ctx = await mount(root)
    await recordChannelBlock(ctx, {
      at: 1,
      requestId: 'r1',
      endpoint: 'https://copilot.tencent.com/v2',
      systemLength: 10,
      fingerprintGuess: 'identity-sentence',
    })
    await saveProbeResult(ctx, { verdict: 'healthy', at: 2, model: 'm1', stages: [{ stage: 'A', status: 200 }] })

    // 关掉整个栈再重开：内存态全丢，读回来的必须只有介质上的内容。
    await ctx.fiber.dispose()
    ctx = await mount(root)

    const stored = await readChannelHealth(ctx)
    expect(stored.recentBlocks).toEqual([
      { at: 1, requestId: 'r1', endpoint: 'https://copilot.tencent.com/v2', systemLength: 10, fingerprintGuess: 'identity-sentence' },
    ])
    expect(stored.lastBlock).toMatchObject({ at: 1 })
    expect(stored.lastProbe).toMatchObject({ verdict: 'healthy', stages: [{ stage: 'A', status: 200 }] })
  })

  it('keeps the twenty-block cap across a reopen', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cb-health-storage-'))
    ctx = await mount(root)
    for (let i = 0; i < 25; i++) {
      await recordChannelBlock(ctx, {
        at: i,
        endpoint: 'https://copilot.tencent.com/v2',
        systemLength: 10,
        fingerprintGuess: 'identity-sentence',
      })
    }

    await ctx.fiber.dispose()
    ctx = await mount(root)

    const stored = await readChannelHealth(ctx)
    expect(stored.recentBlocks.map((entry) => entry.at)).toEqual([5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24])
  })
})
