import { defineConfig } from 'tsup'

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
  // peerDeps 与 dependencies 仍由 tsup 自动 external（package.json 驱动的默认行为），
  // 由宿主在运行时解析，绝不打进产物。
  {
    entry: { index: 'src/index.ts' },
    outDir: 'dist',
    format: ['esm'],
    target: 'node22',
    platform: 'node',
    dts: true,
    sourcemap: true,
    bundle: true,
    clean: true,
  },
  // ── client 半区（浏览器）─────────────────────────────────────────
  // 必须打成单个 CJS 文件并包进 __ModuleLoader__ 契约：外壳以 <script> 加载，
  // 且只能针对冻结的 PLATFORM_MODULES 基座表解析 external。
  {
    entry: { client: 'src/client/index.ts' },
    outDir: 'dist',
    format: ['cjs'],
    outExtension: () => ({ js: '.js' }), // package type:module → 默认会产出 .cjs；loader 契约需要 dist/client.js
    platform: 'browser',
    target: 'es2022',
    jsx: 'automatic',
    external: externals,
    bundle: true,
    sourcemap: true,
    clean: false, // 接在 host 之后跑，不能清空刚产出的 dist/*
    banner: {
      js: `window.__ModuleLoader__.load({ id: "dsh-plugin-llm-codebuddy", factory: (require) => { var module = { exports: {} }; var exports = module.exports; Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });`,
    },
    footer: {
      js: `return module.exports; } });`,
    },
  },
])
