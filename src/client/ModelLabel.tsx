/**
 * 作曲家模型选择器每一行（触发按钮、菜单当前值、可选行）的模型名标签。
 *
 * 这个组件拥有**所有 provider** 的标签格（single 槽以 priority -1 抢占，
 * 见 Task 8 的注册），而不是只拥有 CodeBuddy 的——所以它对别家的模型
 * 必须逐字渲染目录名：显示别家 provider 的倍率或徽章是谎言，少渲染官方
 * 1017 角标是 regression（我们的注册让官方插件不再渲染，它的内容由
 * 这里复刻）。
 *
 * 三件事刻意如此：
 *
 * 1. **只读预览，不接管交互**：选择器拥有点击、搜索、勾选、推理档位与
 *    触发按钮的 accessible name，本组件不加任何 click/focus 处理。悬停
 *    气泡是只读预览（内容可选），与官方 1017 插件用原生 title 做提示
 *    是同一个形状。
 * 2. **内联行只放「名字 + 徽章 + 一个倍率」**：宿主把我们的内容包在
 *    `text-overflow: ellipsis; overflow: hidden` 的 span 里，作曲家放不下
 *    时还会整段隐藏（`--dsh-composer-model-text-display: none`）——行越宽，
 *    标签自己消失的概率越大。其余全部进气泡。
 * 3. **语言读 locale 修订号，不读快照对象**：locale 服务的快照对象标识
 *    不保证稳定，`useSyncExternalStore` 按标识判等——用修订号（数字）做
 *    快照，变化才重渲染；渲染时再读 `active` 选 zh/en。
 */
