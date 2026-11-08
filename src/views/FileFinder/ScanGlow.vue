<template>
    <div class="scan-glow" :style="tintStyle" role="status" aria-live="polite">
        <!-- ⚠️ 顺序就是层次：遮罩只负责把背后的内容压暗，**光必须在它之上**。 -->
        <div class="scan-glow__veil" aria-hidden="true" />
        <canvas ref="canvasEl" class="scan-glow__lights" aria-hidden="true" />

        <div class="scan-glow__panel">
            <div class="scan-glow__title">{{ title }}</div>
            <div class="scan-glow__status">
                <Transition name="scan-glow-announce">
                    <span :key="line">{{ line }}</span>
                </Transition>
            </div>
            <div v-if="running && pending" class="scan-glow__count">
                已扫 <b>{{ done ?? 0 }}</b> / 待扫 <b>{{ pending }}</b>
            </div>
            <!-- 判定完成后按钮退场：位子**留着**（wrapper 定高），只淡出按钮本身 -->
            <div class="scan-glow__actions">
                <Transition name="scan-glow-action">
                    <button
                        v-if="running"
                        type="button"
                        class="scan-glow__stop"
                        :disabled="cancelling"
                        @click="emit('cancel')"
                    >
                        {{ cancelling ? '正在取消…' : '终止' }}
                    </button>
                </Transition>
            </div>
        </div>
    </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

/**
 * 扫描/补全的「光雾确认」—— 移植自 LeiBox `transfer-glow`。
 *
 * 原式的骨架（照抄）：内容**先失焦**（blur + 遮罩）→ 光雾与上浮粒子扫过 →
 * **两段处理文案** → 光散去、内容恢复清晰。
 * 移植改了三处：
 *   ① 颜色走 tokens 的 `--ff-glow-1/2/3`（绿/蓝/紫），组件里不出现色值字面量；
 *   ② 面积只覆盖**网格可视区**（image-box），不是整个窗口；
 *   ③ **时长不写死**：真实扫描可能 1 秒也可能 30 秒 —— 光一直在动、文案按时间递进，
 *      收尾由 `running` 变 false 触发（原式是一段固定的 5.2s）。
 */
const props = defineProps<{
    kind: 'fill' | 'rescan';
    /** 任务还在不在跑。false ⇒ 播完退场就把自己关掉 */
    running: boolean;
    /** 已点终止、正在等目录边界：按钮变「正在取消…」并置灰 */
    cancelling?: boolean;
    /** 已扫目录数 */
    done?: number;
    /** 还没扫的目录数 */
    pending?: number;
}>();

const emit = defineEmits<{ cancel: []; closed: [] }>();

const canvasEl = ref<HTMLCanvasElement | null>(null);
/** 进/退场包络 0~1（每帧算，写进 CSS 变量） */
const fadeIn = ref(0);
const fadeOut = ref(0);
/** 已跑秒数，决定文案走到第二段 */
const elapsed = ref(0);

let raf = 0;
let observer: ResizeObserver | null = null;
let mountedAt = 0;
/** 收尾阶段从哪一刻开始 / 从哪个进度起扫 / 从哪一刻起淡出 */
let finishAt = 0;
let finishFrom = 0;
let exitAt = 0;
let done = false;

const title = computed(() => (props.kind === 'fill' ? '补全这一片' : '重读这一片'));

const line = computed(() => {
    if (props.cancelling) return '正在取消，等当前目录扫完…';
    // 任务一结束就报"完成"：接下来那一下"光扫到顶消失"就是完成的正反馈，
    // 若此时还挂着"正在核对…"，光在庆祝、字还在干活，两句话打架。
    if (!props.running) return '完成';
    if (elapsed.value < 2.6) return props.kind === 'fill' ? '正在补齐缓存…' : '正在重读这一片…';
    return props.kind === 'fill' ? '正在核对目录…' : '正在比对缓存…';
});

/**
 * 遮罩与光的强度**每帧算**，不交给 CSS transition：
 * 挂载那一帧就写 CSS 变量 ⇒ 浏览器看到的"已经是 1"，过渡根本不会播。
 */
