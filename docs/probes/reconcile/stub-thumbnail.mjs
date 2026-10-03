/**
 * 探针专用桩：把真抽帧换成「只计数、不解码」。
 *
 * 为什么能这样替 —— 本探针要验的**不是**"抽出来的图对不对"，而是
 * **"这一张该不该抽"**：增量对账有没有把不该抽的跳过。
 * 判据是**次数**，所以没必要真起 ffmpeg、真解码整图
 * （那恰恰就是被优化掉的那个动作）。
 *
 * ⚠️ 顺带也是**必须**桩的原因：真 `electron/utils/thumbnail.ts` 依赖 electron 的
 * `nativeImage`，纯 Node 下加载会直接炸。探针要跑在纯 Node（不起 Electron），所以必须换掉它。
 */
globalThis.__thumbCalls = 0;

/** 一段合法的 JPEG 头尾，让上层 `data:image/jpeg;base64,...` 拼得出来即可 */
const FAKE_JPEG = Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9,
]);

export async function imageThumb() {
    globalThis.__thumbCalls += 1;
    return FAKE_JPEG;
}

export async function videoThumb() {
    globalThis.__thumbCalls += 1;
    return FAKE_JPEG;
}
