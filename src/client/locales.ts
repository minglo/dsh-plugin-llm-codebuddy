/** CodeBuddy 插件页正文 + 侧栏用量指示器文案。 */
export const zh = {
  loading: '加载中…',
  notSignedIn: '未登录。',
  expired: '登录已过期，请重新登录。',
  waiting: '等待浏览器登录完成…',
  signIn: '登录',
  signingIn: '登录中…',
  signOut: '退出登录',
  timeout: '登录超时，请重试。',
  userId: '用户 ID',
  tenantId: '租户',
  enterpriseId: '企业 ID',
  totalBalance: '总剩余积分',
  totalUsed: '已用积分',
  monthPoolRemain: '本月剩余',
  monthSize: '本月到期',
  monthUsed: '已使用',
  monthUsedRate: '本月到期使用',
  // 第二条复合条：行标签 + 三个**互斥**到期段（段名只出现在 tooltip，段内放百分比）。
  recentRemain: '最近剩余',
  expiringWithin1d: '1天内到期',
  expiring1to2d: '1–2天内到期',
  expiring2to7d: '2–7天内到期',
  // 圆环图例里某一天的标签：按实际到期日期写。「{M}月{D}日到期」→ 10月4日到期。
  // 占位符由 UsageRings 替换；保持纯数字，窄弹窗里不撑破（与 formatTimestamp
  // 不用 toLocaleString() 同一个理由）。
  expiryDate: '{M}月{D}日到期',
  /** 圆环图例里「未来 7 天」这一节的标题。 */
  expiryByDay: '未来 7 天到期',
  usageError: '暂时无法读取额度。',
  loginError: '登录失败，请重试。',
  showUsage: '左侧边栏显示用量',
  showUsageDesc: '在侧边栏底部显示已用额度进度。',
  showComposerUsage: '在输入框显示用量',
  showComposerUsageDesc: '选中 CodeBuddy 模型时，在模型选择器左侧显示额度胶囊；点击查看完整额度明细。',
  // 429 等待开关。默认关，且**开启后也有 5 小时上限**：两句话都必须出现在
  // 描述里——只写「等到重置」会让用户以为关掉开关前的行为（等到结束为止）
  // 是选项之一，而它从来就不是。
  waitOnRateLimit: '遇到 429 等待重置',
  waitOnRateLimitDesc: '开启后遇到频率限制（429），会等服务给出的重置时刻再自动重试，最长 5 小时；重置更远、或关闭本开关时，按普通失败快速重试几次后报错，错误信息里保留重置时刻，可自行切换模型继续。',
  composerUsageShort: '本月',
  composerUsageTitle: 'CodeBuddy 用量',
  composerUsageClose: '关闭',
  composerUsageUpdated: '更新于',
  // 「读数」的刷新周期＝**宿主**从 CodeBuddy 拉取的周期（USAGE_CACHE_TTL_MS，60 秒），
  // 不是客户端轮询周期（USAGE_REFRESH_MS，10 秒）。客户端每 10 秒来问一次，只是
  // 「更早看到已经刷新出来的新值」；数字本身的年龄上限仍由宿主 TTL 决定。
  // 所以这里必须写 60 秒：写 10 秒会让用户以为数据最多只有 10 秒旧。
  // 也不要把两者都写进去——那句话会到 408px，撑破窄弹窗的单行约束（见 .cb-usage-note）。
  composerUsageHint: '读数每 60 秒刷新一次',
  composerUsageUnavailable: '暂时读不到额度数据，稍后会自动重试。',
  webSearch: '使用 CodeBuddy 搜索',
  webSearchDesc: '用 CodeBuddy 网关接管 web_search 与 web_fetch；关闭后自动还原为原来的搜索提供方。',
  // 生效态徽标：读的是实际接管结果，不是开关意图。
  searchOn: 'CodeBuddy 搜索生效中',
  searchOff: '未接管搜索',
  searchBlocked: '接管未生效',
  searchBadgeHint: '当前 web_search / web_fetch 实际使用的后端。开关为「意图」，此徽标为「效果」：已登录且接管成功时才显示生效中。',
  // 模型标签：内联行只放一个倍率（current 优先），其余进悬停气泡。这五个键
  // 就是 ModelLabel 气泡的全部自有文案——缺了任何一个，t() 都会把键名原样上屏。
  rateLabel: '倍率',
  windowLabel: '时间窗',
  freeLabel: '免费',
  baseRateLabel: '基础倍率',
  currentRateLabel: '当前倍率',
} satisfies Record<string, string>

