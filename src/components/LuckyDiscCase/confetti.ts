/**
 * 彩带 —— 爆开那一刻从盒口喷出来的纸屑。
 *
 * 三个设计约束（都是被真机教训过的）：
 *  ① **单画布**：一百多个 DOM 元素各自 animation 会让每片都是一个合成层，低端机上直接掉帧；
 *     canvas 一次绘制，代价恒定。
 *  ② **不接管时间轴**：这里是纯绘制，谁要喷、什么时候喷由页面决定。
 *  ③ **必须能被停掉**：返回的 `stop()` 取消 RAF 并清屏。外壳用 KeepAlive，离页不会触发
 *     组件卸载 —— 忘了停就是后台一直烧 CPU（隧道页那个 idle dispose 是同一类问题）。
 */

export interface ConfettiOptions {
    /** 片数，默认 110 */
    count?: number;
    /** 从哪儿喷（0~1 相对画布），默认盒口正中偏上 */
    origin?: { x: number; y: number };
    /** 初速倍率，默认 1 */
    power?: number;
    /** 颜色，通常从 `--ff-foil-*` 读出来传进来（canvas 里不能用 `var()`） */
    colors?: string[];
}

interface Particle {
    x: number;
    y: number;
    vx: number;
    vy: number;
    /** 旋转角与角速度（rad、rad/s） */
    rot: number;
    spin: number;
    w: number;
    h: number;
    color: string;
    /** 已活时长（s），用于淡出 */
    age: number;
    life: number;
}

const DEFAULT_COLORS = ['#f09ab6', '#e8c98a', '#9ad9ec', '#f1f2f3'];
const GRAVITY = 980;
const DRAG = 0.86;
const MAX_LIFE = 2.6;

/**
 * 在 `canvas` 上喷一次。返回 `stop`（幂等，可以随便多调）。
 */
export function burst(canvas: HTMLCanvasElement, opts: ConfettiOptions = {}): () => void {
    // 减少动态效果：不是"少喷一点"，是"不喷" —— 半套动画比没有更难受
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return () => {};

    const ctx = canvas.getContext('2d');
    if (!ctx) return () => {};

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cssW = canvas.clientWidth || 1;
    const cssH = canvas.clientHeight || 1;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const count = opts.count ?? 110;
    const power = opts.power ?? 1;
    const colors = opts.colors?.length ? opts.colors : DEFAULT_COLORS;
    const ox = (opts.origin?.x ?? 0.5) * cssW;
    const oy = (opts.origin?.y ?? 0.42) * cssH;

    const particles: Particle[] = [];
    for (let i = 0; i < count; i += 1) {
        // 向上为主的扇形：-160°~-20°（0° 向右、90° 向下）
        const angle = (-160 + Math.random() * 140) * (Math.PI / 180);
        const speed = (260 + Math.random() * 520) * power;
        const wide = Math.random() < 0.34;
        particles.push({
            x: ox + (Math.random() - 0.5) * 40,
            y: oy + (Math.random() - 0.5) * 18,
            vx: Math.cos(angle) * speed,
            vy: Math.sin(angle) * speed,
            rot: Math.random() * Math.PI,
            spin: (Math.random() - 0.5) * 18,
            // 三分之二是细长条（像纸带），三分之一是方块片
            w: wide ? 4 + Math.random() * 3 : 6 + Math.random() * 7,
            h: wide ? 12 + Math.random() * 12 : 5 + Math.random() * 5,
            color: colors[Math.floor(Math.random() * colors.length)],
            age: 0,
            life: 1.6 + Math.random() * (MAX_LIFE - 1.6),
        });
    }

    let raf = 0;
    let last = performance.now();
    let stopped = false;

    const frame = (now: number) => {
        if (stopped) return;
        // 夹一下：切到后台再回来时 delta 会是好几秒，粒子会瞬间穿出屏幕
        const dt = Math.min((now - last) / 1000, 0.05);
        last = now;

        ctx.clearRect(0, 0, cssW, cssH);

        let alive = 0;
        for (const p of particles) {
            p.age += dt;
            if (p.age >= p.life) continue;
            alive += 1;

            p.vy += GRAVITY * dt;
            // 空气阻力按指数衰减，比"每帧乘 0.99"更稳（与帧率无关）
            const damp = Math.pow(DRAG, dt * 60);
            p.vx *= damp;
            p.vy *= damp;
            p.x += p.vx * dt;
            p.y += p.vy * dt;
            p.rot += p.spin * dt;

            // 最后 30% 生命淡出
            const left = (p.life - p.age) / (p.life * 0.3);
            ctx.globalAlpha = Math.max(0, Math.min(1, left));
            ctx.fillStyle = p.color;

            ctx.save();
            ctx.translate(p.x, p.y);
            ctx.rotate(p.rot);
            // 用 y 轴压扁模拟纸片翻面（省掉真正的 3D）
            ctx.scale(1, Math.abs(Math.cos(p.rot * 1.6)) * 0.85 + 0.15);
            ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
            ctx.restore();
        }

        ctx.globalAlpha = 1;

        if (alive === 0) {
            stopped = true;
            ctx.clearRect(0, 0, cssW, cssH);
            return;
        }
        raf = requestAnimationFrame(frame);
    };

    raf = requestAnimationFrame(frame);

    return () => {
        stopped = true;
        cancelAnimationFrame(raf);
        ctx.clearRect(0, 0, cssW, cssH);
    };
}
