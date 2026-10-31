import babel from '@rolldown/plugin-babel'
import decorators from '@babel/plugin-proposal-decorators'
import { defineConfig } from 'vitest/config'

// 界面按**读者本地时区**渲染抓取时刻（ComposerUsage 的 formatTimestamp 用本地
// getter，这是刻意的：用户要看的是自己表盘上的时间）。而测试断言的是一串具体数字，
// 于是同一份代码在 UTC 的 CI 上和在 UTC+8 的开发机上会得出相差 8 小时的字符串——
// CI 首次运行时正是这样挂的。
//
// 把测试进程的时区固定在开发机所在的 Asia/Shanghai：断言的字节不变，任何机器、
// 任何 CI 上跑都得到同一结果。固定时区不会削弱这个断言——formatTimestamp 若改成
// UTC 或 toLocaleString()，测试照样失败。
//
// 写在 import 之后是刻意的：这里要的是「配置求值时就改掉父进程的环境」，vitest 的
// worker 在此之后才 fork，因而继承到已改好的值。
process.env.TZ = 'Asia/Shanghai'

// `src/remote.ts` 的 `@Remote` 是 TC39 stage-3 方法装饰器。vite 8 走 oxc，
// 它只降级老式的 `experimentalDecorators`，于是那一个文件会在裸装饰器处抛
// `SyntaxError: Invalid or unexpected token`，凡是 import 本插件的用例全挂。
// 所以测试路径也要过一遍 Babel——与 tsdown.config.ts 用的是同一个插件。
const stage3Decorators = await babel({
  plugins: [[decorators, { version: '2023-11' }]],
  include: /src[\\/]remote\.ts$/,
})

export default defineConfig({
  plugins: [stage3Decorators],
  test: {
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    environment: 'jsdom',
    // 不设 `isolate: false`。它能把本地耗时从 ~4.5s 压到 ~3.3s，但会让
    // **结果依赖 worker 调度**：同一 worker 内多个测试文件共享模块图与 jsdom，
    // `vi.mock` 的注册会跨文件串味。1.3.0 试过这一条，本地（CPU 多、分片不同）
    // 全绿，CI 上 4 个 job 全部在 `UsageIndicator` 的两条 tooltip 断言上红——
    // 症状是 `container.textContent` 只剩 `'10%'`，mock 的 Tooltip 没生效。
    // 省下的 1 秒不值得让测试结论取决于跑在哪台机器上。
  },
})
