// 探针入口：只导出被测的两个真实函数，别的什么都不做。
// 目的：让 probe.cjs 在真 Electron 里跑 app 自己的缩略图链路，而不是另写一份"接近的"实现。
export { imageRenditions, videoRenditions } from '../../../electron/utils/thumbnail';
