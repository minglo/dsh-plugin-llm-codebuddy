// client 端消费的手写 TypertRemoteContribution
// 形状与官方生成产物（@deepseek-ai/dsh-*-llm 的 typert.remote-client.js）同款：
// 每个 param/result codec 都是 { mode: 'strict', typeSymbol, schema }，供
// dsh-api-gateway client 的 $mount validateContribution（requireStrictDescriptor）通过。
// 具名导入而非 `import { z }`：zod 4 的 `z` 命名空间整体引用会让 esbuild 无法
// tree-shake，client bundle 从 ~140 KB 涨到 ~550 KB。这里只取实际用到的六个
// 构造器（`enum` 是保留字，必须别名）。
import { array, boolean, enum as zenum, number, object, string, type ZodType } from 'zod'
import type { InvocationDescriptor, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { FINGERPRINT_GUESSES } from './channel-fingerprint.js'
import { CHANNEL_VERDICTS } from './remote-types.js'
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

const usageBucketSchema = object({
  expiring: number(),
  used: number(),
  size: number(),
  usedRatio: number(),
})

const usageViewSchema = object({
  totalBalance: number(),
  totalSize: number(),
  totalUsed: number(),
  totalUsedRatio: number(),
  monthPool: usageBucketSchema,
  monthPoolRemain: number(),
  monthPoolExpiring: number(),
  tomorrowExpiring: number(),
  dayAfterExpiring: number(),
  weekExpiring: number(),
  tomorrow: usageBucketSchema,
  dayAfter: usageBucketSchema,
  week: usageBucketSchema,
  details: array(object({
    name: string(),
    cycleEndTime: string(),
    remain: number(),
    size: number(),
    used: number(),
  })),
})

/**
 * 判定的 11 个取值：5 个是本插件自己的判断，6 个是上游拒绝的归类
 * （见 remote-types.ts 的 ChannelVerdict）。
 *
 * 取值列表从共享常量取，不在此处重列：宿主下发前用同一份闭集复验读盘内容，
 * 两边各写一份的话，加一个 verdict 只改一边就会让新结论在 decode 阶段消失。
 *
 * 用 enum 而非 string：客户端要按结论分支渲染文案，一个拼错的 verdict
 * 会让整张卡片落到「未知」分支——不如在 decode 阶段就拒绝。
 */
const verdictSchema = zenum(CHANNEL_VERDICTS)

/**
 * 一次探针的 wire 形状。
 *
 * 阶段字段全部 optional：只有 fetch 抛错时阶段连 status 都没有，而那张
 * 「连不上」的观测同样必须能下发——否则最需要看的那次探测会在 decode 阶段消失。
 */
const probeResultSchema = object({
  verdict: verdictSchema,
  at: number(),
  model: string(),
  stages: array(object({
    stage: zenum(['A', 'B', 'C']),
    status: number().optional(),
    code: number().optional(),
    requestId: string().optional(),
    quota: boolean().optional(),
  })),
})

/**
 * 每个 result/param 都是 strict codec。0.1.7 的 TypertCodec 把 `schema` 换成
 * `create: () => TypertSchema`（进程域 schema 首次跨界时再物化）；宿主侧
 * dsh-api-gateway 会执行 `codec.create().parse(value)`。
 */
function strict(method: string, key: string, schema: ZodType<unknown>): { mode: 'strict'; typeSymbol: string; create: () => ZodType<unknown> } {
  return { mode: 'strict', typeSymbol: symbol(method, key), create: () => schema }
}

function direct(method: string, options: {
  result: ZodType<unknown>
  parameters?: readonly {
    name: string
    wire: string
    source: 'json'
    codec: { mode: 'strict'; typeSymbol: string; create: () => ZodType<unknown> }
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
      result: object({
        loggedIn: boolean(),
        userId: string().optional(),
        tenantId: string().optional(),
        enterpriseId: string().optional(),
        // 生效态徽标：必须 optional——旧 host 不发该字段，strict codec 会拒掉
        // undefined 之外的缺失值；客户端按 undefined 处理为「不渲染徽标」。
        searchBackend: zenum(['codebuddy', 'default', 'unavailable']).optional(),
      }),
    }),
    direct('usage', {
      result: object({
        loggedIn: boolean(),
        view: usageViewSchema.optional(),
        // 抓取时刻由宿主给（宿主缓存让一次抓取服务多个入口与多次重挂）。
        // optional：旧宿主不发它，客户端回落到本地时刻——写成必填会让
        // 「新 client + 旧 host」在 decode 阶段丢掉整份读数。
        fetchedAt: number().optional(),
      }),
    }),
    direct('startLogin', {
      result: object({ authUrl: string(), state: string() }),
    }),
    direct('pollLogin', {
      parameters: [{
        name: 'state',
        wire: 'state',
        source: 'json',
        codec: strict('pollLogin', 'state', string()),
      }],
      result: object({ done: boolean() }),
    }),
    direct('logout', {
      // Host 返回 undefined；client 侧 result schema 仅作占位（结果不 decode），仍须 strict。
      result: object({}),
    }),
    direct('getSettings', {
      result: object({
        showUsage: boolean(),
        // 与 status.searchBackend 同一条不变式：**必须 optional**。host 与 client 是
        // 两个独立产物，浏览器 bundle 经 HMR 先换、宿主模块要重启才换；把新字段写成
        // 必填，会让「新 client + 旧 host」的组合在 decode 阶段整张卡片静默消失。
        // 客户端按 undefined 处理为该功能的默认值（显示）。
        showComposerUsage: boolean().optional(),
        // 同上：429 等待开关。旧 host 不发 → 按默认（关）。
        waitOnRateLimit: boolean().optional(),
        webSearch: boolean(),
      }),
    }),
    direct('setSettings', {
      parameters: [{
        name: 'patch',
        wire: 'patch',
        source: 'json',
        // 局部更新：四个字段都可选（客户端只送被切换的那一个）。
        codec: strict('setSettings', 'patch', object({
          showUsage: boolean().optional(),
          showComposerUsage: boolean().optional(),
          waitOnRateLimit: boolean().optional(),
          webSearch: boolean().optional(),
        })),
      }],
      // Host 返回 undefined；client 侧 result schema 仅作占位（结果不 decode），仍须 strict。
      result: object({}),
    }),
    direct('models', {
      result: object({
        loggedIn: boolean(),
        models: array(object({
          id: string(),
          name: string(),
          // 倍率：base = 目录基础价，current = 当前生效价（促销价优先），
          // strikethrough = 基础价要不要划线，free = current 读作 0。
          rate: object({
            base: string().optional(),
            current: string().optional(),
            strikethrough: boolean(),
            free: boolean(),
          }).optional(),
          // 双语成对下发，客户端按自己的 active locale 挑（宿主不知道浏览器语言）。
          description: object({ zh: string().optional(), en: string().optional() }).optional(),
          promotion: object({
            label: string(),
            color: string(),
            text: object({ zh: string().optional(), en: string().optional() }).optional(),
            // 宿主把 schedule 格式化成一行（客户端不做日期运算）。
            window: string().optional(),
          }).optional(),
          tier: object({
            label: string(),
            text: object({ zh: string().optional(), en: string().optional() }).optional(),
          }).optional(),
        })),
      }),
    }),
    direct('checkinStatus', {
      result: object({
        // available（读到了吗）与 active（账号参与这个活动吗）是两件事，
        // 都要在 wire 上分开：前者为假时客户端连入口都不给。
        available: boolean(),
        active: boolean(),
        checkedIn: boolean(),
        streakDays: number(),
        dailyCredit: number(),
        todayCredit: number(),
      }),
    }),
    direct('checkin', {
      result: object({
        success: boolean(),
        // optional：成功时服务端不一定带 message。
        message: string().optional(),
        credit: number(),
        streakDays: number(),
      }),
    }),
    direct('channelHealth', {
      // 卡片首屏的只读数据：上次探针结论 + 上次真实拦截。**零外呼**，
      // 所以它和 probe 必须是两个方法——首屏不许触发三发诊断。
      result: object({
        // 本部署是否跑渠道校验（仅官方端点）；假时客户端整行隐藏。
        applicable: boolean(),
        lastProbe: probeResultSchema.optional(),
        // 刻意收窄：请求 id / endpoint 只在宿主落盘，浏览器不需要。
        lastBlock: object({
          at: number(),
          fingerprintGuess: zenum(FINGERPRINT_GUESSES),
        }).optional(),
      }),
    }),
    direct('probe', {
      // 只有用户点按钮才会走到这里；宿主不做定时或首屏自动调用。
      result: probeResultSchema,
    }),
  ],
}

export default TYPERT_REMOTE
