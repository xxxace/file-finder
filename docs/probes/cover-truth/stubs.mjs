/**
 * 只给 `docs/probes/cover-truth/` 用的一组替身。
 *
 * `net.request` 故意抛错 = 模拟"链接读回空内容 / 下载失败"这一真机症状。
 * 被测的那条路径（runApply 在封面判据失败后有没有动盘）**不碰磁盘 API 之外的东西**，
 * 所以 drive/nedb/playlist/hits 这些与结论无关的模块替掉不影响证据。
 * ⚠️ 盘根指向临时目录：万一被测逻辑写错了，也不会写到任何真实盘上。
 */
import path from 'node:path';

const probeRoot = process.env.FF_PROBE_ROOT || process.cwd();

export const nativeImage = {
    createFromBuffer: () => ({ isEmpty: () => true, toJPEG: () => Buffer.alloc(0) }),
};
export const session = { fromPartition: () => ({}) };
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
export const net = {
    request: () => {
        // FF_PROBE_NET=ok ⇒ 回一张真 JPEG 头（toJpeg 走"JPEG 本尊"零转码分支）
        if (process.env.FF_PROBE_NET !== 'ok') throw new Error('stub: 模拟封面下载失败');
        const reqListeners = {};
        const req = {
            setHeader() {},
            on(ev, fn) { (reqListeners[ev] ||= []).push(fn); return req; },
            abort() {},
            end() {
                queueMicrotask(() => {
                    const resListeners = {};
                    const res = {
                        statusCode: 200, headers: { 'content-type': 'image/jpeg' },
                        on(ev, fn) { (resListeners[ev] ||= []).push(fn); return res; },
                    };
                    (reqListeners.response || []).forEach(fn => fn(res));
                    (resListeners.data || []).forEach(fn => fn(JPEG));
                    (resListeners.end || []).forEach(fn => fn());
                });
            },
        };
        return req;
    },
};
export const getDrives = async () => [{
    serial: 'PROBE', drive: 'P:', root: probeRoot.endsWith(path.sep) ? probeRoot : `${probeRoot}/`,
}];
export const findCache = async () => null;
export const removeCache = async () => undefined;
export const patchItemByLocation = async () => undefined;
export const appendTombstone = () => undefined;
