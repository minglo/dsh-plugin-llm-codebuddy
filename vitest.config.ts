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

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    environment: 'jsdom',
  },
})
