/**
 * 只读探针：验证 galaxy 像素层的**图案结构**，不需要浏览器。
 *
 * 为什么能这么测：`draw.ts` 是纯函数（只吃 ctx + 参数，不碰 DOM）⇒ 用假 ctx 录下每一次
 * `roundRect` / `fillRect` / `createRadialGradient`，就能算清结构。
 * 它证明不了"好不好看"，但能证明**不像 galaxy 的那几个具体特征**在不在：
 * ① 排数对不对  ② 左疏右密的梯度在不在  ③ 六色是不是都用上了  ④ 有没有空格子
 * ⑤ 光晕是不是三层同心（不是一团死紫）  ⑥ 放射粒子有没有真的向外铺开。
 *
 * 用法：node --experimental-strip-types docs/probes/galaxy-bar/pattern.mjs
 */
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drawGalaxyBar } from '../../../src/components/GalaxyLoadingBar/draw.ts';

const COLORS = ['#80d5d8', '#dc8cd5', '#b3a3e8', '#7061b5', '#f4c1eb', '#6656a0'];
const WIDTH = 1184; // 主屏常用宽度
const HEIGHT = 12; // --ff-bar-h
const PAD = HEIGHT * 3;

const cells = [];
const sparks = [];
const rings = [];
const ctx = {
    globalAlpha: 1,
    fillStyle: '',
    beginPath() {},
    roundRect(x, y, w, h, r) {
        cells.push({ x, y, w, h, r, alpha: this.globalAlpha, color: this.fillStyle });
    },
    fill() {},
    fillRect(x, y, w, h) {
        // 光晕的 fillStyle 是 gradient 对象，粒子的是颜色字符串 ⇒ 用它区分，别用宽度猜
        if (typeof this.fillStyle === 'object') {
            rings.push({ radius: this.fillStyle.radius, alpha: this.globalAlpha, stops: this.fillStyle.stops });
        } else {
            sparks.push({ x, y, size: w, alpha: this.globalAlpha, color: this.fillStyle });
        }
    },
    createRadialGradient(_x0, _y0, _r0, _x1, _y1, r) {
        const stops = [];
        return {
            radius: r,
            stops,
            addColorStop(pos, color) { stops.push(`${pos}:${color}`); },
        };
    },
};

drawGalaxyBar(ctx, {
    width: WIDTH,
    height: HEIGHT,
    time: 0.35,
    alpha: 1,
    colors: COLORS,
    glowCore: '#d9ccff',
    glowMid: '#8351ff',
    glowSoft: '#7543fc',
    pad: PAD,
});

const rows = Math.round(HEIGHT / 8);
const cell = HEIGHT / rows;
const cols = Math.ceil(WIDTH / cell);
const colOf = (c) => Math.floor((c.x + c.w / 2) / cell);

const grid = Array.from({ length: rows }, () => Array.from({ length: cols }, () => ' '));
for (const c of cells) {
    const r = Math.floor((c.y + c.h / 2) / cell);
    const k = colOf(c);
    if (grid[r] && grid[r][k] !== undefined) grid[r][k] = c.alpha > 0.55 ? '#' : '+';
}

const hist = {};
for (const c of cells) hist[c.color] = (hist[c.color] ?? 0) + 1;

const band = (from, to) => {
    let n = 0;
    for (const c of cells) {
        const k = colOf(c);
        if (k >= from && k < to) n += 1;
    }
    return n / Math.max(1, (to - from) * rows);
};

const cx = WIDTH;
const dists = sparks.map(s => Math.hypot(s.x + s.size / 2 - cx, s.y + s.size / 2 - HEIGHT / 2));

const lines = [];
lines.push(`geometry    rows=${rows} cell=${cell.toFixed(2)} cols=${cols} dot=${(cell * 0.64).toFixed(2)}`);
lines.push(`cells       ${cells.length} / ${rows * cols}   空白率 ${(100 * (1 - cells.length / (rows * cols))).toFixed(0)}%`);
lines.push(`cell alpha  ${Math.min(...cells.map(c => c.alpha)).toFixed(2)} ~ ${Math.max(...cells.map(c => c.alpha)).toFixed(2)}`);
lines.push(`colors      ${Object.entries(hist).map(([k, v]) => `${k}:${v}`).join(' ')}`);
lines.push(`density     左 ${(100 * band(0, Math.floor(cols / 3))).toFixed(0)}% | 中 ${(100 * band(Math.floor(cols / 3), Math.floor(cols * 2 / 3))).toFixed(0)}% | 右 ${(100 * band(Math.floor(cols * 2 / 3), cols)).toFixed(0)}%`);
lines.push(`glow rings  ${rings.length} 层：${rings.map(x => `r=${x.radius.toFixed(0)} α=${x.alpha.toFixed(2)}`).join(' | ')}`);
lines.push(`sparks      ${sparks.length} 个，半径 ${Math.min(...dists).toFixed(0)} ~ ${Math.max(...dists).toFixed(0)}px，色 ${new Set(sparks.map(s => s.color)).size} 种`);
lines.push(`           末环应到 ~${(HEIGHT * 2.6).toFixed(0)}px（画布高 ${HEIGHT + PAD}，中心 y=${HEIGHT / 2}）`);

const ascii = grid.map(row => row.slice(0, 120).join('')).join('\n');
const out = join(tmpdir(), 'galaxy-bar-pattern.txt');
writeFileSync(out, `${lines.join('\n')}\n\nASCII(前120列):\n${ascii}\n`, 'utf8');

console.log(lines.join('\n'));
console.log('\nASCII(前120列):');
console.log(ascii);
console.log(`\n→ ${out}`);
