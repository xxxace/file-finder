/* Smooth flowing aurora + rising motes for the waiting phase before the
   DistortionWave sweep-out launches. Uses theme tokens via `theme.ts`
   so no color literals are needed. */

import { smooth } from './model';
import { readThemeWavePalette } from './theme';

const hash = (n: number) => {
    const q = Math.sin(n * 127.1 + 311.7) * 43758.5453;
    return q - Math.floor(q);
};

const MOTES = Array.from({ length: 110 }, (_, i) => ({
    x: hash(i + 2),
    phase: hash(i + 20),
    speed: 0.18 + hash(i + 600) * 0.14,
    size: 0.3 + Math.pow(hash(i + 100), 3) * 1.4,
    light: 0.35 + hash(i + 80) * 0.6,
    twinkle: 2 + hash(i + 700) * 4,
}));

export class AuroraWaiting {
    private paletteCss: [string, string, string] = ['white', 'white', 'white'];
    private dotColor = 'white';

    refreshColors() {
        const pal = readThemeWavePalette();
        const toCss = (rgb: [number, number, number]) => `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
        // Pick the 3 primary theme glow colors (indices 0, 2, 4 in readThemeWavePalette)
        this.paletteCss = [
            toCss(pal.colors[0] ?? [255, 255, 255]),
            toCss(pal.colors[2] ?? [255, 255, 255]),
            toCss(pal.colors[4] ?? [255, 255, 255]),
        ];
        if (typeof document !== 'undefined') {
            this.dotColor = getComputedStyle(document.documentElement).getPropertyValue('--ff-text-1').trim() || 'white';
        }
    }

    resize(canvas: HTMLCanvasElement) {
        const dpr = window.devicePixelRatio || 1;
        const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
        const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
        if (canvas.width !== w || canvas.height !== h) {
            canvas.width = w;
            canvas.height = h;
        }
        const ctx = canvas.getContext('2d');
        if (ctx) {
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.fillStyle = this.dotColor;
        }
    }

    draw(canvas: HTMLCanvasElement, t: number, enterEnvelope: number) {
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        const w = canvas.clientWidth;
        const h = canvas.clientHeight;
        if (!w || !h) return;

        ctx.clearRect(0, 0, w, h);

        // Gentle upward-breathing base near the bottom edge
        const cycle = (t % 5.2) / 5.2;
        const rise = smooth(0, 0.18, t);
        const base = 1.04 - 0.1 * rise - 0.04 * Math.sin(cycle * Math.PI * 2);
        const breath = 1 + 0.18 * Math.sin(t * 2.1 - 0.5);

        const wash = (x: number, y: number, rx: number, ry: number, color: string, alpha: number) => {
            ctx.save();
            ctx.translate(x * w, y * h);
            ctx.scale(rx * w, ry * h * breath);
            ctx.globalAlpha = alpha * enterEnvelope;
            const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1.6);
            g.addColorStop(0, color);
            g.addColorStop(0.45, color);
            g.addColorStop(1, 'transparent');
            ctx.fillStyle = g;
            ctx.fillRect(-1.6, -1.6, 3.2, 3.2);
            ctx.restore();
        };

        const [g1, g2, g3] = this.paletteCss;
        wash(0.42 + 0.05 * Math.sin(t * 0.8), base + 0.02, 0.72, 0.17, g1, 0.34);
        wash(0.32 + 0.06 * Math.sin(t * 1.1), base - 0.03, 0.4, 0.21, g2, 0.26);
        wash(0.14 + 0.04 * Math.cos(t * 1.5), base + 0.06, 0.3, 0.14, g3, 0.3);
        wash(0.84 + 0.04 * Math.sin(t * 1.1), base - 0.08, 0.38, 0.22, g3, 0.22);
        wash(0.86 + 0.04 * Math.sin(t * 1.2), base + 0.02, 0.22, 0.08, g2, 0.32);
        wash(0.52 + 0.06 * Math.sin(t * 0.95), base + 0.08, 0.36, 0.16, g1, 0.28);

        // Rising luminous motes
        ctx.fillStyle = this.dotColor;
        for (const m of MOTES) {
            const life = (t * m.speed + m.phase) % 1;
            const x = (m.x + Math.sin(t * 0.9 + m.phase * 40) * 0.015) * w;
            const y = (base + 0.18 - life * 0.38) * h;
            const alpha =
                Math.sin(life * Math.PI) *
                m.light *
                (0.72 + 0.28 * Math.sin(t * m.twinkle)) *
                enterEnvelope *
                0.85;
            if (alpha <= 0.005) continue;
            ctx.globalAlpha = alpha;
            ctx.beginPath();
            ctx.arc(x, y, (m.size * Math.min(w, h)) / 540, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.globalAlpha = 1;
    }
}
