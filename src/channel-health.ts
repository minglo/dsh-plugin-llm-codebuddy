// 渠道健康态：`$DSH_HOME/codebuddy-channel-health.json` 的读写 + 三发诊断探针。
//
// 两件事放一起是因为它们共用同一份落盘形状；但依赖方向是单向的：
// 适配器只**类型** import `ChannelBlockRecord`（见 remote-types.ts），真正写盘的
// `recordChannelBlock` 由 index.ts 注入；探针、网络与判定表不会跟着进请求路径。
import { randomUUID } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { isQuotaExceededError } from '@deepseek-ai/dsh-llm'
import { deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { ESTABLISHED_FINGERPRINT, FINGERPRINT_GUESSES, rewriteHarnessIdentity } from './channel-fingerprint.js'
import { buildChatHeaders } from './chat-headers.js'
import { CHANNEL_REJECTION_CODE } from './constants.js'
import type { ChannelBlockRecord, ChannelVerdict, ProbeResultView, ProbeStage } from './remote-types.js'
import { resetAtFromText } from './reset-time.js'
import { NotLoggedInError, type CodeBuddySession } from './session.js'

/** 渠道健康态在 `$DSH_HOME` 下的文件名；拦截记录与探针结果共用这一份。 */
const CHANNEL_HEALTH_FILENAME = 'codebuddy-channel-health.json'

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

/**
 * `recentBlocks` 的上限。够看出「从什么时候开始拦、拦的形状有没有变」，
 * 又不至于让文件无限长——它跟着用户一起进备份，不是日志。
 */
const RECENT_BLOCK_LIMIT = 20

/**
 * 落盘路径每次现算，不在模块顶层求值：`DSH_HOME` 由 launch environment 注入，
 * 在测试里也会被逐用例改写，模块级常量会把它固化成进程启动时的那个值。
 */
function channelHealthPath(): string {
  return dshHomePath(CHANNEL_HEALTH_FILENAME)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 结构上确实是拦截记录吗？
 *
 * 文件是明文的、可被手改的——下游（卡片）拿到一条 `fingerprintGuess: 'garbage'`
 * 会渲染出什么都不确定的文案。宁可当作没这一条。
 */
function isChannelBlockRecord(value: unknown): value is ChannelBlockRecord {
  if (!isObject(value)) return false
  return typeof value.at === 'number'
    // requestId 是可选的，但「有」的时候必须是字符串：手改成数字的 42 会被
    // 下游当成 id 去查，而它根本不是任何一次请求的回执。
    && (value.requestId === undefined || typeof value.requestId === 'string')
    && typeof value.endpoint === 'string'
    && typeof value.systemLength === 'number'
    // 与 remote.ts 的 isDisplayableBlock 共用同一份闭集：两处各列一份，新增
    // 一个取值时总有一边会漏，漏的那边会把合法记录当成坏数据扔掉。
    && typeof value.fingerprintGuess === 'string'
    && (FINGERPRINT_GUESSES as readonly string[]).includes(value.fingerprintGuess)
}

/**
 * 单个阶段观察值的结构复核。
 *
 * `Array.isArray(stages)` 只保证外面是数组：`stages: [null]` 这样的手改内容会
 * 原样穿过守卫，然后在卡片里被当成 ProbeStage 读字段。逐字段查一遍，形状必须
 * 与 remote-descriptors 的 codec 一致（optional 字段缺省合法）。
 */
function isProbeStageView(value: unknown): value is ProbeStage {
  if (!isObject(value)) return false
  return (value.stage === 'A' || value.stage === 'B' || value.stage === 'C')
    && (value.status === undefined || typeof value.status === 'number')
    && (value.code === undefined || typeof value.code === 'number')
    && (value.requestId === undefined || typeof value.requestId === 'string')
    && (value.quota === undefined || typeof value.quota === 'boolean')
}

/**
 * 结构上确实是一次探针结果吗？
 *
 * `verdict` 只查「是不是字符串」，不逐条比对枚举：客户端本来就必须容忍一个
 * 它不认识的 verdict（新宿主给旧浏览器发新结论），读盘这侧若枚举化，等于给磁盘
 * 内容加上一个只能随枚举一起改的隐式版本约束。
 */
function isProbeResultView(value: unknown): value is ProbeResultView {
  return isObject(value)
    && typeof value.verdict === 'string'
    && typeof value.at === 'number'
    && typeof value.model === 'string'
    && Array.isArray(value.stages)
    && value.stages.every(isProbeStageView)
}

/**
 * 读盘。**刻意宽松**：文件缺失、JSON 损坏、字段被手改成别的形状，一律当作
 * 「还没有记录」，而不是抛错——卡片该显示「没有」，不该因为一份旁路数据读不出来
 * 就整张消失。
 *
 * 也**不检查文件权限**：权限被人为放宽的文件照样要读得出来，收紧发生在下一次
 * 写入（`writeFileAtomic` 会用新 inode 的 0600 覆盖掉旧 mode）。
 */
async function readUnlocked(path: string): Promise<StoredHealth> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    return { recentBlocks: [] }
  }
  // 我们自己写的是无 BOM 的 UTF-8，但 Windows 编辑器给 UTF-8 加 BOM 是常态：
  // `JSON.parse` 见到开头的 U+FEFF 会直接抛错，整份记录于是落进下面的「无记录」
  // 分支——宽容的代价是历史被静默清空，而这段历史正是用户报障时唯一的证据。
  // 只剥开头这一个字符：JSON 字符串正文里的 U+FEFF 是合法内容，不能动。
  //
  // UTF-16（PowerShell 5.1 的 `Out-File` 默认）按 utf8 读是乱码，同样解析失败、
  // 同样降级为「无记录」。这里**刻意不做 BOM 嗅探与转码**：写入端固定 utf8，
  // 读侧只承诺读回自己写出的文件；手改成 UTF-16 的降级是有意划下的边界，
  // 不是漏掉的分支。
  if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1)
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { recentBlocks: [] }
  }
  if (!isObject(parsed)) return { recentBlocks: [] }

  const stored: StoredHealth = {
    recentBlocks: Array.isArray(parsed.recentBlocks)
      ? parsed.recentBlocks.filter(isChannelBlockRecord)
      : [],
  }
  if (isChannelBlockRecord(parsed.lastBlock)) stored.lastBlock = parsed.lastBlock
  if (isProbeResultView(parsed.lastProbe)) stored.lastProbe = parsed.lastProbe
  return stored
}

