/**
 * 卡包的皮肤 —— 移植自 `holo-reverse/src/app.js` 的 `SKINS` 与 `light()`。
 *
 * ## 为什么"每次重新画光影"值得
 *
 * 铝箔袋的"高级感"不在颜色，在**封边下方那一圈细碎的褶皱高光**和**底部封口的皱褶阴影**。
 * 这两样每次都是现画的（几十个宽度随机的细条 + 一条起伏的暗边），所以每一包的
 * 反光长得都不一样 —— 用户看第二包不会觉得"这是同一张图换了个色"。
 *
 * 全部生成成 SVG data URI，零图片资产。
 */

import { mirror, toPolygon } from './tearPath';
import type { Pt } from './tearPath';

/** 六种封面色。值是 `tokens.css` 里的变量名 —— 颜色本身不写在 TS 里（色值纪律） */
export const PACK_SKINS = [
    { key: 'cobalt', label: 'Cobalt' },
    { key: 'ember', label: 'Ember' },
    { key: 'grape', label: 'Grape' },
    { key: 'pine', label: 'Pine' },
    { key: 'night', label: 'Night' },
    { key: 'bubblegum', label: 'Bubblegum' },
] as const;

export type PackSkin = (typeof PACK_SKINS)[number];

function rand(a: number, b: number): number {
    return a + Math.random() * (b - a);
}

/** 包成 data URI。`#` 在 URI 里必须写成 `%23`（顺带让色值不变成 TS 里的字面量） */
function svgUri(body: string): string {
    return `url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100' preserveAspectRatio='none'>${body}</svg>")`;
}

/** 挑一个和上一包不同的皮肤（"绝不连续两次同色"） */
export function nextSkin(prevKey?: string): PackSkin {
    const pool = PACK_SKINS.filter(s => s.key !== prevKey);
    return pool[Math.floor(Math.random() * pool.length)];
}

export interface PackLight {
    /** 封边下方那一圈被压出的细碎高光 */
    shine: string;
    /** 底部封口皱进去的暗褶 */
    shade: string;
}

/**
 * 卡包的"圆角鼓起侧面" —— 移植自 `holo-reverse/src/app.js` 的 `rims` 段（466~477 行）。
 *
 * 铝箔袋的左右两条边不是直角：它是**鼓起来**的。做法是沿"厚度那个圆"排 9 条薄片，
 * 每条往外推一点、越靠后越短越暗，拼出一条卷过去的边。
 *
 * 纯几何，零 DOM：返回的 `style` 直接绑在模板上（这样 scoped 样式才认得出这些节点 ——
 * 用 `document.createElement` 造出来的元素拿不到 `data-v-*`，样式会整片失效）。
 */

export interface PackRim {
    key: string;
    side: 'l' | 'r';
    /** 基准顶边（%）。撕开时被撕到的那一侧要抬起来，得记住原值 */
    baseTop: number;
    style: Record<string, string>;
}

export function buildRims(): PackRim[] {
    const out: PackRim[] = [];
    for (const s of [-1, 1]) {
        for (const deg of [80, 60, 40, 20, 0, -20, -40, -60, -80]) {
            const a = (deg * Math.PI) / 180;
            const back = (1 - Math.sin(a)) / 2;
            const o = 4;
            const b = 5 * Math.cos(a);
            // 一条从 0 鼓到 100 再收回的弧，指数 .8 让它更像"面"而不是"半圆"
            const edge: Pt[] = Array.from({ length: 13 }, (_, i) => {
                const x = ((o + b * Math.sin((Math.PI * i) / 12) ** 0.8) / (o + b)) * 100;
                return [x, (i / 12) * 100] as Pt;
            });
            const shape: Pt[] = [[0, 0], ...edge, [0, 100]];
            const top = 11.5 + back * 13;
            out.push({
                key: `${s}/${deg}`,
                side: s > 0 ? 'r' : 'l',
                baseTop: top,
                style: {
                    [s > 0 ? 'left' : 'right']: `calc(50% + var(--pw) * .476 - ${o}px)`,
                    width: `${(o + b).toFixed(2)}px`,
                    top: `${top.toFixed(2)}%`,
                    bottom: `${top.toFixed(2)}%`,
                    transform: `translateZ(calc(var(--depth) * ${(Math.sin(a) / 2).toFixed(3)}))`,
                    clipPath: toPolygon(s > 0 ? shape : mirror(shape)),
                    // 色调与混入比例：右侧压暗（背光），左侧提亮（受光）
                    '--rim-tone': s > 0 ? 'black' : 'white',
                    '--rim-mix': `${Math.round(s > 0 ? 10 + back * 40 : 45 * (1 - back))}%`,
                },
            });
        }
    }
    return out;
}

/** 现画这一包的光与影。
 *
 * `shine`：从封边往下走的一批细竖条，每条宽度、长度、亮度都随机，越往下越淡；
 * 它们表示"铝箔在封口处被压出褶皱，褶皱吃到光"。
 * `shade`：底部一条由若干圆丘组成的暗边，表示"箔被折进封口"。
 */
export function paintLight(): PackLight {
    const f = (n: number) => n.toFixed(2);

    let lit = '';
    for (let x = 0; x < 100;) {
        const w = rand(0.5, 2.6);
        lit += `<rect x='${f(x)}' y='6.8' width='${f(w)}' height='${f(rand(3.2, 8.5))}' fill='url(%23g)' fill-opacity='${f(rand(0.08, 0.42))}'/>`;
        x += w + rand(0, 1.4);
    }

    let dark = 'M0 93.2V91.6';
    for (let x = 0; x < 100;) {
        const w = rand(2.5, 7);
        const peak = x + w * rand(0.35, 0.65);
        x = Math.min(100, x + w);
        dark += `Q${f(peak)} ${f(rand(86.6, 90))} ${f(x)} ${f(rand(91.1, 91.7))}`;
    }

    return {
        shine: svgUri(
            `<linearGradient id='g' x2='0' y2='1'><stop stop-color='%23fff' stop-opacity='.7'/><stop offset='1' stop-color='%23fff' stop-opacity='0'/></linearGradient>`
            + `<filter id='b'><feGaussianBlur stdDeviation='.28 .5'/></filter>`
            + `<g filter='url(%23b)'>${lit}</g>`,
        ),
        shade: svgUri(
            `<filter id='b'><feGaussianBlur stdDeviation='.35 .24'/></filter>`
            + `<path d='${dark}V93.2Z' fill-opacity='.1' filter='url(%23b)'/>`,
        ),
    };
}