/**
 * 遮罩**只做透明度渐变**，跟着进场包络走（与光同一段）。
 *
 * ⚠️ 两次弯路都别再回去：
 *   ① `transform: translateY()` 让它"从底部推上来" —— 大面积图层 + 祖先 `filter: blur()`，
 *      合成一乱就变成"整片刷下来"；
 *   ② 跟着光的位置走 —— 光 440ms 才动，遮罩跟着它等于前 440ms 什么都不动。
 * 真正让它"看着像从上往下"的根因是**扫描状态条把网格挤矮了**（index.vue 里有那条注释）：
 * 那是布局问题，不该由遮罩的几何去补。
 */
const tintStyle = computed(() => {
    const envelope = fadeIn.value * (1 - fadeOut.value);
    return {
        // 遮罩只做透明度：与光共用进场包络，退场跟着 fadeOut 一起收
        '--glow-veil': (fadeIn.value * (1 - fadeOut.value) * 0.62).toFixed(3),
        '--glow-lights': (envelope * (0.35 + 0.65 * fadeIn.value)).toFixed(3),
    };
});

// ── 光雾与粒子（Canvas2D） ──────────────────────────────────
const clamp = (n: number, a = 0, b = 1) => Math.max(a, Math.min(b, n));
const smooth = (a: number, b: number, v: number) => {
    const x = clamp((v - a) / (b - a));
    return x * x * (3 - 2 * x);
};

/**
 * 光的三色。**从 tokens.css 读**，不在这里写色值：
 * 项目护栏禁止 .vue 里出现色值字面量，而"光是什么颜色"本来就该和主题一起管
 * （深色要更亮更饱和，浅色要压深一档）。取不到就退回纯白，至少不会黑屏。
 */
let PALETTE = ['white', 'white', 'white'];
const readPalette = () => {
    const cs = getComputedStyle(document.documentElement);
    const read = (name: string) => cs.getPropertyValue(name).trim() || 'white';
    PALETTE = [read('--ff-glow-1'), read('--ff-glow-2'), read('--ff-glow-3')];
};

/** 确定性伪随机：同一帧多次重绘不能抖（原式用 sin 哈希，照抄） */
const hash = (n: number) => {
    const q = Math.sin(n * 127.1 + 311.7) * 43758.5453;
    return q - Math.floor(q);
};

const MOTES = Array.from({ length: 140 }, (_, i) => ({
    x: hash(i + 2),
    phase: hash(i + 20),
    speed: 0.16 + hash(i + 600) * 0.13,
    size: 0.25 + Math.pow(hash(i + 100), 3) * 1.5,
    light: 0.35 + hash(i + 80) * 0.6,
    twinkle: 2 + hash(i + 700) * 4,
}));

/**
 * 光带中心的纵向位置（单位 = 容器高）。
 * `1.19` = 在容器下方（看不见）；`0.99` = 光抬到位、贴着底边；负值 = 已扫出顶部。
 * **这是唯一的真相源**：遮罩的上沿也读它，两者才不会各走各的。
 */
function baseAt(p: number): number {
    const rise = smooth(0.085, 0.2, p);
    const sweep = smooth(0.79, 0.92, p);
    return 1.19 - 0.2 * rise - 1.29 * sweep;
}

