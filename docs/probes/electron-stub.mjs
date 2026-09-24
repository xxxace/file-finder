/**
 * `electron` 的极简替身，只给探针用。
 *
 * 目的：让探针能在**纯 Node**里 import 真的 `electron/utils/thumbnail.ts`
 * （那份 TS 里写着 `import { nativeImage } from 'electron'`，而 Electron 运行时
 * 在 Node CLI 里不存在）。
 *
 * 范围：只实现缩略图链路上用到的那一个 API —— `nativeImage.createFromPath`。
 * 它就是"把图解码成像素"，**与本次要验证的 ffprobe 超时/杀进程完全无关**，
 * 所以换成近似实现不会污染结论：这里用"文件存在且有字节 = 能解出图"来近似，
 * 只为了让 `videoThumb` 那条链路能走完、拿到非空返回。
 *
 * ⚠️ 这个替身**不参与**被验证的行为（spawn / 超时 / kill），探针不靠它下结论。
 */
import fs from 'node:fs';

export const nativeImage = {
    createFromPath(filepath) {
        let size = 0;
        try { size = fs.statSync(filepath).size; } catch { /* 不存在 → size 保持 0 */ }
        const decodable = size > 0;
        return {
            isEmpty: () => !decodable,
            getSize: () => ({ width: 800, height: 600 }),
            resize() { return this; },
            toJPEG: () => Buffer.from(`STUB-JPEG:${size}`),
        };
    },
};
