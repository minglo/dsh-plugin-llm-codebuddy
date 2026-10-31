// 渠道健康态的持久化：一个 storage domain + 一个内存降级实现。
//
// 为什么不自己写盘：`withFileLock` + `writeFileAtomic` 把平台差异（Windows 的
// rename 语义、POSIX 的目录 fsync、路径分隔符、权限位）全压在本插件身上。DSH 的
// storage 层已经把这些做完了，而且宿主默认挂载（dsh-base 里 `storage-json` 的
// root = `$DSH_HOME/storages`）。
//
// 已知代价：storage 后端**没有跨进程写锁**（官方 json 后端 README 的「已知限制」：
// 两个进程写同一单元时最后完成者胜）。健康态因此是单进程语义——`web` 与 `cli`
// 同时记拦截时会有一方被覆盖。换掉的是本插件对三套操作系统磁盘语义的所有权。
//
// 形状选择：`per-record` 布局 + 两条固定 key 的记录。
//   · `blocks/recent` —— 最近 20 条拦截，一次写整份数组；
//   · `probes/last`   —— 上次探针结论。
// 两条记录分开，因为它们本来就互不污染：`saveProbeResult` 绝不碰拦截历史，
// 拦截历史也绝不碰探针结论。
//
// `per-record` 顺带给了 `backup-and-skip`：某条记录过不了 schema 时，storage 层
// 把它的文档移成 `.bak.<stamp>` 再继续启动，而不是让整个 domain 打不开、
// 卡片永远空白。
import { readFile, rm } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
// 类型增强：`ctx.storageDomain` 由 @deepseek-ai/dsh-storage-domain 挂载。
import type {} from '@deepseek-ai/dsh-storage-domain'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { z } from 'zod'
import { FINGERPRINT_GUESSES } from './channel-fingerprint.js'
import type { ChannelBlockRecord, ProbeResultView } from './remote-types.js'

/**
 * 落盘后仅供宿主内部使用的健康态。
 *
 * 比 `ChannelHealthView` 多留了 `recentBlocks` 与完整的 `lastBlock`：请求 id 与
 * endpoint 是用户报障时唯一能复查的证据，但它们也只对宿主有意义，不往浏览器发。
 */
export interface StoredHealth {
  lastProbe?: ProbeResultView
  lastBlock?: ChannelBlockRecord
  recentBlocks: ChannelBlockRecord[]
}

/** `blocks` 表的存储形状：只存数组，`lastBlock` 由读取方从末项推导。 */
export interface BlockLog {
  recentBlocks: ChannelBlockRecord[]
}

/**
 * `recentBlocks` 的上限。够看出「从什么时候开始拦、拦的形状有没有变」，
 * 又不至于让记录无限长——它跟着用户一起进备份，不是日志。
 */
export const RECENT_BLOCK_LIMIT = 20

/**
 * 拦截记录的 schema。
 *
 * `fingerprintGuess` 用闭集：下游卡片按三值渲染，`'garbage'` 没有对应文案。
 * `requestId` / `sentUserId` 可选，但「有」的时候必须是字符串——手改成数字的
 * 42 会被下游当成 id 去查，而它根本不是任何一次请求的回执。
 */
const blockSchema = z.object({
  at: z.number(),
  requestId: z.string().optional(),
  sentUserId: z.string().optional(),
  endpoint: z.string(),
  systemLength: z.number(),
  fingerprintGuess: z.enum(FINGERPRINT_GUESSES),
})

/**
 * 单个阶段观察值的 schema。
 *
 * 与 remote-descriptors 的 codec 同形（optional 字段缺省合法）。`Array.isArray`
 * 只保证外面是数组：`stages: [null]` 这样的手改内容会原样穿过数组校验，然后在
 * 卡片里被当成 ProbeStage 读字段。
 */
const stageSchema = z.object({
  stage: z.enum(['A', 'B', 'C']),
  status: z.number().optional(),
  code: z.number().optional(),
  requestId: z.string().optional(),
  quota: z.boolean().optional(),
})

/**
 * 探针结论的 schema。
 *
 * `verdict` 只查「是不是字符串」，不逐条比对枚举：客户端本来就必须容忍一个
 * 它不认识的 verdict（新宿主给旧浏览器发新结论），读盘这侧若枚举化，等于给磁盘
 * 内容加上一个只能随枚举一起改的隐式版本约束。枚举收窄发生在下发的 wire codec。
 */
const probeSchema = z.object({
  verdict: z.string(),
  at: z.number(),
  model: z.string(),
  stages: z.array(stageSchema),
})