/**
 * 一次加锁的 read-modify-write。
 *
 * 锁不是可选的：同一进程里多个会话都会记拦截，各自「读→改→写」会把对方刚追加的
 * 那条覆盖掉——丢的正好是唯一的证据。读者不需要锁：`writeFileAtomic` 用 rename
 * 提交，读到的要么是旧内容要么是新内容，不会是半个文件。
 */
async function mutateHealth(change: (current: StoredHealth) => StoredHealth): Promise<void> {
  const path = channelHealthPath()
  // 父目录先建：锁是在 `<file>.lock` 上 `wx` 创建的，它不会替我们建目录——只有锁内的
  // `writeFileAtomic` 会，而那时已经晚了。$DSH_HOME 尚不存在时（全新安装、测试、被清空
  // 过），少了这一句，第一条真实拦截就以 ENOENT 丢掉，而它正是这个功能存在的理由。
  // 0700：这里放的是诊断数据，没有理由让同机其它用户列目录。
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await withFileLock(path, async () => {
    const next = change(await readUnlocked(path))
    // 0600：文件里是 endpoint 与请求 id，虽不含凭据，也没有理由让同机其它用户读。
    await writeFileAtomic(path, JSON.stringify(next, null, 2), { mode: 0o600 })
  })
}

/** 读当前健康态；读不到就是空记录。 */
export async function readChannelHealth(): Promise<StoredHealth> {
  return readUnlocked(channelHealthPath())
}

/**
 * 记下一条真实请求被渠道校验拒收的现场。
 *
 * `lastBlock` 与 `recentBlocks` 一起更新：前者给卡片显示「上次拦截」，
 * 后者留一段历史，用来判断规则是刚开始收紧还是早就如此。
 */
export async function recordChannelBlock(record: ChannelBlockRecord): Promise<void> {
  await mutateHealth((current) => ({
    ...current,
    lastBlock: record,
    recentBlocks: [...current.recentBlocks, record].slice(-RECENT_BLOCK_LIMIT),
  }))
}

