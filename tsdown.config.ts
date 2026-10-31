import { readFileSync } from 'node:fs'
import babel from '@rolldown/plugin-babel'
import decorators from '@babel/plugin-proposal-decorators'
import { defineConfig } from 'tsdown'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { name: string }
const MODULE_ID = pkg.name

// `@Remote` 是 TC39 stage-3 的方法装饰器。rolldown 底下的 oxc 只降级老式的
// `experimentalDecorators`，直接过一遍会原样留在产物里——ESM 加载时是
// `SyntaxError: Invalid or unexpected token`，整个插件起不来。
// 用 Babel 先转这一个文件；窄 `include` 让其余模块仍走快路径。
//
// 这是 tsup → tsdown 里唯一会「测试全绿、构建成功、产物不可加载」的差异：
// 测试跑 src/，只有真实 import dist/index.js 才会踩到。ci.yml 的
// 「Packed artifact loads」就是为拦住这一类问题加的。
const stage3Decorators = await babel({
  plugins: [[decorators, { version: '2023-11' }]],
  include: /src[\\/]remote\.ts$/,
  sourceMap: true,
})

// 所有运行期宿主（dsh web profile 的 modules 表）能提供的包一律 external；
// zod 被 src/remote-descriptors.ts value-import，必须 BUNDLE 进 client.js（不 external）。
const externals = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-settings',
  '@deepseek-ai/dsh-client-locale',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-api-gateway',
  '@deepseek-ai/dsh-typert-protocol',
]

export default defineConfig([
  // ── host 半区（Node）─────────────────────────────────────────────
  // 单入口打包成 dist/index.js + 一份 dist/index.d.ts。
  //
  // 曾经是「逐文件产出」（`bundle: false` + 把 src/*.ts 全列成 entry），产物因此有
  // 24 个 .js、23 个 .d.ts 和一个共享 chunk。那套形状没有任何消费者需要：
  //   · 宿主按 package.json 的 exports["."].default 只加载 dist/index.js；
  //   · 目录里的 .d.ts 只有入口那一个能被外部解析到，其余 22 个纯属它的传递依赖；
  //   · 仓库内一律相对路径导入 src/，测试与 typecheck 也都不读 dist。
  // 打包后公共面完全不变（导出仍是 Config/apply/inject/name/resolveConnectionOptions，
  // 声明面逐字一致），文件数从 71 降到 3。
  //
  // peerDeps 与 dependencies 仍由 tsdown 自动 external（package.json 驱动的默认行为），
  // 由宿主在运行时解析，绝不打进产物。
  {
    entry: { index: 'src/index.ts' },
    outDir: 'dist',
    format: 'esm',
    target: 'node22',
    platform: 'node',
    dts: true,
    sourcemap: true,
    clean: true,
    // tsdown 默认只 external `dependencies`；peerDependencies（cordis、各 dsh-* 包）
    // 必须由宿主解析，不能打进产物。`true` = 所有 npm 依赖一律 external，等价 tsup。
    deps: { neverBundle: true, onlyBundle: false },
    plugins: [stage3Decorators],
    // tsdown 默认产出 .mjs/.d.mts；package.json 的 exports 写的是 .js/.d.ts。
    outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
  },
  // ── client 半区（浏览器）─────────────────────────────────────────
  // 必须打成单个 CJS 文件并包进 __ModuleLoader__ 契约：外壳以 <script> 加载，
  // 且只能针对冻结的 PLATFORM_MODULES 基座表解析 external。
  {
    entry: { client: 'src/client/index.ts' },
    outDir: 'dist',
    format: 'cjs',
    outExtensions: () => ({ js: '.js' }),
    target: 'es2022',
    dts: false,
    // CJS 默认按 Node 处理，而 client 外壳是浏览器。
    inputOptions: { platform: 'browser' },
    // CJS 输出默认 `strict: 'auto'`，会丢掉 "use strict"；tsup 产物里有，这里保持一致。
    outputOptions: { strict: true },
    deps: {
      neverBundle: externals,
      // zod 在 dependencies 里，tsdown 会据此自动 external；但浏览器 loader 的
      // PLATFORM_MODULES 基座表没有 zod，`require("zod")` 在浏览器里直接抛错、
      // 整个 client 插件挂掉。必须强制内联。
      alwaysBundle: ['zod'],
      onlyBundle: ['zod'],
    },
    sourcemap: true,
    clean: false, // 接在 host 之后跑，不能清空刚产出的 dist/*
    banner: {
      js: `window.__ModuleLoader__.load({ id: "${MODULE_ID}", factory: (require) => { var module = { exports: {} }; var exports = module.exports; Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });`,
    },
    footer: {
      js: 'return module.exports; } });',
    },
  },
])
