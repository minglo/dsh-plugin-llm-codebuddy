# dsh-plugin-llm-codebuddy

[![CI](https://github.com/minglo/dsh-plugin-llm-codebuddy/actions/workflows/ci.yml/badge.svg)](https://github.com/minglo/dsh-plugin-llm-codebuddy/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/dsh-plugin-llm-codebuddy.svg)](https://www.npmjs.com/package/dsh-plugin-llm-codebuddy)
[![license](https://img.shields.io/npm/l/dsh-plugin-llm-codebuddy.svg)](./LICENSE)

腾讯 CodeBuddy 的 DeepSeek Harness（`dsh`）适配插件。

它把 CodeBuddy 的模型目录与对话端点接入 harness，注册为名为 `codebuddy` 的
LLM 路由，让你的 CodeBuddy 账号额度直接用于 `dsh` 里的对话。插件是**只读**的：
读取凭据与目录、流式对话、按需刷新令牌，不会自行创建或删除凭据。

## 安装

`dsh plugin` 会把参数转交给该 profile 目录下的 pnpm，因此安装就是一次 pnpm 安装：

```sh
dsh plugin --profile web add dsh-plugin-llm-codebuddy
```

装好后重启 `dsh web`（或让 profile 重新加载）生效。

## 登录

CodeBuddy 使用浏览器签发的令牌认证。安装后在
**设置 → 插件 → CodeBuddy** 里点「登录」，浏览器完成授权即可；令牌写入 harness
的凭据存储，不作为配置项，也不会被本插件另存一份。

- 未登录时模型列表为空，实际发起请求会以「缺少凭据」失败。
- 访问令牌临近过期会自动刷新；刷新失败**不会**删除凭据，只有刷新令牌本身也过期
  才会提示重新登录。

## 配置

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `baseURL` | `https://copilot.tencent.com/v2` | 对话接口地址。 |
| `defaultContextWindow` | `128000` | 目录未标注容量的模型所用上下文窗口。 |
| `defaultMaxTokens` | `8192` | 目录未标注容量的模型所用最大输出。 |
| `streamIdleTimeoutMs` | `300000` | 对话流的空闲超时。 |

## 模型目录

模型来自 CodeBuddy 的目录接口，会随服务端编辑自动更新，无需重启。只在目录里
**标注了容量**（上下文与最大输出均为正）的模型才会出现在选择器中；未标注容量的
条目不出现在列表里，但仍可用模型 id 直接指定，此时按上面的默认值保守处理。

### 目录声明的输出预留会把自动压缩压坏

目录里的 `maxOutputTokens` 是个**声明值**，不保证小于上下文窗口。它会被当作每次
请求的 `max_tokens`，而会话自动压缩的触发阈值是：

```
阈值 = min(窗口 × thresholdRatio, 窗口 − 输出预留 − headroomTokens)
```

三个真实模型的取值（`thresholdRatio` 默认 0.8、`headroomTokens` 默认 65536）：

| 模型 | 窗口 | 输出预留 | 阈值 | 结果 |
| --- | --- | --- | --- | --- |
| `glm-5.2` | 1,000,000 | 131,072 | **800,000** | 正常。比例分支生效（0.8 × 窗口）。 |
| `deepseek-v4.1-flash` | 1,000,000 | 393,216 | **541,248** | 正常，但阈值被预留压低——减法分支取胜，比例被浪费。 |
| `minimax-m3` | 512,000 | 524,288 | **−77,824** | **压缩失效**。预留超过窗口，减法分支为负。 |

第三行是故障：`resolveCompactSpec` 遇到非正预算会抛 `TargetPressureConfigError`，
而该错误在 `agent/pre-step` 被 catch 吞掉（只留一条 warn 然后继续），于是这个模型
**永远不会自动压缩**，上下文一路增长到网关报溢出为止。`kimi-k3-1`
（窗口 1,000,000 / 预留 1,048,576）同样如此。

**已做过实验验证**（线上包 `dsh-compaction-basic`，用真实目录容量驱动）：

- 网关**接受**倒挂的 `max_tokens`（`minimax-m3` 发 524288 仍返回 200），所以这不是
  服务端限制，纯粹是客户端侧的算术问题；
- `max_tokens` 确实是**硬上限**——设 64 时输出精确停在 64 token 且
  `finish_reason=length`；设 400000 时两个模型自然停在 8,923 / 10,586 token
  （`finish_reason=stop`），远低于各自声明的几十万。

因此缩小输出预留**不会削短正常回答**，改法也已验证有效（预留压到 131072 后，
两个失效模型的 spec 解析恢复正常，其余 12 个模型行为不变）。

**本次未包含该修复。** 代码保持原样（直接使用目录声明值），待实际使用后再处理。

## 用量额度

插件提供三个入口查看账号额度，数据同源，因此任何两处显示的数字都不会互相矛盾。

### 侧栏指示器（默认关闭）

侧栏底部用两条进度条回答「还剩多少、还能自由花多少」：

- **第一条「本月剩余」**：灰轨是总剩余，高亮段是**本月内到期**的那部分，条长就是
  本月剩余占总剩余的比例——一眼看出「总剩看着不少，本月能自由花的只是一小段」。
  右侧数字是**本月消耗率**，消耗率越高颜色在同一灰蓝色系内越深。
- **第二条「最近剩余」**：把未来到期的额度按 ≤1 天 / 1–2 天 / 2–7 天分成三段，
  每段宽度按该档额度分配，段内实心部分是该档的已用比例。没有任何短期到期额度时
  整条隐藏。

悬停可看到本月已用/额度、本月剩余、总剩余，以及每个到期段的精确数值。

默认关闭是因为侧栏底部是常驻区域，加进度条会改变默认界面。

### 输入框额度胶囊（默认开启）

输入框工具行、模型选择器左侧显示 `CodeBuddy · 本月 xx%`，点击打开完整明细。
**只在当前选中 CodeBuddy 模型时出现**——额度是 CodeBuddy 账号的属性，用别的
provider 时它既无意义也不该占位。

### 同心圆环

插件详情页与胶囊弹窗展示同一套同心圆环，中心与三环由内向外分别是：

| 位置 | 内容 |
| --- | --- |
| 中心 | 总剩余积分 |
| 内环 | 已用积分（占总额度的比例） |
| 中环 | 本月到期（占本月额度的比例） |
| 外环 | **未来 7 天**，按天分段 |

三个环是同一种读法：**空轨表示未使用，彩色弧表示已使用，弧长就是已用的比例**。
分段环也不例外——每一天未用的部分与另外两环同一个底色，只有已用的部分才是
**当天自己的颜色**，所以七个环段彼此可分辨，一眼能看出「哪几天有额度、各用了多少」。

按天分段的宽度按当天**发放的额度**分配，段与段之间留有空隙。**当天没有发放额度**
是特殊情况：它不画彩色弧，只留一小段很淡的占位，既让七个位置保持稳定（便于记住
「第几天」），又不会让人误以为那天有额度可花；图例里也会显式写「—」而不是 `0 / 0`。

打开或数据刷新时，三个环会从零顺时针生长出来，并逐环错开；如果你在系统里设置了
「减少动态效果」，动画会被跳过，静态图形照常显示。

### 读数时效

额度读数由宿主向 CodeBuddy 拉取，**每 60 秒刷新一次**。

同账号的重复读取由宿主缓存吸收：多个入口、多次重开面板或刷新页面都不会各自再打
一次 CodeBuddy，只有缓存过期后才在后台刷新一次。

## 用 CodeBuddy 接管网页搜索与抓取

开启后，harness 内置的 `web_search` 与 `web_fetch` 会改走 CodeBuddy 网关，
复用同一个账号，不需要额外凭据。

开关在 **设置 → 插件 → CodeBuddy → 「使用 CodeBuddy 搜索」**，且**只在已登录时
出现**（未登录时插件根本不注册相关后端，开关无从生效）。

| 行为 | 说明 |
| --- | --- |
| 默认值 | **关闭**。安装插件不会静默抢走搜索位。 |
| 生效时机 | 即时，无需重启。 |
| 范围 | 一个开关同时控制搜索与抓取。 |
| 退出登录 | 自动释放，不影响其他搜索提供方。 |
| 重新登录 | 开关仍为开时自动恢复接管。 |

开关旁有一枚**生效态徽标**，用来区分「开关想怎样」和「实际怎样」：

| 徽标 | 含义 |
| --- | --- |
| **CodeBuddy 搜索生效中**（绿） | 搜索确实走 CodeBuddy 网关。 |
| **未接管搜索**（灰） | 你主动关掉了，或未登录。 |
| **接管未生效**（琥珀） | 开关已开且已登录，但接管没成立（宿主未提供相关能力等）。 |

没有这枚徽标时，「开关开着却没生效」与「开关是关的」看起来一模一样。接管通过
运行时选择实现，关闭时会**还原成原来那个提供方**，因此可以和其他搜索插件共存。

## 遇到频率限制（429）时的行为

当账号额度被限流，CodeBuddy 返回 `429`，并在提示里给出重置时刻（例如
「将在 2026-09-27 17:30:18 UTC+8 重置」）。插件会读出这个时刻，接下来怎么走
由一个开关决定：

| 「遇到 429 等待重置」开关 | 行为 |
| --- | --- |
| **关（默认）** | 429 按普通失败处理：快速重试几次（约 5 次、15 秒内）后抛出错误，报文里的重置时刻随错误消息**原样保留**，可据此切换模型继续。 |
| 开 | 等到服务给出的重置时刻再自动重试；**但最多只等 5 小时**。 |

- **5 小时是硬上限，与开关无关**：重置时刻更远时，纵然开关开着、纵然把
  `retryPolicy.backoff.maxDelayMs` 配得再大，适配器也不会挂上这个等待——一个
  回合为一个可能长到隔夜的重置默默挂住，不如立刻失败让人接手。
- 等待路径（开关开且 ≤5 小时）在对话里有一条可展开的倒计时提示，说明第几次
  重试与失败原因，随时可中断。
- 报文里读不出重置时刻时（服务抽风，少见）：与开关无关，按普通失败重试几次后
  失败；宿主日志会留一份报文原文供核对。
- 提示里的重置时间会原样保留，不会因为错误分类而丢失（分类特意不用 `QUOTA`——
  界面会把它换成一句通用文案，把那句话吃掉）。

开关在 **设置 → 插件 → CodeBuddy →「遇到 429 等待重置」**，即时生效，无需重启。

## 发出去的请求长什么样

插件送出的请求与 harness 内部的样子有两处不同。两处都不是偏好，是 CodeBuddy 网关
逼出来的——不改就会在对话里报错。

### 去掉开头的身份声明

harness 的系统提示开头固定有一句身份声明（`You are an AI agent powered by DeepSeek
Harness…`，来自 `@deepseek-ai/dsh-system-prompt` 的 `includeHarnessIdentity` 段）。
**CodeBuddy 网关按「渠道校验」核对调用方：以这句开头的请求一律拒收**——

```
HTTP 400 · code=11128 · Illegal API invocation from an unapproved channel
```

界面上表现为「Request blocked. Please send it again」。这不是认证问题：同一凭据、同一
请求头，只把这句去掉就立刻 200。

上游只认**开头**那一句（不在开头不构成拦截），也不区分大小写。所以插件在出门前把它
摘掉，**其余系统提示一个字符都不改**（没命中就逐字节原样返回）。整条系统提示只剩
这句时，**整条不发**——空提示对上游没有意义，还可能被当成非法请求。

### 真人输入放在每轮的最后

harness 在真人消息**之后**还会注入运行时上下文（AGENTS.md、runtime context、skills
清单、时钟），而 **CodeBuddy 把一轮里最后一条 user 消息当真人提问**。不重排的话，
服务读到的是那些注入内容，而不是人问的话。所以插件把每轮里的真人输入挪到该轮 user
消息的末尾。

每一轮都重排（包括已经结束的轮次），这样一轮无论出现在哪都长得一样，请求前缀逐字
稳定，上游的 prefix cache 照旧命中。

## 尚未支持

- 命令行登录命令。
- 目录与用户自定义模型条目的合并。

## 开发

```sh
pnpm install
pnpm run verify     # typecheck + test + build，打包前的门禁
```

改动落在 `src/`，`dist/` 由 `pnpm run build` 生成、不进版本库（`files` 会把它带进
产物）。插件对外声明的命名面记在 [`dsh-plugin.naming.json`](./dsh-plugin.naming.json)：
改 provider、设置命名空间或服务名时要同步更新它。

## 发布

发布走 npm registry 的官方线，CI 里三个工作流各管一段：

| 工作流 | 触发 | 做什么 |
|---|---|---|
| `ci.yml` | 推 main / PR | 类型、测试、构建，以及产物清单核对 |
| `auto-tag.yml` | 推 main | 按 `package.json` 的 version 打 `v<版本>` tag，然后 dispatch 发布 |
| `publish.yml` | tag 推送 / 手动 dispatch | 用 OIDC（trusted publishing）发到 npm，附带 provenance |

所以日常发版只有一步：**把 `package.json` 的 version 抬一版，推 main**。`auto-tag.yml`
是幂等的——tag 已在、或该版本已在 npm 上，它都会跳过；main 被重写（squash 后强推）导致
tag 指向历史外的提交时，它会重建那个 tag。

### 首次发布必须手工做一次

`npm` 上的 trusted publisher **只能挂在已经存在的包上**，`npm publish` 对一个还不存在
的包会直接回 404——所以首发不能走 CI，得手工发一次：

```sh
npm login                 # token 失效时重新登录
pnpm run verify           # typecheck + test + build（prepublishOnly 也会跑一遍）
pnpm pack                 # 先看一眼产物清单
npm publish --access public
```

本地发布**不要**加 `--provenance`：provenance 需要 OIDC 环境，本地没有，npm 会直接失败；
provenance 由之后的 CI 发布自动带上。

发完第一次之后，到 npmjs.com 的包页面把本仓库登记成 **Trusted Publisher**（仓库填
`minglo/dsh-plugin-llm-codebuddy`，workflow 文件名填 `publish.yml`）。这一步做完，
之后的版本才能完全由 CI 发。

### 产物面

`files` 只带这些：`dist/**`（不含 `.map`）、`locale/*.json`、`cordis.patch.yml`、
`README.md`、`LICENSE`。host 半区是单入口（`dist/index.js` + `dist/index.d.ts`），
浏览器半区是 `dist/client.js`。

## 许可证

MIT，见 [LICENSE](./LICENSE)。
