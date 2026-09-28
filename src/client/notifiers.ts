/**
 * 客户端三个入口之间的进程内通知器（无 Cordis 依赖）。
 *
 * 为什么单开一个模块：设置卡片（CodeBuddyTab）是**发布方**，侧栏指示器与
 * 输入框胶囊是**订阅方**；把发布方和订阅方放在同一个文件里，会让
 * 「订阅方 → 发布方」的 import 变成循环依赖（usage-feed 也要订阅登录态变化）。
 * 通知器本身与 React、与网关都无关，单独放这里最干净。
 */

/** 登录态变化：CodeBuddyTab 登录/退出成功后 emit，读数入口订阅后立即重拉。 */
const loginChangeListeners = new Set<() => void>()

export function emitLoginChange(): void {
  for (const listener of loginChangeListeners) listener()
}

export function subscribeLoginChange(listener: () => void): () => void {
  loginChangeListeners.add(listener)
  return () => { loginChangeListeners.delete(listener) }
}

/** showUsage / showComposerUsage 开关变化：卡片切换成功后 emit，入口据此重读偏好。 */
const usagePrefChangeListeners = new Set<() => void>()

export function emitUsagePrefChange(): void {
  for (const listener of usagePrefChangeListeners) listener()
}

export function subscribeUsagePrefChange(listener: () => void): () => void {
  usagePrefChangeListeners.add(listener)
  return () => { usagePrefChangeListeners.delete(listener) }
}
