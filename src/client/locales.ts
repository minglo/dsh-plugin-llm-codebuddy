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
  tomorrowExpiring: '1天内到期',
  dayAfterExpiring: '2天内到期',
  weekExpiring: '7天内到期',
  // 圆环分段环的 7 个天标签。**沿用侧栏「错位一天」的口径**（第 0 天＝今天写成
  // 「1天内到期」），两处对同一个包说同一句话，往后顺延到第 6 天＝「7天内到期」。
  // 第 4–7 段是圆环独有的（侧栏只折三段），所以只有那四句是新键。
  expiringDay0: '1天内到期',
  expiringDay1: '2天内到期',
  expiringDay2: '3天内到期',
  expiringDay3: '4天内到期',
  expiringDay4: '5天内到期',
  expiringDay5: '6天内到期',
  expiringDay6: '7天内到期',
  /** 圆环图例里「未来 7 天」这一节的标题。 */
  expiryByDay: '未来 7 天到期',
  usageError: '暂时无法读取额度。',
  loginError: '登录失败，请重试。',
  showUsage: '左侧边栏显示用量',
  showUsageDesc: '在侧边栏底部显示已用额度进度。',
  showComposerUsage: '在输入框显示用量',
  showComposerUsageDesc: '选中 CodeBuddy 模型时，在模型选择器左侧显示额度胶囊；点击查看完整额度明细。',
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
  tomorrowExpiring: 'Within 1 day',
  dayAfterExpiring: 'Within 2 days',
  weekExpiring: 'Within 7 days',
  // The ring's seven day labels deliberately keep the sidebar's "one day ahead"
  // wording (day 0 = today reads "Within 1 day") so both surfaces describe the
  // same package with the same sentence; days 4–7 exist only on the ring.
  expiringDay0: 'Within 1 day',
  expiringDay1: 'Within 2 days',
  expiringDay2: 'Within 3 days',
  expiringDay3: 'Within 4 days',
  expiringDay4: 'Within 5 days',
  expiringDay5: 'Within 6 days',
  expiringDay6: 'Within 7 days',
  /** Heading for the "next 7 days" section of the ring legend. */
  expiryByDay: 'Expiring in the next 7 days',
  usageError: 'Usage is temporarily unavailable.',
  loginError: 'Sign-in failed. Please try again.',
  showUsage: 'Show usage in the left sidebar',
  showUsageDesc: 'Display the used-allowance progress at the sidebar foot.',
  showComposerUsage: 'Show usage in the composer',
  showComposerUsageDesc: 'With a CodeBuddy model selected, show an allowance pill left of the model selector; click it for the full breakdown.',
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
} satisfies Record<LocaleKey, string>
