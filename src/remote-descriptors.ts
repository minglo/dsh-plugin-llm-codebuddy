// client 端消费的手写 TypertRemoteContribution
// 形状与官方生成产物（@deepseek-ai/dsh-*-llm 的 typert.remote-client.js）同款：
// 每个 param/result codec 都是 { mode: 'strict', typeSymbol, schema }，供
// dsh-api-gateway client 的 $mount validateContribution（requireStrictDescriptor）通过。
import { z } from 'zod'
import type { InvocationDescriptor, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { PACKAGE_NAME } from './constants.js'

const NS = 'codebuddy'
const SERVICE = 'codebuddy'
// 复用包名常量：与 package.json 的 name、dist 产物的 __ModuleLoader__.load({ id }) 同源。
const PACKAGE = PACKAGE_NAME

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
        // 抓取时刻由宿主给（宿主缓存让一次抓取服务多个入口与多次重挂）。
        // optional：旧宿主不发它，客户端回落到本地时刻——写成必填会让
        // 「新 client + 旧 host」在 decode 阶段丢掉整份读数。
        fetchedAt: z.number().optional(),
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
      result: z.object({
        showUsage: z.boolean(),
        // 与 status.searchBackend 同一条不变式：**必须 optional**。host 与 client 是
        // 两个独立产物，浏览器 bundle 经 HMR 先换、宿主模块要重启才换；把新字段写成
        // 必填，会让「新 client + 旧 host」的组合在 decode 阶段整张卡片静默消失。
        // 客户端按 undefined 处理为该功能的默认值（显示）。
        showComposerUsage: z.boolean().optional(),
        // 同上：429 等待开关。旧 host 不发 → 按默认（关）。
        waitOnRateLimit: z.boolean().optional(),
        webSearch: z.boolean(),
      }),
    }),
    direct('setSettings', {
      parameters: [{
        name: 'patch',
        wire: 'patch',
        source: 'json',
        // 局部更新：四个字段都可选（客户端只送被切换的那一个）。
        codec: strict('setSettings', 'patch', z.object({
          showUsage: z.boolean().optional(),
          showComposerUsage: z.boolean().optional(),
          waitOnRateLimit: z.boolean().optional(),
          webSearch: z.boolean().optional(),
        })),
      }],
      // Host 返回 undefined；client 侧 result schema 仅作占位（结果不 decode），仍须 strict。
      result: z.object({}),
    }),
    direct('models', {
      result: z.object({
        loggedIn: z.boolean(),
        models: z.array(z.object({
          id: z.string(),
          name: z.string(),
          // 倍率：base = 目录基础价，current = 当前生效价（促销价优先），
          // strikethrough = 基础价要不要划线，free = current 读作 0。
          rate: z.object({
            base: z.string().optional(),
            current: z.string().optional(),
            strikethrough: z.boolean(),
            free: z.boolean(),
          }).optional(),
          // 双语成对下发，客户端按自己的 active locale 挑（宿主不知道浏览器语言）。
          description: z.object({ zh: z.string().optional(), en: z.string().optional() }).optional(),
          promotion: z.object({
            label: z.string(),
            color: z.string(),
            text: z.object({ zh: z.string().optional(), en: z.string().optional() }).optional(),
            // 宿主把 schedule 格式化成一行（客户端不做日期运算）。
            window: z.string().optional(),
          }).optional(),
          tier: z.object({
            label: z.string(),
            text: z.object({ zh: z.string().optional(), en: z.string().optional() }).optional(),
          }).optional(),
        })),
      }),
    }),
    direct('checkinStatus', {
      result: z.object({
        // available（读到了吗）与 active（账号参与这个活动吗）是两件事，
        // 都要在 wire 上分开：前者为假时客户端连入口都不给。
        available: z.boolean(),
        active: z.boolean(),
        checkedIn: z.boolean(),
        streakDays: z.number(),
        dailyCredit: z.number(),
        todayCredit: z.number(),
      }),
    }),
    direct('checkin', {
      result: z.object({
        success: z.boolean(),
        // optional：成功时服务端不一定带 message。
        message: z.string().optional(),
        credit: z.number(),
        streakDays: z.number(),
      }),
    }),
  ],
}

export default TYPERT_REMOTE
