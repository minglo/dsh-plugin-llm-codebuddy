// client 端消费的手写 TypertRemoteContribution
// 形状与官方生成产物（@deepseek-ai/dsh-*-llm 的 typert.remote-client.js）同款：
// 每个 param/result codec 都是 { mode: 'strict', typeSymbol, schema }，供
// dsh-api-gateway client 的 $mount validateContribution（requireStrictDescriptor）通过。
import { z } from 'zod'
import type { InvocationDescriptor, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'

const NS = 'codebuddy'
const SERVICE = 'codebuddy'
const PACKAGE = 'dsh-plugin-llm-codebuddy'

function id(method: string): string {
  return `${PACKAGE}#${NS}/${method}`
}

function symbol(method: string, key: string): string {
  return `${PACKAGE}#${NS}/${method}:${key}`
}

const usageBucketSchema = z.object({
  expiring: z.number(),
  used: z.number(),
  size: z.number(),
  usedRatio: z.number(),
})

const usageViewSchema = z.object({
  totalBalance: z.number(),
  totalSize: z.number(),
  totalUsed: z.number(),
  totalUsedRatio: z.number(),
  monthPool: usageBucketSchema,
  monthPoolRemain: z.number(),
  monthPoolExpiring: z.number(),
  tomorrowExpiring: z.number(),
  dayAfterExpiring: z.number(),
  weekExpiring: z.number(),
  tomorrow: usageBucketSchema,
  dayAfter: usageBucketSchema,
  week: usageBucketSchema,
  details: z.array(z.object({
    name: z.string(),
    cycleEndTime: z.string(),
    remain: z.number(),
    size: z.number(),
    used: z.number(),
  })),
})

/**
 * 每个 result/param 都是 strict codec。0.1.7 的 TypertCodec 把 `schema` 换成
 * `create: () => TypertSchema`（进程域 schema 首次跨界时再物化）；宿主侧
 * dsh-api-gateway 会执行 `codec.create().parse(value)`。
 */
function strict(method: string, key: string, schema: z.ZodType<unknown>): { mode: 'strict'; typeSymbol: string; create: () => z.ZodType<unknown> } {
  return { mode: 'strict', typeSymbol: symbol(method, key), create: () => schema }
}

function direct(method: string, options: {
  result: z.ZodType<unknown>
  parameters?: readonly {
    name: string
    wire: string
    source: 'json'
    codec: { mode: 'strict'; typeSymbol: string; create: () => z.ZodType<unknown> }
  }[]
}): InvocationDescriptor {
  return {
    id: id(method),
    service: SERVICE,
    namespace: NS,
    method,
    invocation: { kind: 'direct' },
    parameters: options.parameters ?? [],
    result: strict(method, 'result', options.result),
  }
}

export const TYPERT_REMOTE: TypertRemoteContribution = {
  package: PACKAGE,
  descriptors: [
    direct('status', {
      result: z.object({
        loggedIn: z.boolean(),
        userId: z.string().optional(),
        tenantId: z.string().optional(),
        enterpriseId: z.string().optional(),
        // 生效态徽标：必须 optional——旧 host 不发该字段，strict codec 会拒掉
        // undefined 之外的缺失值；客户端按 undefined 处理为「不渲染徽标」。
        searchBackend: z.enum(['codebuddy', 'default', 'unavailable']).optional(),
      }),
    }),
    direct('usage', {
      result: z.object({
        loggedIn: z.boolean(),
        view: usageViewSchema.optional(),
      }),
    }),
    direct('startLogin', {
      result: z.object({ authUrl: z.string(), state: z.string() }),
    }),
    direct('pollLogin', {
      parameters: [{
        name: 'state',
        wire: 'state',
        source: 'json',
        codec: strict('pollLogin', 'state', z.string()),
      }],
      result: z.object({ done: z.boolean() }),
    }),
    direct('logout', {
      // Host 返回 undefined；client 侧 result schema 仅作占位（结果不 decode），仍须 strict。
      result: z.object({}),
    }),
    direct('getSettings', {
      result: z.object({ showUsage: z.boolean(), webSearch: z.boolean() }),
    }),
    direct('setSettings', {
      parameters: [{
        name: 'patch',
        wire: 'patch',
        source: 'json',
        // 局部更新：两个字段都可选（客户端只送被切换的那一个）。
        codec: strict('setSettings', 'patch', z.object({
          showUsage: z.boolean().optional(),
          webSearch: z.boolean().optional(),
        })),
      }],
      // Host 返回 undefined；client 侧 result schema 仅作占位（结果不 decode），仍须 strict。
      result: z.object({}),
    }),
  ],
}

export default TYPERT_REMOTE
