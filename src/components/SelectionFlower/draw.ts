/**
 * 把一株花**画出来**：茎两笔、叶子两片、花苞、花瓣、花心。
 *
 * 只碰 Canvas —— 形状长什么样、多大、开不开花，全部由 `shape.ts` 决定，
 * 这里不做任何判断（除了进度）。想改颜色比例去 tokens.css，想改尺寸去 shape.ts。
 */
import type { Flower, Palette } from './shape';

const clamp = (v: number) => Math.max(0, Math.min(1, v));

/** 贝塞尔上的点（t = 0 在出生点，1 在花头） */
function point(f: Flower, t: number) {
    const inv = 1 - t;
    return {
        x: inv * inv * f.x + 2 * inv * t * f.cx + t * t * f.ex,
        y: inv * inv * f.y + 2 * inv * t * f.cy + t * t * f.ey,
    };
}

function leafShape(ctx: CanvasRenderingContext2D, f: Flower, at: number, side: number, progress: number, palette: Palette) {
    if (progress <= 0) return;
    const p = point(f, at);
    const size = f.leaf * progress;
    const dx = side * size;
    const dy = f.direction * size * 0.48;
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.quadraticCurveTo(p.x + dx * 0.1, p.y + dy * 1.8, p.x + dx, p.y + dy);
    ctx.quadraticCurveTo(p.x + dx * 0.85, p.y - dy * 0.18, p.x, p.y);
    ctx.fillStyle = palette.leaf;
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = palette.leafLine;
    ctx.stroke();
}

/**
 * @param time `performance.now()`，只用来让花头轻微摇摆
 * @param sway 松手后（target=false）立刻停摆，收的过程是"单纯缩回去"
 */
export function drawFlower(
    ctx: CanvasRenderingContext2D,
    f: Flower,
    time: number,
    sway: boolean,
    palette: Palette,
) {
    const g = f.progress;
    /* 没花头（草）时茎要一直画到头；有花头的只画到 62%，剩下 38% 是留给花瓣顶出来的行程。
       ⚠️ 这两个进度不能共用 —— 共用的话草会短一截，顶端凭空断掉。 */
    const s = clamp(f.head === 'none' ? g : g / 0.62);
    if (s <= 0) return;

    // 茎：深底笔 + 亮面笔，两笔同一条路径 ⇒ 一根有体积的细茎
    ctx.beginPath();
    ctx.moveTo(f.x, f.y);
    for (let i = 1; i <= 28; i++) {
        const p = point(f, (s * i) / 28);
        ctx.lineTo(p.x, p.y);
    }
    ctx.lineWidth = 2.4;
    ctx.strokeStyle = palette.stem;
    ctx.stroke();
    ctx.lineWidth = 1.1;
    ctx.strokeStyle = palette.stemHi;
    ctx.stroke();

    if (f.leaves[0]) leafShape(ctx, f, 0.42, f.side, clamp((g - 0.22) / 0.34), palette);
    if (f.leaves[1]) leafShape(ctx, f, 0.7, -f.side, clamp((g - 0.34) / 0.34), palette);

    // 草形态到这里就结束：只有茎和叶，顶端不画任何花头
    if (f.head === 'none') return;

    const p = point(f, s);
    const wobble = sway ? Math.sin(time * 9e-3 + f.rotation) * 1.25 * clamp((g - 0.5) * 2) : 0;

    ctx.save();
    ctx.translate(p.x + wobble, p.y);
    ctx.rotate(f.rotation);
    ctx.lineWidth = 1.15;
    ctx.strokeStyle = palette.ink;

    // 花苞：先冒一个实心小点，花瓣从它里面顶出来
    const bud = clamp((g - 0.25) / 0.22) * Math.min(f.radius * 0.24, 3.5);
    if (bud > 0.05) {
        ctx.beginPath();
        ctx.ellipse(0, 0, bud, bud * 1.25, 0, 0, Math.PI * 2);
        ctx.fillStyle = f.colour;
        ctx.fill();
        ctx.stroke();
    }

    for (let k = 0; k < f.petals; k++) {
        const t = clamp((g - 0.42 - k * 0.027) / 0.32);
        if (!t) continue;
        // 花瓣不是线性张开：先慢后快，张到边缘会"翻"一下（三次项就是那下翻）
        const a = t - 1;
        const open = 1 + 2.1 * a * a * a + 1.1 * a * a;
        ctx.save();
        ctx.rotate((2 * Math.PI * k) / f.petals);
        ctx.beginPath();
        ctx.ellipse(
            f.radius * 0.6 * open,
            0,
            Math.max(0.05, f.radius * 0.64 * open),
            Math.max(0.05, f.radius * f.petalWidth * open),
            0,
            0,
            Math.PI * 2,
        );
        ctx.fillStyle = f.colour;
        ctx.fill();
        ctx.stroke();
        ctx.restore();
    }

    const core = f.petals ? clamp((g - 0.54) / 0.3) * f.radius * 0.25 : 0;
    if (core > 0.05) {
        ctx.beginPath();
        ctx.arc(0, 0, core, 0, Math.PI * 2);
        ctx.fillStyle = f.centre;
        ctx.fill();
        ctx.stroke();
    }
    ctx.restore();
}