/**
 * 只写 `lastProbe`。
 *
 * **探针自己撞上的 11128 绝不进 `lastBlock`**：那是自检请求被拦，回答的是
 * 「现在会不会被拦」，不是用户真实请求的现场；混进去会让卡片把一次主动探测
 * 说成「你的请求被拒了」。所以这里连 `lastBlock` / `recentBlocks` 都不碰。
 */
export async function saveProbeResult(result: ProbeResultView): Promise<void> {
  await mutateHealth((current) => ({ ...current, lastProbe: result }))
}

/**
 * 探针单轮的私有死线。列表里没有它的位置是因为只有这里用一个值；
 * `constants.ts` 收的是跨模块共享的业务常量。
 */
const PROBE_TIMEOUT_MS = 15_000

/**
 * 本探针死线的私有 code。
 *
 * 必须能和调用方的取消分开：`timeoutOf` 只认带本 code 的 `TimeoutReason`，
 * 用户切走导致的 abort 因此不会被误判成「超时 / 连不上」。
 */
const PROBE_TIMEOUT_CODE = 'CODEBUDDY_PROBE_TIMEOUT'

/** 三个阶段共用的 user 正文：只够让上游跑一次最小推理。 */
const PROBE_PROMPT = 'ping'

/**
 * 探针需要的外界：一个能提供凭据与模型目录的会话，以及 chat base 地址。
 *
 * 不导出：只有本文件的 runProbe / sendStage 读它。probeChannel 的声明会把它
 * 收进 dist/index.d.ts，但外部调用方按结构化类型传对象即可，不需要这个名字。
 */
interface ProbeDeps {
  session: CodeBuddySession
  baseURL: string
  /**
   * 诊断旁路的告警出口（宿主日志）。
   *
   * 只用于「结果算出来了但没写进盘」这类不该改变请求结果的问题：探针已经花掉
   * 三次请求并得出真实结论，不能因为一份旁路文件写不进去就把结论丢掉。
   */
  warn?: (message: string) => void
}

/**
 * 从错误响应体里读上游信封的 `code`。
 *
 * 数字与数字字符串都认：同一网关的不同错误路径会用两种拼写，只收一种会让
 * 「400 + `code:"11128"`」漏判成未分类失败。不按文案匹配——文案会被上游改。
 * @param text - 非空响应体原文。
 * @returns 信封里的业务码，读不出时 undefined。
 */
function envelopeCode(text: string): number | undefined {
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed === 'object' && parsed !== null && 'code' in parsed) {
      const code = (parsed as { code?: unknown }).code
      if (typeof code === 'number') return code
      // 只收纯数字串：`Number('0x10')`、`Number('')` 都会算出看似合法的值，
      // 那会把一段无关文案变成一个业务码。
      if (typeof code === 'string' && /^\d+$/.test(code)) return Number(code)
    }
  } catch {
    // 不是 JSON：没有 code 可读，交给 HTTP 状态归类。
  }
  return undefined
}

/**
 * `Retry-After` 是否给出了可读的重置时刻。
 *
 * 与适配器 `providerRetryAfterMs` 同口径：秒数，或一个在未来的 HTTP 日期。
 * 这里只关心「读不读得出」，具体等多久由调用方的重试策略裁决。
 * @param value - 响应头原文，缺失时为 null。
 * @returns 是否存在一个可用的未来时刻。
 */
function retryAfterReadable(value: string | null): boolean {
  if (value === null || value.trim().length === 0) return false
  if (/^\d+$/.test(value)) return Number(value) > 0
  const at = Date.parse(value)
  return Number.isFinite(at) && at > Date.now()
}

/**
 * 发一个阶段的最小请求，把观察值原样记下来。
 *
 * 成功时**必须** cancel body：不读也不 cancel 会把这条连接挂到 idle 超时，
 * 三次探针就能同时压着三条空闲连接。失败时才读 body——`code` 与额度措辞都在里面。
 * @param stage - 阶段标识。
 * @param system - system 正文；A 阶段没有 system。
 * @param deps - 探针依赖。
 * @param model - 本次使用的模型 id。
 * @param conversationId - 本轮探针自己的会话标识，三发共用。
 * @param signal - 调用方的取消信号。
 * @returns 该阶段的观察值；fetch 抛错时只有 stage 字段。
 */
