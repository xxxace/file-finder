/**
 * 音效配方表 —— 逐字取自 react-bits Sound Lab 的 `interface.js` 目录（2026-11-09 取样）。
 *
 * ⚠️ 配方是**声明式 JSON**，由 `engine.ts`（react-bits 的 react-bits-sound.ts 去壳版）
 *    在运行时用 Web Audio 合成 ⇒ **零二进制音频资产**。
 * ⚠️ 来源许可 MIT + Commons Clause：**可用在应用里，不许单独倒卖音效/引擎**。
 *    （https://github.com/DavidHDev/react-bits · LICENSE.md）
 * ⚠️ 配方不许手改数值 —— 每个都是 Sound Lab 调音台调好的成品；要换音色
 *    就从 catalog 里换一份新的 JSON（`src/tools/sound-lab/sounds/interface.js`）。
 */

export interface SfxRecipe {
    duration: number;
    seed: number;
    loudness: number;
    lowpass: number;
    reverb: { mix: number; decay: number; predelay: number; damp: number };
    layers: unknown[];
}

export const SFX_RECIPES = {
    /** 左轨入口 hover（Sound Lab「Hover」：drop target 就绪时的微光感，主人指定） */
    hover: {
        duration: 0.26, seed: 215, loudness: -23, lowpass: 8000,
        reverb: { mix: 0.15, decay: 0.45, predelay: 0.01, damp: 5000 },
        layers: [
            { type: 'tone', freq: 1318.51, voices: 2, detune: 9, env: { attack: 0.04, decay: 0.16, curve: 4 } },
            { type: 'tone', freq: 880, gain: -8, env: { attack: 0.05, decay: 0.15, curve: 4 } },
        ],
    },
    /** 菜单点击（Sound Lab「Nib」：tiny gentle tick，主人指定） */
    nib: {
        duration: 0.08, seed: 13, loudness: -21, lowpass: 8000,
        reverb: { mix: 0.06, decay: 0.18, predelay: 0.01, damp: 5000 },
        layers: [
            { type: 'tone', freq: { from: 1240, to: 980, time: 0.008, curve: 3 }, at: 0, gain: 0, env: { attack: 0.0015, decay: 0.028, curve: 6 } },
            { type: 'tone', freq: { from: 620, to: 560, time: 0.006, curve: 3 }, at: 0, gain: -15, env: { attack: 0.0015, decay: 0.02, curve: 6 } },
        ],
    },
    /** 档位/步进切换（密度、视图模式） */
    notch: {        duration: 0.06, seed: 22, loudness: -21, lowpass: 7000,
        reverb: { mix: 0.04, decay: 0.14, predelay: 0.01, damp: 5000 },
        layers: [
            { type: 'tone', freq: { from: 920, to: 780, time: 0.006, curve: 3 }, at: 0, gain: 0, env: { attack: 0.0012, decay: 0.022, curve: 6 } },
            { type: 'noise', color: 'pink', at: 0, gain: -14, punch: true, filter: [{ type: 'bandpass', freq: 1350, q: 1 }, { type: 'lowpass', freq: 3510, q: 0.5 }], env: { attack: 0.0012, decay: 0.006, curve: 6 } },
            { type: 'tone', freq: { from: 380, to: 360, time: 0.025, curve: 3 }, at: 0, gain: -17, env: { attack: 0.0015, decay: 0.02, curve: 6 } },
        ],
    },
    /** 开关：开 */
    clasp: {
        duration: 0.12, seed: 31, loudness: -19, lowpass: 7000,
        reverb: { mix: 0.06, decay: 0.22, predelay: 0.01, damp: 5000 },
        layers: [
            { type: 'tone', freq: { from: 500, to: 420, time: 0.012, curve: 3 }, at: 0, gain: 0, env: { attack: 0.0015, decay: 0.028, curve: 6 } },
            { type: 'noise', color: 'pink', at: 0, gain: -17, punch: true, filter: [{ type: 'bandpass', freq: 1100, q: 0.8 }, { type: 'lowpass', freq: 2860, q: 0.5 }], env: { attack: 0.001, decay: 0.006, curve: 6 } },
            { type: 'tone', freq: { from: 700, to: 610, time: 0.012, curve: 3 }, at: 0.045, gain: 0, env: { attack: 0.0015, decay: 0.035, curve: 6 } },
            { type: 'noise', color: 'pink', at: 0.045, gain: -19, punch: true, filter: [{ type: 'bandpass', freq: 1450, q: 0.8 }, { type: 'lowpass', freq: 3770, q: 0.5 }], env: { attack: 0.001, decay: 0.006, curve: 6 } },
        ],
    },
    /** 开关：关 */
    unclasp: {
        duration: 0.12, seed: 32, loudness: -19, lowpass: 7000,
        reverb: { mix: 0.06, decay: 0.22, predelay: 0.01, damp: 5000 },
        layers: [
            { type: 'tone', freq: { from: 680, to: 600, time: 0.012, curve: 3 }, at: 0, gain: 0, env: { attack: 0.0015, decay: 0.026, curve: 6 } },
            { type: 'noise', color: 'pink', at: 0, gain: -18, punch: true, filter: [{ type: 'bandpass', freq: 1400, q: 0.8 }, { type: 'lowpass', freq: 3640, q: 0.5 }], env: { attack: 0.001, decay: 0.006, curve: 6 } },
            { type: 'tone', freq: { from: 470, to: 390, time: 0.014, curve: 3 }, at: 0.045, gain: 0, env: { attack: 0.0015, decay: 0.035, curve: 6 } },
            { type: 'noise', color: 'pink', at: 0.045, gain: -17, punch: true, filter: [{ type: 'bandpass', freq: 1000, q: 0.8 }, { type: 'lowpass', freq: 2600, q: 0.5 }], env: { attack: 0.001, decay: 0.006, curve: 6 } },
        ],
    },
    /** 切到浅色主题 */
    daylight: {
        duration: 0.38, seed: 34, loudness: -19, lowpass: 9000,
        reverb: { mix: 0.16, decay: 0.5, predelay: 0.01, damp: 7000 },
        layers: [
            { type: 'tone', freq: 880, at: 0, gain: 0, partials: [[1, 1, 1], [2, 0.08, 0.55], [3, 0.02, 0.35]], env: { attack: 0.004, decay: 0.14, curve: 6 } },
            { type: 'tone', freq: 1174.66, at: 0.06, gain: -2, partials: [[1, 1, 1], [2, 0.08, 0.55], [3, 0.02, 0.35]], env: { attack: 0.004, decay: 0.24, curve: 6 } },
            { type: 'noise', color: 'pink', gain: -26, filter: [{ type: 'highpass', freq: 3000, q: 0.5 }, { type: 'lowpass', freq: 8000, q: 0.5 }], env: { attack: 0.06, decay: 0.15, curve: 4 } },
        ],
    },
    /** 切到深色主题 */
    nightfall: {
        duration: 0.45, seed: 35, loudness: -19.5, lowpass: 4500,
        reverb: { mix: 0.18, decay: 0.6, predelay: 0.01, damp: 3500 },
        layers: [
            { type: 'tone', freq: 739.99, at: 0, gain: 0, partials: [[1, 1, 1], [2, 0.04, 0.55], [3, 0.01, 0.35]], env: { attack: 0.004, decay: 0.16, curve: 6 } },
            { type: 'tone', freq: 493.88, at: 0.07, gain: -1, partials: [[1, 1, 1], [2, 0.04, 0.55], [3, 0.01, 0.35]], env: { attack: 0.004, decay: 0.3, curve: 6 } },
        ],
    },
    /** 扫描 / 补全 / apply 完成（成功上扬双音） */
    bloom: {
        duration: 0.95, seed: 41, loudness: -17, lowpass: 7500,
        reverb: { mix: 0.16, decay: 0.8, predelay: 0.01, damp: 5500 },
        layers: [
            { type: 'tone', freq: 587.33, at: 0, gain: 0, partials: [[1, 1, 1], [2, 0.16, 0.55], [3, 0.04, 0.35]], env: { attack: 0.004, decay: 0.5, curve: 6 } },
            { type: 'tone', freq: 880, at: 0.09, gain: 0, partials: [[1, 1, 1], [2, 0.16, 0.55], [3, 0.04, 0.35]], env: { attack: 0.004, decay: 0.75, curve: 6 } },
            { type: 'tone', freq: 1760, at: 0.09, gain: -22, partials: [[1, 1, 1], [2, 0.08, 0.55], [3, 0.02, 0.35]], env: { attack: 0.004, decay: 0.4, curve: 6 } },
        ],
    },
    /** 收藏添加（玻璃粒pick音） */
    bead: {
        duration: 0.22, seed: 21, loudness: -20, lowpass: 9000,
        reverb: { mix: 0.12, decay: 0.45, predelay: 0.01, damp: 6000 },
        layers: [
            { type: 'tone', freq: 880, at: 0, gain: 0, partials: [[1, 1, 1], [2.76, 0.108, 0.4], [5.4, 0.027, 0.22]], env: { attack: 0.0025, decay: 0.17, curve: 6 } },
        ],
    },
    /**
     * 移动硬盘插入（Sound Lab「Plug」：连接设备的上扬点击）。
     * 结构与官方逐字对齐：blip(180→150 triangle, 800Hz 低通) + knock(800) + 两颗 bell(81/86, bright .4)。
     */
    plug: {
        duration: 0.55, seed: 85, loudness: -18.5, lowpass: 7000,
        reverb: { mix: 0.12, decay: 0.5, predelay: 0.01, damp: 5000 },
        layers: [
            { type: 'tone', wave: 'triangle', freq: { from: 180, to: 150, time: 0.02, curve: 3 }, at: 0, gain: 0, filter: { type: 'lowpass', freq: 800, q: 0.6 }, env: { attack: 0.003, decay: 0.05, curve: 6 } },
            { type: 'noise', color: 'pink', at: 0, gain: -12, punch: true, filter: [{ type: 'bandpass', freq: 800, q: 0.7 }, { type: 'lowpass', freq: 2080, q: 0.5 }], env: { attack: 0.001, decay: 0.012, curve: 6 } },
            { type: 'tone', freq: 880, at: 0.09, gain: -6, partials: [[1, 1, 1], [2, 0.064, 0.55], [3, 0.016, 0.35]], env: { attack: 0.004, decay: 0.18, curve: 6 } },
            { type: 'tone', freq: 1174.66, at: 0.16, gain: -6, partials: [[1, 1, 1], [2, 0.064, 0.55], [3, 0.016, 0.35]], env: { attack: 0.004, decay: 0.3, curve: 6 } },
        ],
    },
    /**
     * 移动硬盘拔出（Sound Lab「Unplug」：与 Plug 成对的下落点击）。
     * 镜像结构：bell(86→79) 先落，再在 0.16 处 blip(170→140) + knock(700) 收尾。
     */
    unplug: {
        duration: 0.5, seed: 86, loudness: -18.5, lowpass: 6500,
        reverb: { mix: 0.12, decay: 0.5, predelay: 0.01, damp: 5000 },
        layers: [
            { type: 'tone', freq: 1174.66, at: 0, gain: -6, partials: [[1, 1, 1], [2, 0.064, 0.55], [3, 0.016, 0.35]], env: { attack: 0.004, decay: 0.16, curve: 6 } },
            { type: 'tone', freq: 783.99, at: 0.08, gain: -6, partials: [[1, 1, 1], [2, 0.064, 0.55], [3, 0.016, 0.35]], env: { attack: 0.004, decay: 0.24, curve: 6 } },
            { type: 'tone', wave: 'triangle', freq: { from: 170, to: 140, time: 0.02, curve: 3 }, at: 0.16, gain: 0, filter: { type: 'lowpass', freq: 800, q: 0.6 }, env: { attack: 0.003, decay: 0.05, curve: 6 } },
            { type: 'noise', color: 'pink', at: 0.16, gain: -13, punch: true, filter: [{ type: 'bandpass', freq: 700, q: 0.7 }, { type: 'lowpass', freq: 1820, q: 0.5 }], env: { attack: 0.001, decay: 0.012, curve: 6 } },
        ],
    },
    /** 复制 / 导出完成（单铃短尾） */
    ping: {
        duration: 1.2, seed: 53, loudness: -17, lowpass: 8000,
        reverb: { mix: 0.2, decay: 1.2, predelay: 0.01, damp: 6000 },
        layers: [
            { type: 'tone', freq: 880, at: 0, gain: 0, partials: [[1, 1, 1], [2, 0.128, 0.55], [3, 0.032, 0.35]], env: { attack: 0.004, decay: 1.1, curve: 6 } },
        ],
    },
    /** 错误 / 需要注意（柔和双击，不刺耳） */
    nudge: {
        duration: 0.3, seed: 44, loudness: -19, lowpass: 6500,
        reverb: { mix: 0.1, decay: 0.35, predelay: 0.01, damp: 5000 },
        layers: [
            { type: 'tone', freq: 659.26, at: 0, gain: 0, partials: [[1, 1, 1], [3.93, 0.16, 0.25], [9.2, 0.025, 0.1]], env: { attack: 0.002, decay: 0.09, curve: 6 } },
            { type: 'tone', freq: 659.26, at: 0.11, gain: 0, partials: [[1, 1, 1], [3.93, 0.16, 0.25], [9.2, 0.025, 0.1]], env: { attack: 0.002, decay: 0.12, curve: 6 } },
        ],
    },
} satisfies Record<string, SfxRecipe>;