import type {} from '@deepseek-ai/dsh-client-ui-model-selection/client'
import { createElement as h, useEffect, useSyncExternalStore } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { Tag, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { CODEBUDDY_PROVIDER } from '../constants.js'
import { normalizeCredits } from '../rate.js'
import type { LocalizedText } from '../remote-types.js'
import type { ModelFeed, ModelFeedSnapshot } from './model-feed.js'
import { EMPTY_MODEL_SNAPSHOT } from './model-feed.js'

/**
 * 语言窄面：Task 8 用宿主 locale 服务原样组装（`ctx.locale` 的
 * `subscribe` / `getSnapshot` 直传）。只取 `active` 与 `revision`，
 * 快照里别的不读。
 */
export interface LocaleFace {
  subscribe(listener: () => void): () => void
  getSnapshot(): { active: string; revision: number }
}

/** 槽位注入面：共享目录 feed、语言窄面、插件命名空间翻译函数。 */
export interface ModelLabelInjected {
  feed: ModelFeed
  locale: LocaleFace
  /** 插件自有文案（`rateLabel` 等，Task 8 在 locales.ts 里声明中英两份）。 */
  t: (key: string) => string
}

type Props = PropsRuntime<'conversation.input.model.label'> & InjectFace<ModelLabelInjected>

/**
 * 官方 1017 角标的复刻条件（从官方
 * `@deepseek-ai/dsh-client-ui-deepseek-model-label-1017` 插件源码抄来）：
 * 只有 DeepSeek 两家 provider 的 Flash 模型、且目录名恰为那个版本号时才有。
 * 文本是字面 `1017`，中英同一串。
 */
const FLASH_PROVIDERS: ReadonlySet<string> = new Set(['deepseek-account', 'deepseek-official'])
const FLASH_MODEL_ID = 'deepseek-flash'
const FLASH_MODEL_NAME = 'DeepSeek-V4.1-Flash'

function isOfficialFlash(providerId: string, modelId: string, modelName: string): boolean {
  return FLASH_PROVIDERS.has(providerId) && modelId === FLASH_MODEL_ID && modelName === FLASH_MODEL_NAME
}

/**
 * 服务端中英双语文案按当前语言挑一边：中文环境读 zh（缺失回落 en），
 * 否则读 en（缺失回落 zh）。服务端两种都下发，拼字符串会写死一种语序，
 * 所以这里只做选择。
 */
function pickText(text: LocalizedText | undefined, active: string): string | undefined {
  if (text === undefined) return undefined
  return active.startsWith('zh') ? (text.zh ?? text.en) : (text.en ?? text.zh)
}

/**
 * 富文本气泡：宿主 `Tooltip` 的 `label` 类型只写了 `string | (() => string)`，
 * 但运行期它把 label 当 children 渲染——传 `ReactElement` 会得到带样式、
 * 多行、可分段的气泡，而不是一句纯文本。这里用一次 cast 把类型缺口补上，
 * 运行期行为（label 即 children）才是这么写的依据。
 */
type RichTooltipProps = Omit<Parameters<typeof Tooltip>[0], 'label' | 'children'> & { label: ReactElement }
const richTooltip = (props: RichTooltipProps, children: ReactElement): ReactElement =>
  h(Tooltip, { ...props, label: props.label as unknown as Parameters<typeof Tooltip>[0]['label'], children })

const LABEL_CSS_TAG = 'dsh-plugin-llm-codebuddy/model-label.module.css'
/**
 * 标签行样式：根节点 inline-flex 保证徽章与倍率跟名字同行、不换行；
 * 倍率 `flex: none` 不被压缩、等宽数字纵向对齐。气泡只做纵向堆叠，
 * 其余（字号/颜色）继承宿主主题 token，不自带色板。
 */
const LABEL_CSS = `
.cb-model-label{display:inline-flex;align-items:center;gap:4px;vertical-align:baseline;min-width:0}
.cb-model-rate{flex:none;font-variant-numeric:tabular-nums}
.cb-model-tip{display:flex;flex-direction:column;gap:4px;max-width:280px}
.cb-model-tip-name{font-weight:600}
.cb-model-tip-id{opacity:.65}
.cb-model-tip-row{display:flex;gap:4px;align-items:baseline}
`

function injectLabelCss(): void {
  if (typeof document === 'undefined') return
  if (document.querySelector(`style[data-plugin-css=${JSON.stringify(LABEL_CSS_TAG)}]`) !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-plugin-llm-codebuddy'
  tag.dataset.pluginCss = LABEL_CSS_TAG
  tag.textContent = LABEL_CSS
  document.head.appendChild(tag)
}

/** 非 CodeBuddy 提供方：名字逐字渲染，只叠加复刻的 1017 角标（若命中）。 */
function renderOtherProvider(modelName: string, flash: boolean): ReactNode {
  const inline = h('span', { className: 'cb-model-label', title: '' },
    modelName,
    flash ? h(Tag, { tone: 'info' }, '1017') : null,
  )
  // 没有角标就没有可展示的东西：裸 span 让宿主自带的原生 title 负责提示。
  if (!flash) return inline
  return richTooltip({
    label: h('span', { className: 'cb-model-tip' },
      h('span', { className: 'cb-model-tip-name' }, modelName),
      h('span', { className: 'cb-model-tip-row' }, h(Tag, { tone: 'info' }, '1017')),
    ),
  }, inline)
}

/**
 * 模型标签本体。`provider`/`model` 是槽位 owner 传的目录事实，`placement`
 * 与 `selected` 照单收下但不读——行内形状与位置/选中态无关。
 */
export function ModelLabel({ provider, model, feed, locale, t }: Props): ReactNode {
  useEffect(() => { injectLabelCss() }, [])

  // 非 CodeBuddy 行不订阅目录：它的渲染与 feed 无关，订阅只会带来无谓重渲染。
  const codeBuddy = provider.id === CODEBUDDY_PROVIDER
  const snapshot: ModelFeedSnapshot = useSyncExternalStore(
    codeBuddy ? feed.subscribe : NO_SUBSCRIPTION,
    codeBuddy ? feed.getSnapshot : noSnapshot,
    codeBuddy ? feed.getSnapshot : noSnapshot,
  )
  // 修订号是数字：快照对象标识不稳定，不能拿它做 useSyncExternalStore 的快照。
  useSyncExternalStore(locale.subscribe, () => locale.getSnapshot().revision)
  const active = locale.getSnapshot().active

  if (!codeBuddy) return renderOtherProvider(model.name, isOfficialFlash(provider.id, model.id, model.name))

  const entry = snapshot.models.find(candidate => candidate.id === model.id)
  const entryRate = entry?.rate
  // 目录 description 的归一值算一次：内联降级与面板 guard 共用，免得一处改了另一处忘。
  const descRate = normalizeCredits(model.description)
  // 内联倍率是**实际扣费价**（current，回落 base）：促销期间展示 base
  // 会把折扣价说成原价。只取服务端自己的归一串——`free` 只加 `data-free`
  // 样式钩子，不替它写本地化词：服务端说「价格是零」（`x0`），`x0` 就是原话，
  // 与其它所有模型的内联口径一致（`free` 无数字的分支在宿主投影里到不了，
  // 见 effectiveRate：`free` 为真当且仅当 current 有值且读作零）。
  const rateText = entryRate?.current
    ?? entryRate?.base
    // 降级只吃自家 provider 的 description：别家的 description 是简介文案，
    // 拿 normalizeCredits 套它会把一句简介「解析」成倍率。
    ?? descRate
  const free = entryRate?.free === true
  const promo = entry?.promotion
  const tier = entry?.tier
  // 面板里的模型描述：富化条目优先；没有条目时目录 description 是 prose
  //（normalizeCredits 啃不动）才配进面板——能解析成倍率的那种已经在
  // rateText 里出现过，不重复。
  const description = pickText(entry?.description, active)
    ?? (rateText === undefined || descRate === undefined
      ? model.description
      : undefined)

  const inline = h('span', { className: 'cb-model-label', title: '' },
    model.name,
    // 促销徽章颜色取服务端原样 hex（Tag 自身不收 style，用外层 span 继承）；
    // tier 服务端不给颜色，用中性徽章。
    promo === undefined
      ? null
      : h('span', { style: { color: promo.color } }, h(Tag, null, promo.label)),
    tier === undefined ? null : h(Tag, { tone: 'neutral' }, tier.label),
    rateText === undefined
      ? null
      : h('span', { className: 'cb-model-rate', ...(free ? { 'data-free': true } : {}) }, rateText),
  )

  const promoText = pickText(promo?.text, active)
  const tierText = pickText(tier?.text, active)
  // 面板倍率行的两个前置量：有数字价（tipRate）走 base/current 展开；
  // 否则（无富化条目，或条目的 rate 本来就没有数字）有降级值就展示它，
  // 都没有则整行省略——绝不把 undefined 插进文案（`倍率: undefined`
  // 是真实上线的 bug：目录里没 credits 的模型照样有富化条目）。
  const tipRate = entryRate?.current ?? entryRate?.base
  const fallbackRateRow: ReactNode = rateText === undefined
    ? null
    : h('span', { className: 'cb-model-tip-row' }, `${t('rateLabel')}: ${rateText}`)
  const hasTip = promo !== undefined || tier !== undefined || rateText !== undefined || description !== undefined
  // 只有名字、没有任何可展开的信息时不挂气泡：宿主的原生 title 已覆盖。
  if (!hasTip) return inline

  return richTooltip({
    label: h('span', { className: 'cb-model-tip' },
      h('span', { className: 'cb-model-tip-name' }, model.name),
      // 模型 id 与提供方名（§3.6 的前两行）：同名模型可能分属多个提供方，
      // id 是调试时的唯一把柄；id 弱化展示（名字才是主视觉），提供方取本地化
      // 名、缺失回落 id。行 markup 与下面的倍率/促销行同形。
      h('span', { className: 'cb-model-tip-row cb-model-tip-id' }, model.id),
      h('span', { className: 'cb-model-tip-row' }, provider.name ?? provider.id),
      // `&&` 同时收窄两个量：展开分支里 entryRate 与 tipRate 都非空；
      // 否则走降级行（值为 undefined 时它就是 null，整行省略）。
      entryRate !== undefined && tipRate !== undefined
        ? h('span', { className: 'cb-model-tip-row' },
            entryRate.base !== undefined && entryRate.current !== undefined && entryRate.base !== entryRate.current
              // 原价与现价并列：划线与否听服务端的（`displayMode: 'strikethrough'`
              // 才划线，`replace` 模式只是换了个价）——不看 flag 就划线，
              // 会把服务端「直接替代」的意图画成「打折」。只给现价也不行，
              // 那会让人以为一直是这个价。
              ? h('span', null,
                entryRate.strikethrough === true
                  ? h('span', null,
                    `${t('baseRateLabel')}: `, h('s', null, entryRate.base),
                    ` ${t('currentRateLabel')}: ${entryRate.current}`,
                    free ? ` ${t('freeLabel')}` : '',
                  )
                  : h('span', null,
                    `${t('baseRateLabel')}: ${entryRate.base} → `,
                    `${t('currentRateLabel')}: ${entryRate.current}`,
                    free ? ` ${t('freeLabel')}` : '',
                  ),
              )
              : h('span', null,
                `${t('rateLabel')}: ${tipRate}`,
                free ? ` ${t('freeLabel')}` : '',
              ),
          )
        : fallbackRateRow,
      promo === undefined ? null : h('span', { className: 'cb-model-tip-row' },
        h('span', { style: { color: promo.color } }, h(Tag, null, promo.label)),
        promoText === undefined ? null : h('span', null, promoText),
      ),
      promo?.window === undefined ? null : h('span', { className: 'cb-model-tip-row' },
        `${t('windowLabel')}: ${promo.window}`,
      ),
      tier === undefined ? null : h('span', { className: 'cb-model-tip-row' },
        h(Tag, { tone: 'neutral' }, tier.label),
        tierText === undefined ? null : h('span', null, tierText),
      ),
      description === undefined ? null : h('span', { className: 'cb-model-tip-row' }, description),
    ),
  }, inline)
}

/** 未订阅态：CodeBuddy 以外的行不读共享 feed（零成本，见 ComposerUsage 同款）。
 *
 * 快照必须用共享的稳定空对象：`useSyncExternalStore` 按 `Object.is` 判等，
 * 每次新建空对象会被判成「变了」，触发无限重渲染（`EMPTY_MODEL_SNAPSHOT`
 * 存在就是为了这个，见 model-feed.ts 的注释）。
 */
const NO_SUBSCRIPTION = (): (() => void) => () => {}
const noSnapshot = (): ModelFeedSnapshot => EMPTY_MODEL_SNAPSHOT