const blockLogSchema = z.object({ recentBlocks: z.array(blockSchema) })

/**
 * 健康态的 domain。
 *
 * 版本 1 = 本文件当前的记录形状。表名与 key 都是介质上的路径片段
 * （`$DSH_HOME/storages/codebuddy_channel_health/<table>/<key>.json`），
 * 因此必须匹配 `[a-z][a-z0-9_]*` / `[a-zA-Z0-9_-]+`。
 */
export const channelHealthDomainSpec = defineDomain({
  name: 'codebuddy_channel_health',
  version: 1,
  layout: 'per-record',
  // 坏记录是一份旁路诊断，不该让插件起不来：storage 层会把它的文档移成
  // `.bak.<stamp>` 并记一条日志，然后用空记录继续。
  invalidRecords: 'backup-and-skip',
  tables: {
    blocks: domainTable<string, BlockLog>(blockLogSchema as unknown as z.ZodType<BlockLog>),
    probes: domainTable<string, ProbeResultView>(probeSchema as unknown as z.ZodType<ProbeResultView>),
  },
})

const BLOCKS_KEY = 'recent'
const PROBES_KEY = 'last'

/**
 * 健康态的读写面。
 *
 * 两张表各有自己的写方法，而不是一个 `write(whole)`：一次真实拦截不该重写
 * 探针结论，一次自检也不该重写拦截历史。
 */
export interface ChannelHealthStore {
  /** 组装成宿主使用的视图；`lastBlock` 从 `recentBlocks` 末项推导。 */
  read(): StoredHealth
  /** 整份替换拦截历史（一次写，20 条截断由调用方完成）。 */
  writeBlocks(log: BlockLog): Promise<void>
  /** 只替换探针结论。 */
  writeProbe(result: ProbeResultView): Promise<void>
  /** 释放底层句柄；内存实现是空操作。 */
  close(): Promise<void>
}

/** 把两块记录拼成 `StoredHealth`。`lastBlock` 是冗余的，永远取数组末项。 */
function compose(recentBlocks: ChannelBlockRecord[], probe: ProbeResultView | undefined): StoredHealth {
  const lastBlock = recentBlocks[recentBlocks.length - 1]
  return {
    recentBlocks,
    ...lastBlock === undefined ? {} : { lastBlock },
    ...probe === undefined ? {} : { lastProbe: probe },
  }
}

/**
 * 没有 storage 层时的实现（headless、最小 profile、测试）。
 *
 * 只活在进程内：重启即丢。这条降级路径是刻意保留的——`storageDomain` 是可选
 * 设施，而健康态是诊断旁路，不值得让整个 provider 因为它缺席而不激活。
 */
export function memoryChannelHealthStore(): ChannelHealthStore {
  let recentBlocks: ChannelBlockRecord[] = []
  let probe: ProbeResultView | undefined
  return {
    read: () => compose(recentBlocks, probe),
    writeBlocks: async (log) => { recentBlocks = [...log.recentBlocks] },
    writeProbe: async (result) => { probe = result },
    close: async () => undefined,
  }
}

/**
 * 打开真实的 storage domain；宿主没挂 `storageDomain` 时退回内存实现。
 *
 * 弱读而不是 `inject: ['storageDomain']`：`storage-domain` 属于 base bundle，
 * 但 headless 与最小 profile 不保证有它，而本插件的主线（LLM 适配器）不该被
 * 一份诊断数据的存储能力绑死。
 */
export async function openChannelHealthStore(ctx: Context): Promise<ChannelHealthStore> {
  const facility = ctx.get('storageDomain') as Context['storageDomain'] | undefined
  if (facility === undefined) return memoryChannelHealthStore()

  const domain = await facility.open(channelHealthDomainSpec)
  const blocks = domain.table('blocks')
  const probes = domain.table('probes')
  return {
    read: () => compose(blocks.get(BLOCKS_KEY)?.recentBlocks ?? [], probes.get(PROBES_KEY)),
    writeBlocks: (log) => blocks.put(BLOCKS_KEY, log),
    writeProbe: (result) => probes.put(PROBES_KEY, result),
    close: () => domain.close(),
  }
}

/**
 * 每个 Context 一份 store，首次使用时打开并记住结果。
 *
 * 用 WeakMap 而不是模块级变量：`apply()` 是同步的，open 是异步的，塞不进
 * apply；而模块级单例会让「同一进程里多个 Context」互相串味（测试尤其明显）。
 * 打开失败也记住——健康态是旁路，一次 open 失败不该让每次请求都重试一遍。
 */
const stores = new WeakMap<Context, Promise<ChannelHealthStore>>()