async function sendStage(
  stage: ProbeStage['stage'],
  system: string | undefined,
  deps: ProbeDeps,
  model: string,
  conversationId: string,
  signal: AbortSignal | undefined,
): Promise<ProbeStage> {
  // 凭据解析刻意放在传输 try **之外**：它失败说明登录态出了问题，根本没有 HTTP
  // 裁决。把它和网络故障一起吞掉，用户会被告知「连不上网关」——真正该说的是
  // 「请先登录」。NotLoggedInError 原样冒给 runProbe 归成 auth；其它凭据错误
  // （如刷新端点不可达）也一律上抛，绝不伪装成一次传输观测。
  //
  // X-Conversation-ID 必须按真实请求带上：设计第二阶段会把它变成无条件发送，
  // 到那天探针自动继承；现在提前发，探针量的才是真实请求的头集合，而不是一组
  // 用户请求根本不会发出的头——否则「请求头/客户端身份不合规」这个结论没有依据。
  const headers = buildChatHeaders(
    await deps.session.authHeaders(),
    { model, sessionId: conversationId },
  )
  const probeDeadline = deadline(signal, PROBE_TIMEOUT_MS, PROBE_TIMEOUT_CODE)
  try {
    let response: Response
    try {
      response = await fetch(`${deps.baseURL}/chat/completions`, {
        method: 'POST',
        headers,
        // 刻意不经过 serializeRequest：探针要的是受控的最小体，不是一次真实对话。
        // max_tokens: 1 让三发合计的消耗可以忽略，也让「通过」本身不依赖模型输出。
        body: JSON.stringify({
          model,
          messages: system === undefined
            ? [{ role: 'user', content: PROBE_PROMPT }]
            : [{ role: 'system', content: system }, { role: 'user', content: PROBE_PROMPT }],
          stream: true,
          max_tokens: 1,
        }),
        signal: probeDeadline.signal,
      })
    } catch (error: unknown) {
      // 先认自己的死线：只有带本 code 的超时才是一条「网关不可达」的观测。
      if (timeoutOf(probeDeadline.signal, PROBE_TIMEOUT_CODE) !== undefined) return { stage }
      // 调用方取消（用户切走）不是网络观测：抛出去，绝不落盘成 verdict。
      // 落盘会让下次开卡片报一个用户自己造成的假故障。
      if (signal?.aborted) throw signal.reason ?? error
      // 其余网络错误：没有 status，交给 judgeStages 的 netFailure 一侧。
      return { stage }
    }

    const requestId = response.headers.get('x-request-id')
    // 只记确实给出的回执 id：`null` 不是 id，写进去会让复核的人去找一个不存在的值。
    const observed: ProbeStage = {
      stage,
      status: response.status,
      ...requestId === null ? {} : { requestId },
    }
    if (response.ok) {
      // 不 await：探针不关心流内容，cancel 只是把连接尽快还给连接池。
      void response.body?.cancel()
      return observed
    }

    let text: string
    try {
      text = await response.text()
    } catch (error: unknown) {
      // 读 body 期间也可能被调用方取消：同上，不把它记成观测。
      if (signal?.aborted) throw signal.reason ?? error
      // 读不出 body：状态码已在，照样能归类（只是少了 code 与额度线索）。
      text = ''
    }
    const code = envelopeCode(text)
    // 429 + 可读的重置时刻 = 限流，哪怕报文同时带 quota 措辞：适配器的
    // `failureCode` 也把这一组合归为 RATE_LIMIT（保留重置时刻比一句「额度用尽」
    // 更有用）。读不出重置时刻时才让 quota 胜出——那是真正的额度耗尽。
    const clockResets = response.status === 429
      && (resetAtFromText(text) !== undefined || retryAfterReadable(response.headers.get('retry-after')))
    return {
      ...observed,
      ...code === undefined ? {} : { code },
      // 额度判定交给宿主已有的措辞分类器：写死 14018/14019 没有仓库内证据。
      ...isQuotaExceededError(text) && !clockResets ? { quota: true } : {},
    }
  } finally {
    // 响应头已到（或请求已失败 / 已取消）：清掉 timer，别让它拖住进程退出。
    probeDeadline[Symbol.dispose]()
  }
}

