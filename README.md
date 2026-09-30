# dsh-plugin-llm-codebuddy

[![CI](https://github.com/minglo/dsh-plugin-llm-codebuddy/actions/workflows/ci.yml/badge.svg)](https://github.com/minglo/dsh-plugin-llm-codebuddy/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/dsh-plugin-llm-codebuddy.svg)](https://www.npmjs.com/package/dsh-plugin-llm-codebuddy)
[![license](https://img.shields.io/npm/l/dsh-plugin-llm-codebuddy.svg)](./LICENSE)

腾讯 CodeBuddy 的 DeepSeek Harness（`dsh`）适配插件。

> **认准包名**：本插件是 `dsh-plugin-llm-codebuddy`。npm 上另有他人维护的
> `dsh-llm-codebuddy`，两者无关，安装时别拿错。

它把 CodeBuddy 的模型目录与对话端点接入 harness，注册为名为 `codebuddy` 的
LLM 路由，让你的 CodeBuddy 账号额度直接用于 `dsh` 里的对话。插件是**只读**的：
读取凭据与目录、流式对话、按需刷新令牌，不会自行创建或删除凭据。

## 安装

`dsh plugin` 会把参数转交给该 profile 目录下的 pnpm，因此安装就是一次 pnpm 安装：

```sh
dsh plugin --profile web add dsh-plugin-llm-codebuddy
```

从本地目录或打包产物安装（发布到 npm 之前用这种方式）：

```sh
pnpm pack                                  # 产出 dsh-plugin-llm-codebuddy-<版本>.tgz
dsh plugin --profile web add /绝对路径/dsh-plugin-llm-codebuddy-<版本>.tgz
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

额度读数由宿主向 CodeBuddy 拉取，**每 60 秒刷新一次**；界面每 10 秒取一次读数，
所以宿主刷好后约 10 秒内即可看到新值，但数字本身最多会有 60 秒旧。弹窗底部标注的
是前者。

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

## 遇到频率限制时会等到重置

当账号额度被限流，CodeBuddy 返回 `429`，并在提示里给出重置时刻（例如
「将在 2026-09-27 17:30:18 UTC+8 重置」）。插件会读出这个时刻，
**等到那个时间点再自动重试**，而不是立刻连续重试几次就失败。

- 等待上限 24 小时：当天内的重置都会等；隔夜等更久的则立即报错，并保留重置时刻。
- 等待过程在对话里有一条可展开的倒计时提示，说明第几次重试与失败原因，随时可中断。
- 提示里的重置时间会原样保留，不会因为错误分类而丢失。

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

日常发版只有一步：抬一版 `package.json` 的 `version`，推到 `main`。

```sh
npm version patch --no-git-tag-version
git commit -am "chore: release 1.0.1"     # 版本号用上一步输出的那个
git push
```

推上去之后自动完成剩下的事：

| Workflow | 做什么 |
| --- | --- |
| [auto-tag.yml](.github/workflows/auto-tag.yml) | 按 `version` 打 tag `v<version>`，再呼叫 publish |
| [publish.yml](.github/workflows/publish.yml) | 认证并发布到 npm，生成 provenance |

两个都幂等：tag 已存在、或该版本已在 npm 上，都直接跳过，所以往 `main` 推普通提交
不会重复发布。认证走 OIDC Trusted Publishing，仓库里没有也不该有 `NPM_TOKEN`。

### 首次发布必须手工做一次

包在 npm 上还不存在时，`publish.yml` 会以一条 notice 跳过而不是报错——npm 只允许把
Trusted Publisher 挂在**已存在**的包上，给不存在的包做 OIDC 认证会直接回 404。
所以首发要手工做：

```sh
npm login
npm publish --access public     # 门禁由 prepublishOnly（typecheck + test + build）承担
```

发完到 npm 的包设置里加一个 Trusted Publisher：

| 字段 | 值 |
| --- | --- |
| Repository | `minglo/dsh-plugin-llm-codebuddy` |
| Workflow | `publish.yml` |
| Environment | 留空 |

此后的版本就都由 workflow 自动发布了。

### 补发与回滚

- tag 在但没发出去：`gh workflow run publish.yml --ref v<version>`。
- `main` 被重写（squash 后强推）导致 tag 指向历史外的提交：`gh workflow run auto-tag.yml`
  会重建 tag。
- 发错了：优先撤回（删 tag，或把 tag 指回旧提交），不要靠再补一个「两边都能用」的
  版本来糊。

## 许可证

MIT，见 [LICENSE](./LICENSE)。
