import { defineComponent, h } from 'vue';

/**
 * 自绘的「瞄准准星」—— 定位到网格那颗。
 *
 * ## 为什么自绘
 * ionicons 全库里"定位/瞄准"一族只有三颗，全都不贴切：
 * `Locate`(GPS 十字，四向刻度出头，读作"我的位置")、`Scan`(取景四角框，读作"扫一扫/全屏")、
 * `ScanCircle`(环形扫描，读作"雷达")。经典瞄准具（圆环 + 中心点 + 四向短刻度，
 * 即游戏/相机 UI 里 reticle 的标准画法）它没有 —— 而这个动作恰好就是"瞄准网格里那一张"。
 *
 * ## 画法
 * 圆环 r6 + 中心点 r2.2 + 四向刻度（环外 8.5 → 11，留 1px 边距），
 * 描边 1.8 / linecap round —— 与 20px 显示下的 ionicons 描边粗细同档。
 */
export const Target24 = defineComponent({
    name: 'Target24',
    render: () =>
        h('svg', { xmlns: 'http://www.w3.org/2000/svg', viewBox: '0 0 24 24' }, [
            h('circle', { cx: 12, cy: 12, r: 6, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8 }),
            h('circle', { cx: 12, cy: 12, r: 2.2, fill: 'currentColor' }),
            h('line', { x1: 12, y1: 1, x2: 12, y2: 3.5, stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round' }),
            h('line', { x1: 12, y1: 20.5, x2: 12, y2: 23, stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round' }),
            h('line', { x1: 1, y1: 12, x2: 3.5, y2: 12, stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round' }),
            h('line', { x1: 20.5, y1: 12, x2: 23, y2: 12, stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round' }),
        ]),
});
