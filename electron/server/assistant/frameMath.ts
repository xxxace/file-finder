/**
 * 抽帧 · 与 IO 无关的判定（阶梯 + 纯色占比）。
 *
 * 单独一个文件的目的：能被 `docs/probes/frame-math/run.mjs` 直接跑（本项目没有测试框架，
 * 纯函数探针就是我们的 RED/GREEN 载体）。这里**不许** import electron / fs —— 一旦引了，
 * 探针就跑不起来，判定就只能靠真机目视，那是没法回归的。
 */

/**
 * 抽帧位置阶梯（占时长的百分比）。
 *
 * 从 1% 起步是既有取帧口径（`thumbnail.ts` 的 `videoRenditions` 也是 1%），往后按几何式
 * 拉开：开头几档密（片头常有黑场/logo，一小段一小段试才找得到内容），后面稀（到了中段
 * 位置差几秒画面差不多）。50% 封顶 —— 再往后基本是场景铺陈，信息量不比中段高。
 */
export const PCT_LADDER = [1, 2, 3, 5, 8, 12, 18, 25, 35, 50] as const;

/** 第 n 档的百分比。越界钳到两端（前端传错档位不该炸，也不该抽到 300%） */
export function pctOf(attempt: number): number {
    const n = Number.isFinite(attempt) ? Math.trunc(attempt) : 0;
    const i = Math.min(Math.max(n, 0), PCT_LADDER.length - 1);
    return PCT_LADDER[i];
}

/**
 * 「这张帧不能当封面」的同色占比阈值（主人 2026-11-10 裁决：纯色占 90% 才自动往后跳）。
 *
 * ⚠️ 只看**同色占比**，不看亮度 —— 他的原话是"纯色"，不是"太黑"：一张暗但有内容的帧
 *    不该被跳掉，而纯白闪屏、纯色过场卡一样没法当封面。
 * ⚠️ 已知边界：大面积同色但非纯色的画面（天花板/墙面/天空）也会过线 ⇒ 会被误跳；
 *    渐变黑场（fade in/out）不是纯色 ⇒ 逃得过判据。这是判据本身的形状，不另打补丁。
 */
export const FLAT_RATIO = 0.9;

/** 采样边长。64×64 = 4096 像素，足够稳定判定，又不值得为它多解一次大图 */
export const FLAT_SAMPLE = 64;

/**
 * 最大同色桶占比（0~1）。
 *
 * 每通道 `>>3` 量化成 32 档：JPEG 振铃让"纯黑区"解码出来不是精确的 0,0,0，
 * 不量化的话同一片黑会被切成几百个桶，占比永远上不去。
 *
 * `rgba` 是 4 字节/像素的位图（BGRA 或 RGBA 都行 —— 三个通道对称量化，顺序不影响占比）。
 */
export function flatRatio(rgba: Uint8Array, w: number, h: number): number {
    const total = w * h;
    if (!total || rgba.length < total * 4) return 0;

    // 4096 个像素用 Map 足够快；用定长数组（32768 槽）会为了省几微秒多占 128KB
    const counts = new Map<number, number>();
    let max = 0;
    for (let i = 0; i < total; i++) {
        const p = i * 4;
        const key = ((rgba[p] >> 3) << 10) | ((rgba[p + 1] >> 3) << 5) | (rgba[p + 2] >> 3);
        const n = (counts.get(key) ?? 0) + 1;
        counts.set(key, n);
        if (n > max) max = n;
    }
    return max / total;
}