function draw(canvas: HTMLCanvasElement, p: number, t: number): void {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    // ⚠️ 用 CSS px 而不是 canvas.width：context 已经 setTransform(dpr) 缩放过，
    // 再拿设备像素算半径就会多乘一个 dpr（高分屏上光斑大一圈）。
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return;

    ctx.clearRect(0, 0, w, h);

    /**
     * ⚠️ 两个参数不能合并成一个：
     *   `p`（进度）= 光带的**纵向位置**，由 `baseAt` 决定；任务结束要补播"扫走"时会跳。
     *   `t`（秒）  = 横向摆动/呼吸/粒子的**时钟**，永远匀速走真实时间。
     * 曾经写成 `const t = p * 5.2`，于是补播"扫走"必须把 `p` 从当前位置跳到 0.76 ——
     * `p` 一动，摆动、呼吸、粒子相位全跟着跳，肉眼是"闪一下"而不是"扫上去"，
     * 等于**扫走效果被吃掉**（主人 2026-11-08 报的"扫至顶部消失没了"）。
     * 拆开后 `p` 可以任意跳：0.2~0.76 这段 `baseAt` 恒为 0.99（光停在底部不动），跳过去看不出来。
     */
    const base = baseAt(p);
    const breath = 1 + 0.2 * Math.sin(t * 2.2 - 0.6);

    /**
     * 一道光斑。颜色走 `color` + `globalAlpha`，**不拼 rgba 字符串** ——
     * 一是本项目禁止在 .vue 里出现色值字面量，二是 globalAlpha 在 save/restore 里天然回滚。
     */
    const wash = (x: number, y: number, rx: number, ry: number, color: string, alpha: number) => {
        ctx.save();
        ctx.translate(x * w, y * h);
        ctx.scale(rx * w, ry * h * breath);
        ctx.globalAlpha = alpha;
        const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1.6);
        g.addColorStop(0, color);
        g.addColorStop(0.45, color);
        g.addColorStop(1, 'transparent');
        ctx.fillStyle = g;
        ctx.fillRect(-1.6, -1.6, 3.2, 3.2);
        ctx.restore();
    };

    // 六道宽窄不一的光带：主光走绿，两侧蓝/紫，末尾一道窄高光（原式是粉/金六色，结构照抄）
    const [g1, g2, g3] = PALETTE;
    wash(0.42 + 0.04 * Math.sin(t * 0.8), base + 0.025, 0.72, 0.16, g1, 0.34);
    wash(0.34 + 0.06 * Math.sin(t * 1.1), base - 0.035, 0.39, 0.21, g2, 0.26);
    wash(0.13 + 0.035 * Math.cos(t * 1.5), base + 0.07, 0.29, 0.14, g3, 0.3);
    wash(0.84 + 0.035 * Math.sin(t * 1.1), base - 0.1, 0.38, 0.23, g3, 0.22);
    wash(0.88 + 0.035 * Math.sin(t * 1.2), base + 0.025, 0.2, 0.075, g2, 0.34);
    wash(0.51 + 0.055 * Math.sin(t * 0.95), base + 0.09, 0.35, 0.16, g1, 0.3);

    // 小团气流：让大片光带不至于像"一排会动的圆"
    for (let i = 0; i < 12; i++) {
        const life = (t * (0.17 + hash(i + 70) * 0.1) + hash(i + 30)) % 1;
        const x = hash(i + 12) + Math.sin(life * 4 + i) * 0.07;
        const y = base + 0.16 - life * 0.36;
        wash(
            x, y,
            0.1 + hash(i + 22) * 0.11,
            0.065 + hash(i + 52) * 0.07,
            PALETTE[i % 3],
            Math.sin(life * Math.PI) * 0.16,
        );
    }

    // 上浮粒子：白色碎光，压在彩色光带上面才不会糊成一片。
    // dust = 原式的"粒子窗口"：跟着光一起起来、一起扫走（少这一项，粒子会一直挂在屏幕上）
    const dust = smooth(0.12, 0.3, p) * (1 - smooth(0.9, 0.96, p));
    for (const m of MOTES) {
        const life = (t * m.speed + m.phase) % 1;
        const x = (m.x + Math.sin(t * 0.9 + m.phase * 40) * 0.012) * w;
        const y = (base + 0.22 - life * 0.34) * h;
        const alpha = Math.sin(life * Math.PI) * m.light * (0.72 + 0.28 * Math.sin(t * m.twinkle)) * dust;
        if (alpha <= 0.004) continue;
        ctx.globalAlpha = alpha;
        ctx.beginPath();
        ctx.arc(x, y, (m.size * Math.min(w, h)) / 530, 0, Math.PI * 2);
        ctx.fill();
    }
    ctx.globalAlpha = 1;
}

function resize(): void {
    const canvas = canvasEl.value;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(canvas.clientWidth * dpr);
    canvas.height = Math.round(canvas.clientHeight * dpr);
    const ctx = canvas.getContext('2d');
    ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (ctx) ctx.fillStyle = 'white';
}

// ── 时间轴 ─────────────────────────────────────────────────
const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const ENTER_MS = 260;
const EXIT_MS = 320;
/** 参考件一轮「抬起 → 扫走」的时长；循环它就得到持续的"一波一波" */
const CYCLE_MS = 5200;
/**
 * 最短显示时长（主人 2026-11-08：至少要看到 2s）。
 * 缓存命中的目录可能几十毫秒就扫完 —— 若按真实时长收，动效只会闪一下。
 */
