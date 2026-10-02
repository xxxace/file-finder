/**
 * `electron` 替身 —— **只给 `docs/probes/faces/` 这一个探针用**。
 *
 * 为什么需要：`apply.ts` / `utils/driveIdentity.ts` 里有 `import { net, nativeImage, session } from 'electron'`
 * 这类**值导入**，在纯 Node 里解析不到。而本探针要验证的两块逻辑
 * （`collectFaces` 的展开、`buildGroups` 的分组）**一行都不碰 electron** ——
 * 它只是被同一个模块的其它 import 拖进来的，所以给个空壳就够，
 * **不会污染结论**。
 *
 * ⚠️ 刻意与 `../electron-stub.mjs` 分开：那个是 ffprobe 探针专用的最小桩
 * （只有 `nativeImage.createFromPath`），语义不同、不要互相借用，
 * 否则一方加东西会静默改变另一方的行为。
 */
export const nativeImage = {
    createFromBuffer: () => ({ isEmpty: () => true, getSize: () => ({ width: 0, height: 0 }), toJPEG: () => Buffer.alloc(0) }),
    createFromPath: () => ({ isEmpty: () => true, getSize: () => ({ width: 0, height: 0 }) }),
};

export const net = {
    request: () => { throw new Error('stub: net.request 不该被探针调用'); },
};

export const session = {
    fromPartition: () => ({}),
};

export const app = {
    getPath: () => process.env.USERPROFILE ?? '.',
    getVersion: () => '0.0.0-stub',
};

export const shell = { openPath: async () => '' };
export const dialog = { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) };
export const BrowserWindow = class { };
export const ipcMain = { handle() { }, on() { } };