/** A 阶段的观察值是否为「裸请求也被拒收」。 */
function isChannelBlocked(stage: ProbeStage | undefined): boolean {
  // 必须同时是 400：500 的 body 里也可能抄着同一个 code（网关透传上游错误），
  // 只看 code 会把一次服务端故障说成「你的请求头不合规」。
  return stage?.status === 400 && stage.code === CHANNEL_REJECTION_CODE
}

/**
 * 把三阶段的观察值判成一个结论。
 *
 * **纯函数**：不发请求、不读上游文案，只看 `status` / `code` / `quota` 三个字段，
 * 所以判定表可以逐行单测。顺序即设计文档 §5 的行序，另有跨行优先级：
 * `quota` > `auth` > `rate-limited` > `channel-rejected` > 表内结论。
 *
 * 额度排最前有实测依据：内容审核发生在额度检查**之前**，所以「被拦 + 额度也尽了」
 * 时上游报的是额度——同时出现两种信号时，额度才是真正原因。
 *
 * `auth` / `rate-limited` 只看 A：A 已返回 200 就证明凭据与频率都没问题，
 * 此时 B/C 的 401/429 是「这次自检在后续阶段撞上了别的问题」，按 stage-failed
 * 报，不能反过来否定刚刚通过的 A。
 * @param stages - 探针记录下来的阶段观察值。
 * @param netFailure - 仅在 fetch 抛错、且确有阶段没拿到 status 时传 `'unreachable'`。
 * @returns 判定结论。
 */
export function judgeStages(stages: ProbeStage[], netFailure?: 'unreachable'): ChannelVerdict {
  const find = (target: ProbeStage['stage']): ProbeStage | undefined =>
    stages.find(candidate => candidate.stage === target)
  const a = find('A')

  if (stages.some(candidate => candidate.quota === true)) return 'quota'
  if (a?.status === 401 || a?.status === 403) return 'auth'
  if (a?.status === 429) return 'rate-limited'
  // 有 status 的阶段一律按表判；只有整轮都没观察到任何状态码时才是「连不上」。
  // 混合情形（A 有状态、B/C 没有）不算：A 已经证明网关可达。
  if (netFailure === 'unreachable' && stages.every(candidate => candidate.status === undefined)) {
    return 'unreachable'
  }

  if (a?.status !== 200) {
    // A 不 200：B/C 根本没跑（或跑了也被同一个前置问题污染），只能按 A 归类。
    return isChannelBlocked(a) ? 'channel-rejected' : 'unavailable'
  }

  const b = find('B')
  const c = find('C')
  if (b?.status === 200 && c?.status === 200) return 'rule-gone'
  if (isChannelBlocked(b) && isChannelBlocked(c)) return 'neutralization-broken'
  if (b?.status === 200 && isChannelBlocked(c)) return 'inconsistent'
  if (isChannelBlocked(b) && c?.status === 200) return 'healthy'
  // 剩下的是「A 通了，但 B/C 里有一个坏在与渠道校验无关的地方」。
  return 'stage-failed'
}

/**
 * 真正跑一轮三发探针。
 *
 * 阶段之间不留并发：A 的结果决定 B/C 是否还有意义，且三发合计的额度消耗
 * 没必要再乘上一个并发系数。
 * @param deps - 探针依赖（session、chat base 与告警出口）。
 * @param signal - 调用方的取消信号。
 * @returns 探针结果；写入 `lastProbe` 失败不影响返回。
 */
