/**
 * 「花的一生」：花集合、帧循环、种与收的决策。
 *
 * 这里**不碰事件、不碰设置开关、不认识 canvas 以外的 DOM** —— 谁在什么时候调它由宿主决定。
 * 宿主（`index.vue`）只负责：拿到画布、挂监听、把事件翻译成下面这几个方法。
 *
 * 拆开的原因是它俩的变化原因完全不同：宿主随"接进哪个应用"变，这里随"花怎么长"变。
 */
import { releaseRange, scanSelection, spotOf } from './geometry';
import { DENSITY, MAX_FLOWERS, plantFor, readPalette, scaleFor, type Flower, type Palette } from './shape';
import { drawFlower } from './draw';

export interface Bloom {
    /** 接管一块画布（尺寸由它会话期间的 window 决定） */
    start(canvas: HTMLCanvasElement): void;
    /** 彻底收工：帧、定时器、花、色板、画布引用、Range 引用**全部**放开 */
    stop(): void;
    resize(): void;
    /** 一次选择动作开始了（pointerdown / 键盘扩选）。只有 active 期间才种新花 */
    setActive(on: boolean): void;
    /** 系统减动效：置 true 会清空并停止绘制 */
    setReduced(on: boolean): void;
    /** 窗口不可见：停帧但不清花 */
    setPaused(on: boolean): void;
    /** 选区可能变了（内部按 rAF 节流） */
    sync(): void;
    /** 松手 / 失焦：花缩回去，这一次选择结束 */
    release(): void;
}