export type LocaleKey = keyof typeof zh

export const en = {
  loading: 'Loading…',
  notSignedIn: 'Not signed in.',
  expired: 'Your session has expired. Please sign in again.',
  waiting: 'Waiting for the browser sign-in to complete…',
  signIn: 'Sign in',
  signingIn: 'Signing in…',
  signOut: 'Sign out',
  timeout: 'Sign-in timed out. Please try again.',
  userId: 'User ID',
  tenantId: 'Tenant',
  enterpriseId: 'Enterprise ID',
  totalBalance: 'Total remaining credits',
  totalUsed: 'Used credits',
  monthPoolRemain: 'Remaining this month',
  monthSize: 'Expiring this month',
  monthUsed: 'Used',
  monthUsedRate: 'This-month usage',
  // Second composite bar: row label plus three MUTUALLY EXCLUSIVE expiry segments
  // (segment names appear only in the tooltip; each segment shows its percentage).
  recentRemain: 'Recent remaining',
  expiringWithin1d: 'Within 1 day',
  expiring1to2d: '1–2 days',
  expiring2to7d: '2–7 days',
  // The ring legend labels each day by its actual expiry date.
  // Placeholders are filled by UsageRings; plain numbers keep narrow popups intact.
  expiryDate: 'Expires {M}/{D}',
  /** Heading for the "next 7 days" section of the ring legend. */
  expiryByDay: 'Expiring in the next 7 days',
  usageError: 'Usage is temporarily unavailable.',
  loginError: 'Sign-in failed. Please try again.',
  showUsage: 'Show usage in the left sidebar',
  showUsageDesc: 'Display the used-allowance progress at the sidebar foot.',
  showComposerUsage: 'Show usage in the composer',
  showComposerUsageDesc: 'With a CodeBuddy model selected, show an allowance pill left of the model selector; click it for the full breakdown.',
  // 429 wait switch. Default OFF, and ON is still capped at 5 hours — both halves
  // must appear in the description: wording it as "waits until reset" alone would
  // suggest the old behavior (waiting it out to the end) is on the menu, and it never was.
  waitOnRateLimit: 'Wait out 429 rate limits',
  waitOnRateLimitDesc: 'When on, a 429 rate limit waits until the service reports the quota reset, capped at 5 hours. Beyond that, or when off, it retries briefly like any other failure and then reports the error with the reset instant intact, so you can switch models and continue.',
  composerUsageShort: 'month',
  composerUsageTitle: 'CodeBuddy usage',
  composerUsageClose: 'Close',
  composerUsageUpdated: 'Updated',
  // The READING's refresh period is the host's upstream pull cadence
  // (USAGE_CACHE_TTL_MS, 60s), not the client poll period (USAGE_REFRESH_MS, 10s).
  // Polling every 10s only surfaces an already-refreshed value sooner; the age of
  // the number itself is still bounded by the host TTL — hence 60s here.
  // Spelling out both would reach ~408px and break the note's single-line rule.
  composerUsageHint: 'Refreshes every 60 seconds',
  composerUsageUnavailable: 'Allowance data is temporarily unavailable; it will retry automatically.',
  webSearch: 'Search with CodeBuddy',
  webSearchDesc: 'Route web_search and web_fetch through the CodeBuddy gateway; turning it off restores the previous search provider.',
  // Effective-state badge: reports the actual takeover, not the switch intent.
  searchOn: 'CodeBuddy search active',
  searchOff: 'Search not taken over',
  searchBlocked: 'Takeover not in effect',
  searchBadgeHint: 'The backend web_search / web_fetch actually uses right now. The switch is intent; this badge is effect — "active" appears only when signed in and the takeover succeeded.',
  // Composer model label: the inline row carries one rate (current first); the
  // rest lives in the hover tooltip. These five keys are all of ModelLabel's copy.
  rateLabel: 'Rate',
  windowLabel: 'Window',
  freeLabel: 'Free',
  baseRateLabel: 'Base rate',
  currentRateLabel: 'Current rate',
} satisfies Record<LocaleKey, string>