async function runProbe(deps: ProbeDeps, signal?: AbortSignal): Promise<ProbeResultView> {
  const models = await deps.session.modelsOrEmpty()
  const model = models[0]?.id ?? ''
  if (model === '') {
    // 空目录有两种来源，`modelsOrEmptyWith` 的返回形状分不出来：
    //   · 真的没登录 / 凭据已被拒绝；
    //   · 目录从未成功读过（网络抖动、配置端点故障）——此时账号可能完全正常。
    // 把后者报成 auth，就是让一个已登录用户去重新登录；Task 5 已经为 authHeaders()
    // 修过同一类谎话，这里不能又犯一次。
    //
    // authHeaders() 只解析身份（必要时刷新），不发目录请求，正好用来区分：
    //   · NotLoggedInError —— 凭据确实不能被认证 → auth；
    //   · 其它错误（刷新端点不可达等）—— 凭据没有被拒绝，只是基础设施坏了 →
    //     原样上抛，让调用方看到真实错误，绝不伪装成 auth；
    //   · 成功 —— 账号已认证，坏的是目录。A 阶段只需要一个模型 id，而目录是唯一
    //     给出 id 的来源；没有 id 就发不出合法的 A（空 model 会被上游直接拒绝），
    //     所以保留早退，但结论是 unavailable（「没测成」），不是 auth。
    try {
      await deps.session.authHeaders()
    } catch (error: unknown) {
      if (error instanceof NotLoggedInError) {
        return { verdict: 'auth', at: Date.now(), model: '', stages: [] }
      }
      throw error
    }
    return { verdict: 'unavailable', at: Date.now(), model: '', stages: [] }
  }

  // 探针自己的会话标识：三发共用同一个，网关的亲和路由与 prefix-cache 才会像
  // 一次真实对话那样把它们串起来。随机 UUID 保证不会与任何真实 session id 撞上
  // ——探针不该借用用户的会话，也不该在网关侧被当成用户会话的一部分。
  const conversationId = randomUUID()

  // B 发未中和的指纹，C 发我们此刻真正会发出去的那份。B 必须 import 同一份原文，
  // 否则探的就是另一个东西：上游规则再收紧时，这里不会跟着变红。
  const raw = ESTABLISHED_FINGERPRINT
  const stages: ProbeStage[] = []
  try {
    stages.push(await sendStage('A', undefined, deps, model, conversationId, signal))
    if (stages[0]?.status === 200) {
      stages.push(await sendStage('B', raw, deps, model, conversationId, signal))
      stages.push(await sendStage('C', rewriteHarnessIdentity(raw), deps, model, conversationId, signal))
    }
  } catch (error: unknown) {
    if (error instanceof NotLoggedInError) {
      // 凭据过期是「请先登录」，不是「连不上网关」。已经发生的阶段照样带回去，
      // 但不落盘：这不是一次渠道观测，覆盖 lastProbe 会抹掉上一次真正跑完的结论。
      return { verdict: 'auth', at: Date.now(), model, stages }
    }
    // 调用方取消等其它异常继续上抛：Task 6 的调用方负责接住，不留下假 verdict。
    throw error
  }

  // 有阶段没拿到 status 只可能是 fetch 抛了。传给判定函数时它会先确认整轮都无状态，
  // 所以 B/C 单独超时不会被误报成「连不上网关」。
  const netFailure = stages.some(candidate => candidate.status === undefined) ? 'unreachable' : undefined
  const result: ProbeResultView = {
    verdict: judgeStages(stages, netFailure),
    at: Date.now(),
    model,
    stages,
  }
  // 落盘是旁路：三次请求已经花掉、结论已经算出来，写盘失败（磁盘满、权限、
  // $DSH_HOME 被换成文件）只该进 warn，不该让 probe() 拒绝并丢掉这次读数。
  try {
    await saveProbeResult(result)
  } catch (error: unknown) {
    deps.warn?.(`channel probe: saving the result failed: ${String(error)}`)
  }
  return result
}

/**
 * 模块级单飞：用户连点按钮时复用同一轮，而不是再扣一遍额度。
 *
 * 放在模块级而不是实例字段：remote 服务是单例，但探针不该依赖调用方记得去重。
 */
let inFlight: Promise<ProbeResultView> | undefined

/**
 * 跑一次三发诊断探针。
 *
 * 只由用户动作触发；本函数自身不做任何定时或首屏调用。
 * @param deps - 探针依赖（session、chat base 与告警出口）。
 * @param signal - 调用方的取消信号。
 * @returns 探针结果（写入 `lastProbe` 是尽力而为）。
 */
export function probeChannel(deps: ProbeDeps, signal?: AbortSignal): Promise<ProbeResultView> {
  if (inFlight !== undefined) return inFlight
  // `.finally` 里无条件清空：探针失败也要允许下一次重试，否则一次网络抖动会把
  // 自检永久锁在失败态。
  inFlight = runProbe(deps, signal).finally(() => { inFlight = undefined })
  return inFlight
}
