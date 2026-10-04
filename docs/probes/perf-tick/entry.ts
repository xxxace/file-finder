/**
 * Electron 段专用转出口（多了 `thumbnail.ts`，它要 `nativeImage`）。
 * 纯 node 那两段用 `entry-bin.ts` —— 理由见那个文件的注释（踩过一次）。
 */
export * from '../../../electron/utils/cacheCrypto';
export * from '../../../electron/utils/binStore';
export * from '../../../electron/utils/thumbnail';
