import { defineComponent, h } from 'vue';

/**
 * 自绘的「平铺 + 三档密度」四件套。
 *
 * ## 为什么自绘
 * Fluent 全量 20146 个图标里（网格/布局类 1236 个），24px 档能当"密度"用的只有三颗：
 * `Grid`(2×2 空心)、`GridDots`(3×3 实心点)、`Table`(带外框的 9 格) —— 三种画法，
 * 凑一起读不出"越来越密"，只读得出"三个不同的东西"。竖条类只有 `ColumnTriple` 一档。
 * Fluent 没有"同一形状 × 三种密度"的设计，这个语义它表达不了。
 *
 * ## 遵循的规范
 * Material Symbols / Heroicons / Phosphor 这一套业界通用的做法：
 *   · 24×24 画布，2px 内边距 ⇒ 活动区 20×20
 *   · **方块类占 18×18 keyline（3..21）** —— 方形比圆形视觉更重，所以比圆的小一档
 *   · **全实心填充**：18px 显示时描边只剩 1.5px，16 个描边框会糊成噪点
 *   · 圆角 ≤ 2，且随块变小同比缩（`r = s × 0.25`）
 *   · `fill="currentColor"`、保留 24×24 viewBox、不裁切
 *
 * ## 四者怎么分工（关键，别让它们互相撞）
 * · **平铺 = 横向卡片**（8.25×5，宽高比 1.65）⇒ "作品摊开成一片"
 * · **密度 = 正方形阵列** 2×2 / 3×3 / 4×4 ⇒ "一屏塞得更多"
 * 用的不是同一套形状语言（卡片 vs 方格），所以并排也不会被读成"四档密度"。
 *
 * ## 阵列参数怎么来的
 * 让「块宽 ÷ 间隙」保持 2.5 恒定：面积依次 225 / 199 / 190（差 ≤12%，视觉重量算齐），
 * 同时三档的间隙都 ≥1.4 单位 —— 18px 下约 1px，是"还看得出来是格子"的下限。
 * 再往密的档位走就必须牺牲可见间隙了（4×4 若保持等面积，缝只有 0.5px/18px 显示，会糊成实心块）。
 */
type Box = [x: number, y: number, w: number, h: number, r: number];

const icon = (name: string, boxes: Box[]) =>
    defineComponent({
        name,
        render: () =>
            h(
                'svg',
                { xmlns: 'http://www.w3.org/2000/svg', viewBox: '0 0 24 24', fill: 'currentColor' },
                boxes.map(([x, y, width, height, rx]) => h('rect', { x, y, width, height, rx })),
            ),
    });

/** n×n 方阵，块边长 `s`、间隙 `g`，整体落在 3..21。 */
const matrix = (n: number, s: number, g: number): Box[] => {
    const r = +(s * 0.25).toFixed(3);
    const out: Box[] = [];
    for (let row = 0; row < n; row++) {
        for (let col = 0; col < n; col++) {
            out.push([
                +(3 + col * (s + g)).toFixed(3),
                +(3 + row * (s + g)).toFixed(3),
                s,
                s,
                r,
            ]);
        }
    }
    return out;
};

/**
 * 平铺：2 列 × 3 行横向卡片（8.25×5，圆角 1.5）。
 * 横向拉长是刻意的 —— 它是"作品缩略图铺开"的样子，和下面三颗方格阵划清界限。
 */
export const FlatCards24 = icon('FlatCards24', (() => {
    const out: Box[] = [];
    const [w, h, g, r] = [8.25, 5, 1.5, 1.5];
    for (let row = 0; row < 3; row++) {
        for (let col = 0; col < 2; col++) {
            out.push([3 + col * (w + g), 3 + row * (h + g), w, h, r]);
        }
    }
    return out;
})());

/** 宽松（6 列）：2×2，块 7.5 / 隙 3 —— 块最大、最疏。 */
export const DensityWide24 = icon('DensityWide24', matrix(2, 7.5, 3));

/** 标准（8 列）：3×3，块 4.7 / 隙 1.95。 */
export const DensityNormal24 = icon('DensityNormal24', matrix(3, 4.7, 1.95));

/** 紧凑（12 列）：4×4，块 3.45 / 隙 1.4 —— 缝隙仍在 1px（18px 显示）以上，不糊成实心。 */
export const DensityTight24 = icon('DensityTight24', matrix(4, 3.45, 1.4));
