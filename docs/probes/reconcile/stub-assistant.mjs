/**
 * 探针专用桩：管理助手不参与本次验证。
 *
 * 为什么要桩：`electron/server/index.ts` 在**模块顶层**就会调 `createAssistantRoutes(...)`，
 * 而助手那边（`apply.ts` / `siteFetch.ts` / `queue.ts`）依赖 electron 的
 * `nativeImage` / `BrowserWindow` —— 纯 Node 下会把探针带崩。
 *
 * 桩成空路由：注册循环拿不到任何路径，等于助手这一块在探针里不存在。
 */
export function createAssistantRoutes() {
    return [];
}