/**
 * 取（必要时打开）该 Context 的健康态存储。
 *
 * 打开失败才降级到内存；**迁移失败照常冒给调用方**——那说明旧数据这次没写进去，
 * 静默吞掉等于让用户的历史无声消失。迁移是幂等的，下一次调用还会再试。
 * @param ctx - 插件上下文；用于解析 `storageDomain`。
 * @returns 该 Context 唯一的 store。
 */
export function channelHealthStoreOf(ctx: Context): Promise<ChannelHealthStore> {
  let opened = stores.get(ctx)
  if (opened === undefined) {
    opened = openChannelHealthStore(ctx).catch(() => memoryChannelHealthStore())
    stores.set(ctx, opened)
  }
  return opened.then(async (store) => {
    await migrateLegacy(store)
    return store
  })
}

/** 1.2.x 及更早版本的健康态文件名，位于 `$DSH_HOME` 根下。 */
const LEGACY_FILENAME = 'codebuddy-channel-health.json'

/**
 * 宽松读旧文件。**刻意不抛**：损坏、缺字段、被手改成别的形状，一律当作没有。
 *
 * 与迁移前的 `readUnlocked` 同语义，只把逐字段守卫换成了 zod 的 `safeParse`
 * ——两者必须一致，否则迁移会给新存储塞进它自己在 open 时拒绝的记录。
 * @param path - 旧文件路径。
 * @returns 可迁移的拦截历史与探针结论；读不出时都是空。
 */
async function readLegacy(path: string): Promise<{ blocks: ChannelBlockRecord[]; probe?: ProbeResultView }> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    return { blocks: [] }
  }
  // Windows 编辑器给 UTF-8 加 BOM 是常态，`JSON.parse` 见到 U+FEFF 会直接抛。
  // 只剥开头这一个字符：JSON 字符串正文里的 U+FEFF 是合法内容。
  if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1)
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { blocks: [] }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { blocks: [] }
  const record = parsed as Record<string, unknown>

  const blocks: ChannelBlockRecord[] = []
  if (Array.isArray(record.recentBlocks)) {
    for (const entry of record.recentBlocks) {
      const ok = blockSchema.safeParse(entry)
      if (ok.success) blocks.push(ok.data as ChannelBlockRecord)
    }
  }
  // 旧格式的 `lastBlock` 是独立字段，可能与 `recentBlocks` 不同步。新形状把它
  // 推导成数组末项，所以只在这个块比末项更新时才补进去，不覆盖已有历史。
  const lastBlock = blockSchema.safeParse(record.lastBlock)
  if (lastBlock.success) {
    const parsedBlock = lastBlock.data as ChannelBlockRecord
    const tail = blocks[blocks.length - 1]
    if (tail === undefined || parsedBlock.at > tail.at) blocks.push(parsedBlock)
  }
  const probe = probeSchema.safeParse(record.lastProbe)
  return {
    blocks,
    ...probe.success ? { probe: probe.data as ProbeResultView } : {},
  }
}

/**
 * 一次性的旧文件迁移。
 *
 * 迁移条件很窄：**新存储两块记录都为空**时才读旧文件。这样重复执行是幂等的，
 * 也不会覆盖用户已经在新路径上积累的历史。
 *
 * 旧文件在迁移成功后删除。删除失败只吞掉：数据已经在库里了，留一个多余的文件
 * 比让启动路径抛错好；下次启动会因为「新存储非空」而跳过迁移，那个文件就一直
 * 留着——不理想，但不会造成数据错误。
 *
 * 写失败**不吞**：迁移是读-写-删三步，中间失败时旧文件还在、新存储可能只有一半。
 * 冒给调用方比静默留一个半态好；下一次调用会重跑（新存储仍非空时按上面的条件
 * 跳过，所以不会重复追加）。
 * @param store - 已打开的 store。
 */
async function migrateLegacy(store: ChannelHealthStore): Promise<void> {
  const current = store.read()
  if (current.recentBlocks.length > 0 || current.lastProbe !== undefined) return

  const legacyPath = dshHomePath(LEGACY_FILENAME)
  const legacy = await readLegacy(legacyPath)
  if (legacy.blocks.length === 0 && legacy.probe === undefined) return

  if (legacy.blocks.length > 0) {
    await store.writeBlocks({ recentBlocks: legacy.blocks.slice(-RECENT_BLOCK_LIMIT) })
  }
  if (legacy.probe !== undefined) await store.writeProbe(legacy.probe)
  try {
    await rm(legacyPath, { force: true })
  } catch {
    // 见函数注释：迁移已完成，残留文件不影响正确性。
  }
}