export function createBloom(): Bloom {
    let canvas: HTMLCanvasElement | null = null;
    let ctx: CanvasRenderingContext2D | null = null;
    let palette: Palette | null = null;
    let reduced = false;

    let raf = 0;
    let last = 0;
    let syncFrame = 0;
    let emptyTimer = 0;
    let width = 0;
    let height = 0;

    let active = false;
    let hadSelection = false;
    let seed = 1;

    const flowers = new Map<string, Flower>();
    /**
     * 本次选择里已经**确定不种**的字符（没抽中 / 取不到矩形 / 太小）。
     * 种成功的不记 —— 靠 `flowers` 自身判断，这样选区缩了再扩回来它还能重新长出来。
     */
    const handled = new Set<string>();
    /** 本帧选区里的全部字符（**全量**，与采样无关）—— 回收只看它 */
    const aliveKeys = new Set<string>();

    function resize() {
        if (!canvas || !ctx) return;
        width = window.innerWidth;
        height = window.innerHeight;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        canvas.width = Math.max(1, Math.round(width * dpr));
        canvas.height = Math.max(1, Math.round(height * dpr));
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, width, height);
    }

    function paint(now: number) {
        if (!ctx || !palette || !canvas) return;
        ctx.clearRect(0, 0, width, height);
        for (const flower of flowers.values()) drawFlower(ctx, flower, now, flower.target, palette);
        // 没花就把整层藏起来：一个不画东西的全屏画布也在占合成层
        canvas.style.visibility = flowers.size ? 'visible' : 'hidden';
    }

    function request() {
        if (raf || !flowers.size || !ctx || document.hidden) return;
        raf = requestAnimationFrame(tick);
    }

    function tick(now: number) {
        raf = 0;
        const dt = last ? Math.min((now - last) / 1000, 0.04) : 1 / 60;
        last = now;
        for (const [key, flower] of flowers) {
            flower.progress = Math.max(0, Math.min(1, flower.progress + (flower.target ? 3.3 : -2.7) * dt));
            if (!flower.target && flower.progress <= 0) flowers.delete(key);
        }
        paint(now);
        if (flowers.size && !document.hidden) raf = requestAnimationFrame(tick);
        else last = 0;
    }

    /** 让已有的花缩回去（不改 active：pointerdown 清旧选区时也会走到这里） */
    function retract() {
        if (reduced) {
            flowers.clear();
            paint(performance.now());
            return;
        }
        for (const flower of flowers.values()) flower.target = false;
        request();
    }

    function sync() {
        const hits = scanSelection();
        if (!hits) {
            if (emptyTimer) return;
            // ⚠️ 拖选跨行 / 跨元素时中间会有一两帧选区为空（浏览器正在换文本节点）。
            //    立刻收回 = 花一排排缩回去再长回来，看着就是"一直在刷新"。晚 100ms 再确认。
            emptyTimer = window.setTimeout(() => {
                emptyTimer = 0;
                if (scanSelection()) return;
                hadSelection = false;
                retract();
            }, 100);
            return;
        }
        if (emptyTimer) {
            window.clearTimeout(emptyTimer);
            emptyTimer = 0;
        }
        if (!active) return;

        if (!hadSelection) {
            // 无 → 有：换一批种子。handled 清空，但**已经长出来的花不动**（key 稳定，下面会续上）
            hadSelection = true;
            seed = (Math.random() * 4294967295) >>> 0;
            palette = readPalette();
            handled.clear();
        }
        if (!palette) palette = readPalette();

        /* 采样率按选区大小反推：小选区正常按 DENSITY 开，大选区自动拉稀到 MAX_FLOWERS 以内。
           ⚠️ 这一条是为了「选 10 行不能只有前 4 行有花」：名额按 DOM 顺序先到先得的话，
              前排塞满就把后面整行饿死了。改成等间隔采样 ⇒ 花均匀撒满整段选区。
           ⚠️ 采样只决定"要不要考虑种新花"，**回收只看 aliveKeys（全量字符）**，
              所以 stride 抖动不会让已经长出来的花重生。 */
        const stride = Math.max(1, Math.ceil((hits.length * DENSITY) / MAX_FLOWERS));

        aliveKeys.clear();
        for (let i = 0; i < hits.length; i++) {
            const hit = hits[i];
            aliveKeys.add(hit.key);
            if (i % stride) continue;

            // ⚠️ 续航判断必须排在 handled 之前：松手会把所有花 target 置 false，
            //    重新进入选区时得先把它们叫醒，而不是被"处理过"这条挡在门外。
            const existing = flowers.get(hit.key);
            if (existing) {
                existing.target = true;
                continue;
            }
            if (handled.has(hit.key)) continue;

            const spot = spotOf(hit);
            if (!spot) {
                handled.add(hit.key);
                continue;
            }
            const flower = plantFor(hit.key, spot, seed, palette, scaleFor(spot.h));
            if (!flower) {
                handled.add(hit.key);
                continue;
            }
            if (reduced) flower.progress = 1;
            flowers.set(hit.key, flower);
        }
        for (const [key, flower] of flowers) if (!aliveKeys.has(key)) flower.target = false;

        paint(performance.now());
        request();
    }

    /** 选区变化的节流入口：一帧最多算一次 */
    function scheduleSync() {
        if (syncFrame) return;
        syncFrame = requestAnimationFrame(() => {
            syncFrame = 0;
            sync();
        });
    }

    return {
        start(el) {
            canvas = el;
            ctx = el.getContext('2d');
            palette = readPalette();
            resize();
        },
        stop() {
            if (raf) cancelAnimationFrame(raf);
            if (syncFrame) cancelAnimationFrame(syncFrame);
            if (emptyTimer) window.clearTimeout(emptyTimer);
            raf = 0;
            syncFrame = 0;
            emptyTimer = 0;
            last = 0;
            active = false;
            hadSelection = false;
            flowers.clear();
            handled.clear();
            aliveKeys.clear();
            palette = null;
            if (ctx) ctx.clearRect(0, 0, width, height);
            // ⚠️ 这两行是"关掉之后真的不剩东西"的关键：模块级 Range 会吊着最后一个文本节点
            releaseRange();
            canvas = null;
            ctx = null;
        },
        resize,
        setActive(on) {
            active = on;
        },
        setReduced(on) {
            reduced = on;
            if (!on) return;
            flowers.clear();
            if (ctx) ctx.clearRect(0, 0, width, height);
        },
        setPaused(on) {
            if (on) {
                if (raf) cancelAnimationFrame(raf);
                raf = 0;
                last = 0;
                return;
            }
            request();
        },
        sync: scheduleSync,
        release() {
            active = false;
            retract();
        },
    };
}