const MIN_MS = 2000;
/**
 * 光的「抬到位」时刻：`baseAt` 里 rise 段是 smooth(0.085, 0.2)，过 0.2 之后就停住不动了。
 * 收尾要用它判断"光是不是还在从下面往上冒"。
 */
const RISE_END = 0.2;
/**
 * 「扫走」的进度区间。⚠️ 任务结束后**必须把这一段播完**再淡出：
 * 那一下"光扫到顶消失"就是"这件事做完了"的正反馈（主人 2026-11-08 明确要求）。
 * 做法是**把进度重排**而不是跳帧 —— 见 tick 里的三段说明。
 */
const SWEEP_FROM = 0.76;
const SWEEP_TO = 0.96;

function tick(now: number): void {
    if (done) return;
    raf = requestAnimationFrame(tick);

    const ms = now - mountedAt;
    const t = ms / 1000;            // 摆动时钟：只前进，永远不跟着 p 跳
    elapsed.value = t;
    fadeIn.value = smooth(0, ENTER_MS, ms);

    // 自然循环：抬起 → 停在底部 → 扫走 → 下一轮
    let p = (ms % CYCLE_MS) / CYCLE_MS;

    if (!props.running && ms >= MIN_MS) {
        /**
         * 收尾分两种情况，**都不允许跳位**（跳位=光瞬移，观感是"闪一下"，扫走效果就被吃掉）：
         *
         *  ① 光已经抬到位（p ≥ 0.2）：0.2~0.76 这段 `baseAt` 恒为 0.99，光原地不动，
         *     所以可以把进度直接落到 0.76 开始扫 —— 画面上**什么都没有变**。
         *  ② 光还在往上冒（p < 0.2）：这一段是看得见的，必须让它自己播完；
         *     本帧先不启动收尾，等循环把 p 推过 0.2，下一帧再走 ① 的分支。
         */
        if (!finishAt) {
            if (p >= RISE_END) {
                finishAt = now;
                finishFrom = Math.max(p, SWEEP_FROM);
                p = finishFrom;
            }
        } else {
            // 从起点**按原速**扫上去（0.76→0.96 ≈ 1040ms），扫到顶才开始淡出
            p = Math.min(SWEEP_TO, finishFrom + (now - finishAt) / CYCLE_MS);
            if (p >= SWEEP_TO) {
                if (!exitAt) exitAt = now;
                fadeOut.value = smooth(0, EXIT_MS, now - exitAt);
                if (fadeOut.value >= 1) {
                    finish();
                    return;
                }
            }
        }
    }

    const canvas = canvasEl.value;
    if (canvas && fadeOut.value < 0.98) draw(canvas, p, t);
}

function finish(): void {
    if (done) return;
    done = true;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    emit('closed');
}

onMounted(() => {
    mountedAt = performance.now();   // 减动效分支也要用它算 2s 的最短时长
    readPalette();
    resize();
    /**
     * ⚠️ 必须自己盯容器尺寸：canvas 是 `width:100%;height:100%`，
     * 容器一变高矮，位图就被 CSS **压扁**（光带跟着变形），而不是重新布局。
     * 这也是"动效被布局带动"的一半原因。
     */
    observer = new ResizeObserver(() => resize());
    if (canvasEl.value) observer.observe(canvasEl.value);
    window.addEventListener('resize', resize);
    if (reduced()) {
        // 减动效：不跑循环，进场直接满；退场由 running 翻转驱动（不靠 rAF ⇒ 必须自己收尾）
        fadeIn.value = 1;
        if (canvasEl.value) draw(canvasEl.value, 0.4, 0);
        watch(
            () => props.running,
            (on) => {
                if (on) return;
                // 同样保住 2 秒：减动效不等于可以闪一下就没
                const wait = Math.max(0, mountedAt + MIN_MS - performance.now()) + EXIT_MS;
                setTimeout(() => {
                    fadeOut.value = 1;
                    finish();
                }, wait);
            },
        );
        return;
    }
    raf = requestAnimationFrame(tick);
});

