export const PACKAGE_NAME = 'dsh-plugin-llm-codebuddy'
export const PLUGIN_NAME = 'plugin-llm-codebuddy'
export const CODEBUDDY_PRODUCT = 'dsh-codebuddy'
export const CODEBUDDY_REPO_URL = 'https://github.com/minglo/dsh-plugin-llm-codebuddy'
export const CODEBUDDY_PROVIDER = 'codebuddy'
export const CODEBUDDY_DISPLAY_NAME = 'CodeBuddy'
export const CODEBUDDY_ENDPOINT = 'https://copilot.tencent.com'
export const CODEBUDDY_CHAT_BASE = `${CODEBUDDY_ENDPOINT}/v2`
/**
 * 上报给 CodeBuddy 网关的客户端身份。对齐 opencode 同款插件（其 config.ts 的
 * IDE_NAME/IDE_TYPE/IDE_VERSION、APP_VERSION），使服务端「使用记录」把它认成
 * VSCode 而不是未知客户端；两边版本号需手工保持一致。
 */
export const CODEBUDDY_IDE_NAME = 'VSCode'
/** 读取目录/用量时发送的 UA。chat 面另有 DSH 归属头，见 adapter 的 APP_IDENTITY。 */
export const CODEBUDDY_IDE_VERSION = '4.12.0'
/** 上报的宿主 IDE 版本（VSCode）。与上面的产品版本是两回事。 */
export const CODEBUDDY_VSCODE_VERSION = '1.139.0'
/**
 * 出站 UA：`<宿主IDE>/<宿主版本> CodeBuddy/<产品版本>`，与 opencode 同款插件逐字一致。
 * 旧值是 `CodeBuddyIDE/<产品版本>`，服务端据此认不出宿主而记成未知客户端。
 */
export const CODEBUDDY_IDE_USER_AGENT = `${CODEBUDDY_IDE_NAME}/${CODEBUDDY_VSCODE_VERSION} CodeBuddy/${CODEBUDDY_IDE_VERSION}`
/** 网关业务侧的产品标识（`X-Product`）。注意与 CODEBUDDY_PRODUCT（DSH 归属头）不是一回事。 */
export const CODEBUDDY_SAAS_PRODUCT = 'SaaS'
export const CODEBUDDY_ENV_ID = 'production'
export const CODEBUDDY_AGENT_INTENT = 'craft'
/**
 * CodeBuddy 网关的客户端身份头（数据面）。
 *
 * 服务端「使用记录」按这一组头识别调用方；缺失时不会报错，但会记成未知客户端。
 * 与 opencode 同款插件保持逐字一致，故两边改版本号要同步。
 * **不含**登录握手：`platform=CLI` 是刻意设计的（见 codebuddy.ts requestAuthState），
 * 改它会命中 IDE 深链分支，让登录页在浏览器里尝试唤起本地客户端。
 */
export function codeBuddyIdentityHeaders(): Record<string, string> {
  return {
    'X-IDE-Type': CODEBUDDY_IDE_NAME,
    'X-IDE-Name': CODEBUDDY_IDE_NAME,
    'X-IDE-Version': CODEBUDDY_VSCODE_VERSION,
    'X-Product-Version': CODEBUDDY_IDE_VERSION,
    'X-Env-ID': CODEBUDDY_ENV_ID,
    'X-Product': CODEBUDDY_SAAS_PRODUCT,
    'X-Agent-Intent': CODEBUDDY_AGENT_INTENT,
  }
}
export const CODEBUDDY_CLI_VERSION = '2.63.2'
export const DEFAULT_CONTEXT_WINDOW = 128_000
export const DEFAULT_MAX_TOKENS = 8_192
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000
export const REFRESH_SKEW_MS = 60_000
export const CATALOG_TTL_MS = 5 * 60 * 1000
/**
 * 宿主侧用量读数的缓存时长。
 *
 * 为什么需要它：额度接口是**多页**外呼（每页最长 10 秒），而每个客户端入口
 * 各自订阅、各自可能重读（设置页挂载、面板打开、HMR 后重挂、刷新页面）。没有
 * 缓存时，这些读取会各自打一轮完整的多页外呼——用户看到的是「指标要等一下才
 * 出来」，网关看到的是同一账号同一份额度被反复查询。
 *
 * **取值与客户端轮询周期无关。** 客户端每 10 秒来问一次（USAGE_REFRESH_MS），
 * 但真正决定打不打 CodeBuddy 的是这里的 TTL：条目仍新鲜就直接给缓存，陈旧时
 * 也是先给旧值、只在没有在飞刷新时补一次共享刷新。所以轮询问得再勤，也只是
 * 让界面更快看到后台已经刷新出来的新值——出站频率由 TTL 说话。
 *
 * 保持 60 秒不变。一个 TTL 窗口内容纳约 6 次轮询：缓存刚陈旧的那一次触发
 * 刷新，其余命中新写入的条目——模拟（多页外呼按 1–8 秒计，3000 次 × 10 小时）
 * 约 86% 的轮询被缓存吸收，约 14% 真的打到 CodeBuddy。
 *
 * 轮询加快后抓取频率会比以前略高：旧配置的 60 秒轮询恰好总踩在 TTL 边界附近，
 * 平均间隔约 120 秒；现在更贴近 TTL 本身，约 70 秒（10 小时内 301 → 515 次）。
 * 这是「问得更勤」的自然结果，不是缓存失效；要压低就把这里调大。
 */
export const USAGE_CACHE_TTL_MS = 60_000
export const LOGIN_TIMEOUT_MS = 10 * 60 * 1000
export const LOGIN_POLL_INTERVAL_MS = 1_000
export const AUTH_PENDING_CODE = 11217
export const CODEBUDDY_USAGE_ENDPOINT = 'https://www.codebuddy.cn'
/** 单次外呼（登录握手/目录）硬超时。chat 流只用它护连接+响应头，body 由 idleWatchdog 管。 */
export const REQUEST_TIMEOUT_MS = 60_000
/**
 * ctx.web 上注册的 provider id（搜索与抓取共用一个 id，各自注册到对应注册表）。
 * 与 llm 的 CODEBUDDY_PROVIDER 分开命名，避免读者以为两者必须同值。
 */
export const CODEBUDDY_WEB_PROVIDER_ID = 'codebuddy'
/** /agenttool 端点路径（搜索/抓取）。 */
export const AGENTTOOL_SEARCH_PATH = '/agenttool/v1/search'
export const AGENTTOOL_FETCH_PATH = '/agenttool/v1/webfetch'
/**
 * /agenttool 的 UA。参考实现称必须是 CLI 形态，但 2026-09 实测本网关对
 * CLI/IDE/undici 默认 UA 一视同仁；仍按 CLI 形态发送，与官方 CLI 同源最稳。
 */
export const AGENTTOOL_USER_AGENT = `CLI/unknown CodeBuddy/${CODEBUDDY_CLI_VERSION}`

