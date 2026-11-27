import { defineComponent, h } from 'vue';
import type { VNode } from 'vue';

/**
 * 自绘的「排序」六件套（名称 升/降、大小 降/升、盘符 升/降）。
 *
 * ## 为什么自绘
 * `@vicons/ionicons5` 里没有组合型排序图标（仅 `SwapVerticalOutline` 可作默认顺序），
 * 此前用 `TextOutline` / `StatsChartOutline` / `DiscOutline` 既不能望 icon 生义，
 * 同一维度的升序与降序在按钮和菜单里也无法区分。
 *
 * ## 统一视觉语法（24×24 画布，活动区 x: 2.5..21.5, y: 3..21）
 * - 左侧固定为方向箭头：`↑` 统一表示升序（A→Z / 从小到大 / 在线优先），`↓` 统一表示降序（Z→A / 从大到小 / 逆序）
 * - 右侧固定为排序维度：`A/Z`（名称）、三档阶梯横条（大小）、圆盘（盘符）
 * - 描边 `1.7` / `linecap: round` / `linejoin: round`，与 18px 显示下的 ionicons5 线条粗细对齐。
 */
const STROKE_PROPS = {
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': 1.7,
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
} as const;

const sortIcon = (name: string, children: () => VNode[]) =>
    defineComponent({
        name,
        render: () =>
            h(
                'svg',
                { xmlns: 'http://www.w3.org/2000/svg', viewBox: '0 0 24 24', ...STROKE_PROPS },
                children(),
            ),
    });

const upArrow = (x = 6.5): VNode[] => [
    h('path', { d: `M${x} 19.5V4.5` }),
    h('path', { d: `M${x - 3} 7.5L${x} 4.5L${x + 3} 7.5` }),
];

const downArrow = (x = 6.5): VNode[] => [
    h('path', { d: `M${x} 4.5V19.5` }),
    h('path', { d: `M${x - 3} 16.5L${x} 19.5L${x + 3} 16.5` }),
];

const glyphA = (top: number): VNode[] => [
    h('path', { d: `M13.5 ${top + 7}L17 ${top}L20.5 ${top + 7}` }),
    h('path', { d: `M14.8 ${top + 4.5}H19.2` }),
];

const glyphZ = (top: number): VNode[] => [
    h('path', { d: `M14 ${top}H20L14 ${top + 7}H20` }),
];

const discGlyph = (cx = 15.5, cy = 12): VNode[] => [
    h('circle', { cx, cy, r: 5.5 }),
    h('circle', { cx, cy, r: 1.8 }),
];

/** 名称 A → Z：左 ↑ + 右 A 上 Z 下。 */
export const SortNameAsc24 = sortIcon('SortNameAsc24', () => [
    ...upArrow(6.5),
    ...glyphA(3.5),
    ...glyphZ(13.5),
]);

/** 名称 Z → A：左 ↓ + 右 Z 上 A 下。 */
export const SortNameDesc24 = sortIcon('SortNameDesc24', () => [
    ...downArrow(6.5),
    ...glyphZ(3.5),
    ...glyphA(13.5),
]);

/** 大小 从大到小：左 ↓ + 右长到短三横条。 */
export const SortSizeDesc24 = sortIcon('SortSizeDesc24', () => [
    ...downArrow(6.5),
    h('path', { d: 'M12.5 6.5H21' }),
    h('path', { d: 'M12.5 12H18' }),
    h('path', { d: 'M12.5 17.5H15' }),
]);

/** 大小 从小到大：左 ↑ + 右短到长三横条。 */
export const SortSizeAsc24 = sortIcon('SortSizeAsc24', () => [
    ...upArrow(6.5),
    h('path', { d: 'M12.5 6.5H15' }),
    h('path', { d: 'M12.5 12H18' }),
    h('path', { d: 'M12.5 17.5H21' }),
]);

/** 盘符 在线优先：左 ↑ + 右磁盘。 */
export const SortDiskAsc24 = sortIcon('SortDiskAsc24', () => [
    ...upArrow(5.5),
    ...discGlyph(15.5, 12),
]);

/** 盘符 逆序：左 ↓ + 右磁盘。 */
export const SortDiskDesc24 = sortIcon('SortDiskDesc24', () => [
    ...downArrow(5.5),
    ...discGlyph(15.5, 12),
]);
