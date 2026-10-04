/**
 * 纯 node 段专用转出口（只含文件 IO，不含 nativeImage）。
 *
 * ⚠️ **为什么必须是两个 entry**（合并过一次，踩了）：CJS bundle 是**全量求值**的 ——
 *   esbuild 的 `--external:electron` 只是把那句 `require('electron')` 留成外部调用，
 *   而纯 node 进程跑到它照样抛 "Cannot find module 'electron'" ⇒ 量 IO 的那两段会直接挂。
 *   所以：要 nativeImage 的（`pipeline.cjs`）走 `entry.ts` + Electron 跑；
 *   不需要的（`probe.cjs` read/write）走这份 + 纯 node 跑（不必付 Electron 启动的钱）。
 *
 * ⚠️ **绝不导出 nedb** —— 它模块顶层就会 loadDatabase（并可能触发迁移），
 *   而这个探针只想量文件 IO，绝不能顺手动主人的库。
 */
export * from '../../../electron/utils/cacheCrypto';
export * from '../../../electron/utils/binStore';
