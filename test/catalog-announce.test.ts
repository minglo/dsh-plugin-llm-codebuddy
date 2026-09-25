import { Context, Service } from '@deepseek-ai/cordis'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../src/index.js'
import { writeGrant } from '../src/auth.js'
import type { CodeBuddyGrant } from '../src/auth.js'

const scratchDirs: string[] = []

afterEach(() => {
  vi.unstubAllGlobals()
  for (const dir of scratchDirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* best-effort cleanup */ }
  }
})

/** llm seam 的最小替身：apply() 需要 registerAdapter。 */
class FakeLlm extends Service {
  static inject: string[] = []
  constructor(ctx: Context) { super(ctx, 'llm') }
  registerAdapter(): () => void { return () => {} }
}

function grant(): CodeBuddyGrant {
  const now = Date.now()
  return {
    accessToken: 'acc',
    expiresAt: now + 3_600_000,
    refreshToken: 'ref',
    refreshExpiresAt: now + 2_592_000_000,
    domain: 'tencent',
  }
}

function okConfig(models: { id: string, name: string }[]) {
  return { ok: true, status: 200, json: async () => ({ code: 0, msg: '', requestId: 'r', data: { models } }) }
}

async function compose(models: { id: string, name: string }[] = [{ id: 'm1', name: 'One' }]) {
  const dir = mkdtempSync(join(tmpdir(), 'cb-catalog-'))
  scratchDirs.push(dir)
  const ctx = new Context()
  await ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), watch: false })
  await writeGrant(ctx, grant())
  await ctx.plugin(FakeLlm)
  let current = models
  const setModels = (next: { id: string, name: string }[]): void => { current = next }
  vi.stubGlobal('fetch', vi.fn(async () => okConfig(current)))
  return { ctx, setModels }
}

const CATALOG_POLL_INTERVAL_MS = 5 * 60 * 1000

const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 50))

describe('apply() · catalog change announcements', () => {
  /**
   * 轮询周期是 5 分钟，真实等待不现实：用假定时器推进。
   * tick 内部的 refreshCatalog() 是异步的，所以用 advanceTimersByTimeAsync 让它有机会落地。
   */
  async function mountAndSettle(ctx: Context): Promise<void> {
    apply(ctx, {})
    await vi.advanceTimersByTimeAsync(0)
  }

  it('emits llm/adapters-updated when the catalog content changes', async () => {
    // 客户端是否能看到服务端编辑，全看这个事件：它的模型目录是客户端侧缓存的，
    // 只在 llm/adapters-updated 时才重拉。不重发，删掉的模型一直能选（选中即 400），
    // 新增的一直不出现，而且按 id 索引的富化表也跟不上，运气好出现了也是裸名字。
    vi.useFakeTimers()
    try {
      const { ctx, setModels } = await compose()
      const listener = vi.fn()
      ctx.on('llm/adapters-updated', listener)

      await mountAndSettle(ctx)
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000) // 轮询读到第一份目录
      expect(listener).not.toHaveBeenCalled() // 挂载后第一次读取：静默

      setModels([{ id: 'm1', name: 'One' }, { id: 'm2', name: 'Two' }])
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000) // 下一次轮询发现变化

      expect(listener).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('emits nothing while the catalog stays identical', async () => {
    // 无条件播报会让每个轮询周期都 churn 客户端的目录、分组与所有下游 surface。
    vi.useFakeTimers()
    try {
      const { ctx } = await compose()
      const listener = vi.fn()
      ctx.on('llm/adapters-updated', listener)

      await mountAndSettle(ctx)
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000 * 3) // 三个周期，内容一直没变

      expect(listener).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('clears the poll timer when the owning fiber is disposed', async () => {
    // 卸载后仍偷偷轮询会打扰已卸载的插件（并对已失效的 session 发起网络读取）。
    // 这里数真实的定时器：挂载 apply 应新增一个，dispose 后必须回到原数。
    vi.useFakeTimers()
    try {
      const { ctx } = await compose()
      let pluginFiber: { dispose: () => Promise<void> } | undefined

      const before = vi.getTimerCount()
      await ctx.inject(['llm'], async (scope) => {
        await scope.plugin(apply, {})
        pluginFiber = (scope as any).fiber
      })
      await vi.advanceTimersByTimeAsync(0)
      // 挂载后多出了轮询定时器（以及可能的其他内部定时器，> = 1 即可）。
      expect(vi.getTimerCount()).toBeGreaterThan(before)

      await pluginFiber!.dispose()
      // 关键断言：回到挂载前的数量，说明 effect 的 disposer 真的清掉了它。
      expect(vi.getTimerCount()).toBe(before)
    } finally {
      vi.useRealTimers()
    }
  })
})
