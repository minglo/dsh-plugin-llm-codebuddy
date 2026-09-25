import { defineConfig } from 'tsup'
import { readdirSync } from 'node:fs'

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

/** host 半区入口 = src/*.ts（不含 src/client/）：Node ESM 逐文件产出，不打包。 */
const hostEntries = readdirSync('src', { withFileTypes: true })
  .filter(e => e.isFile() && e.name.endsWith('.ts'))
  .map(e => `src/${e.name}`)

export default defineConfig([
  // ── host 半区（Node）─────────────────────────────────────────────
  // 逐文件产出 ESM + .d.ts；peerDeps 与运行时依赖全部 external，
  // 由宿主在运行时解析，绝不打进产物。
  {
    entry: hostEntries,
    outDir: 'dist',
    format: ['esm'],
    target: 'node22',
    platform: 'node',
    // package.json 里 dependencies + peerDependencies 自动 external（tsup 默认行为）；
    // dts: true 让 tsup 一并产出 .d.ts，取代原先 tsc 的声明职责。
    dts: true,
    sourcemap: true,
    bundle: false,
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