onBeforeUnmount(() => {
    done = true;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    observer?.disconnect();
    window.removeEventListener('resize', resize);
});
</script>

<style scoped>
/* ⚠️ 不带 border-radius：这一层盖的是**直角**的网格区，
   给它圆角会在右下角露出一块"被啃掉"的边（2026-11-08 主人指出）。 */
.scan-glow {
    position: absolute;
    inset: 0;
    z-index: 3;
    display: grid;
    place-items: center;
    overflow: hidden;
    pointer-events: none;
}

.scan-glow__lights {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    opacity: var(--glow-lights, 0);
}

/**
 * 遮罩：**只有透明度**，没有 transform、没有 will-change、没有过渡属性。
 * 参考件那块也是一块 `inset:0` 的平雾（无方向），我们对齐它。
 * 任何几何变换都不要再加回来 —— 这一层铺满容器，又被上层的 blur 裹着，
 * 一旦有了 transform/分层，观感就会变成"整片刷下来"。
 */
.scan-glow__veil {
    position: absolute;
    inset: 0;
    background: var(--ff-canvas);
    opacity: var(--glow-veil, 0);
    transition: none;
}

.scan-glow__panel {
    position: relative;
    z-index: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
    pointer-events: auto;
}

.scan-glow__title {
    font-size: var(--ff-fs-title);
    font-weight: 500;
    letter-spacing: 0.02em;
    color: var(--ff-text-1);
}

.scan-glow__status {
    position: relative;
    display: grid;
    align-items: center;
    height: 20px;
    font-size: var(--ff-fs-meta);
    color: var(--ff-text-2);
}

.scan-glow__status > span {
    grid-area: 1 / 1;
    text-align: center;
}

.scan-glow__count {
    font-size: var(--ff-fs-eyebrow);
    color: var(--ff-text-2);
    font-variant-numeric: tabular-nums;
}

.scan-glow__count b {
    font-weight: 500;
    color: var(--ff-text-1);
}

/**
 * 按钮位**定高占位**，任务判定完成后按钮淡出但位子不塌。
 * 直接 `v-if` 掉会让面板矮 40px —— 面板是 `place-items:center` 居中的，
 * 结果是「完成」那一瞬间标题和文案整体下跳 20px，比按钮不消失更刺眼。
 * （和 20:05 那条"布局在动被误读成动效在动"是同一类坑。）
 */
.scan-glow__actions {
    display: grid;
    place-items: center;
    height: calc(var(--ff-h-ctl) + 6px);
}

.scan-glow__stop {
    height: var(--ff-h-ctl);
    padding: 0 14px;
    border: 1px solid var(--ff-line-strong);
    border-radius: var(--ff-r-ctl);
    background: var(--ff-raised);
    color: var(--ff-text-1);
    font-size: var(--ff-fs-meta);
    font-weight: 500;
    cursor: pointer;
    transition: background-color var(--ff-dur-hover) ease, opacity var(--ff-dur-hover) ease;
}

.scan-glow__stop:hover {
    background: var(--ff-raised-hover);
}

.scan-glow__stop:disabled {
    opacity: 0.5;
    pointer-events: none;
}

.scan-glow__stop:focus-visible {
    outline: 2px solid var(--ff-highlight);
    outline-offset: 2px;
}

/* 按钮退场：**只淡出、不位移**（位子由 `.scan-glow__actions` 定高占着，不会带动面板重排） */
.scan-glow-action-leave-active {
    transition: opacity var(--ff-dur-exit) linear;
}

.scan-glow-action-leave-to {
    opacity: 0;
}

/* 文案换行用"旧字上移淡出 / 新字下移淡入"（同节点，位置不动） */
.scan-glow-announce-enter-from {
    opacity: 0;
    transform: translateY(6px);
}

.scan-glow-announce-enter-active {
    transition:
        opacity var(--ff-fade-in) var(--ff-fade-in-delay),
        transform var(--ff-dur-move) var(--ff-ease-move);
}

.scan-glow-announce-leave-to {
    opacity: 0;
    transform: translateY(-6px);
}

.scan-glow-announce-leave-active {
    transition:
        opacity var(--ff-dur-exit) linear,
        transform var(--ff-dur-exit) var(--ff-ease-exit);
}
</style>
