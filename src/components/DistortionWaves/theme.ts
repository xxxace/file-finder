import type { Palette, RGB } from './model';

/**
 * Resolve any CSS color string (hex, rgb, oklch, etc.) into an [r, g, b] tuple
 * via a 1x1 offscreen canvas — avoids duplicating CSS color parsers or writing
 * color literals in business code.
 */
let probeCtx: CanvasRenderingContext2D | null = null;

function ensureProbeCtx(): CanvasRenderingContext2D | null {
    if (probeCtx) return probeCtx;
    if (typeof document === 'undefined') return null;
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    probeCtx = canvas.getContext('2d', { willReadFrequently: true });
    return probeCtx;
}

export function cssColorToRgb(cssColor: string, fallback: RGB = [255, 255, 255]): RGB {
    const ctx = ensureProbeCtx();
    if (!ctx || !cssColor) return fallback;
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = cssColor;
    ctx.fillRect(0, 0, 1, 1);
    const data = ctx.getImageData(0, 0, 1, 1).data;
    if (data[3] === 0) return fallback;
    return [data[0], data[1], data[2]];
}

const mixRgb = (a: RGB, b: RGB, t: number): RGB => [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
];

/**
 * Read theme glow tokens from `tokens.css` (`--ff-glow-1/2/3`) and construct
 * a rich wave palette compatible with both light and dark themes.
 */
export function readThemeWavePalette(
    tokenNames: readonly [string, string, string] = ['--ff-glow-1', '--ff-glow-2', '--ff-glow-3'],
): Palette {
    if (typeof document === 'undefined') {
        return {
            colors: [[255, 255, 255], [220, 220, 220], [200, 200, 200]],
            ahead: [255, 255, 255],
            behind: [180, 180, 180],
        };
    }
    const cs = getComputedStyle(document.documentElement);
    const read = (name: string): RGB => cssColorToRgb(cs.getPropertyValue(name).trim());
    const c1 = read(tokenNames[0]);
    const c2 = read(tokenNames[1]);
    const c3 = read(tokenNames[2]);

    // Interleave primary glow tones and soft highlights for smooth Oklab cycling along the front
    return {
        colors: [
            c1,
            mixRgb(c1, c2, 0.5),
            c2,
            mixRgb(c2, c3, 0.5),
            c3,
            mixRgb(c3, c1, 0.5),
        ],
        ahead: mixRgb(c1, [255, 255, 255], 0.35),
        behind: mixRgb(c3, c2, 0.45),
    };
}

/** Read background color behind `el` by walking ancestors, falling back to `--ff-canvas`. */
export function readElementBackground(el: Element): string {
    const isTransparent = (c: string) =>
        !c || c === 'transparent' || /(?:,|\/)\s*0(?:\.0+)?%?\s*\)$/.test(c);

    for (let n: Element | null = el; n; n = n.parentElement) {
        const bg = getComputedStyle(n).backgroundColor;
        if (!isTransparent(bg)) return bg;
    }
    const canvasVar = getComputedStyle(document.documentElement).getPropertyValue('--ff-canvas').trim();
    return canvasVar || 'Canvas';
}
