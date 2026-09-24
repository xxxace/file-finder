import crypto from 'node:crypto';

/**
 * 本地服务的访问口令。
 *
 * 进程启动时随机生成，只活在主进程内存里、不落盘；渲染层通过 IPC 拿走一份
 * （见 `electron/main/index.ts` 的 `ff-token`）。
 *
 * 为什么需要它、为什么不能用 Origin 名单代替 —— 见 `electron/server/index.ts`
 * 里那段校验的注释。
 */
export const LOCAL_TOKEN = crypto.randomBytes(24).toString('hex');
