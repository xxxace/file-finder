<template>
    <div class="pack-stage">
        <div ref="groundEl" class="ground" aria-hidden="true" />

        <!-- 彩虹光流：35 条 ribbon 从撕口喷出（坐标系 0~100 = 包宽） -->
        <svg ref="flowEl" class="flow" viewBox="0 0 100 76" aria-hidden="true" />

        <div ref="packEl" class="pack" :class="`is-${phase}`" :style="{ '--pack': packColor }">
            <!-- 正面：撕口提示 + 金属边 + 品牌字 + 居中图形 + 底注 -->
            <div ref="frontEl" class="skin skin--front" aria-hidden="true">
                <span class="tear-hint">Tear here ⟶</span>
                <span class="lips"><i ref="lipEl" class="lip" /></span>
                <b class="mark">File Finder</b>
                <span class="series">{{ skinLabel }}</span>
                <div class="orb"><span class="disc" /></div>
                <span class="foot foot--l">随机一包</span>
                <span class="foot foot--r">5 cards</span>
            </div>

            <!-- 背面：折边 + 小字说明 + 条码 -->
            <div class="skin skin--back" aria-hidden="true">
                <i class="fin" />
                <b class="mark mark--sm">File Finder</b>
                <p class="blurb">5 张已缓存封面<br>每次都不一样</p>
                <i class="code" />
            </div>

            <!-- 撕条：切 12 片，逐片累积弯曲（越靠末端卷得越紧） -->
            <div ref="flapEl" class="flap" aria-hidden="true">
                <div v-for="k in PLIES" :key="k" :ref="el => setPly(k - 1, el)" class="ply">
                    <div class="skin skin--front ply-skin">
                        <i class="lip ply-lip" />
                        <i class="tone" />
                    </div>
                    <div class="skin skin--foil">
                        <i class="tone" />
                    </div>
                </div>
            </div>

            <button
                ref="hitEl"
                class="hit"
                type="button"
                aria-label="撕开这包：横向拖动撕开，或按一下直接撕"
                @pointerdown.stop="onDown"
                @pointermove.stop="onMove"
                @pointerup.stop="onUp"
                @pointercancel.stop="onUp"
                @click.stop
            />
        </div>
    </div>
</template>

<script setup lang="ts">
/**
 * 卡包 —— 竖直长条铝箔袋，移植自 `holo-reverse` 的 `.pack`。
 *
 * ## 为什么放弃 CD 盒
 *
 * 业主裁定："换成源代码的卡包"。原话之外的理由也成立：铝箔袋的**锯齿封边 + 热压纹 +
 * 褶皱高光**三种细节一起才撑得起"软包装"，方盒只能靠塑料壳的高光硬撑，观感差一档。
 *
 * ## 逐帧算的东西（一件都不能交给 CSS transition）
 *
 * 1. 包的姿态（6 个弹簧）：呼吸 / 跟手 / 被抓住时蜷缩 / 开包后被踢下去；
 * 2. 撕口：96 段路径 → 正面与背面两片 skin 的 `clip-path` + 撕口那条金属亮边；
 * 3. 撕条：12 片各自的 `clip-path` 与**累积** 3D 变换（越末端越卷）；
 * 4. 光流：交给 `RainbowFlow`。
 *
 * `phase` 仍由页面推；本组件只在"撕到 1"时 `emit('opened')`。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { FEEL, Spring, pose, stepAll, values } from '@/views/Lucky/spring';
import { useStage } from '@/views/Lucky/useStage';
import {
    PLIES, bandOf, mirror, plyEdge, plyOutline, restOutline, toPolygon, yAt,
} from '@/views/Lucky/tearPath';
import type { JagPoint, Pt } from '@/views/Lucky/tearPath';
import { createJag, steer } from '@/views/Lucky/tearPath';
import { RainbowFlow } from '@/views/Lucky/flow';
import { paintLight, PACK_SKINS } from '@/views/Lucky/packSkin';

const props = defineProps<{
    phase: 'sealed' | 'opening' | 'open';
    /** 皮肤 key（`cobalt` / `ember` / …），由页面每包换一个且不与上一包重复 */
    skin: string;
}>();

const emit = defineEmits<{ opened: [] }>();

const packEl = ref<HTMLElement | null>(null);
const groundEl = ref<HTMLElement | null>(null);
const frontEl = ref<HTMLElement | null>(null);
const flapEl = ref<HTMLElement | null>(null);
const lipEl = ref<HTMLElement | null>(null);
const flowEl = ref<SVGSVGElement | null>(null);
const hitEl = ref<HTMLElement | null>(null);
const plyEls: HTMLElement[] = [];

const packColor = computed(() => `var(--ff-pack-${props.skin})`);
const skinLabel = computed(() => PACK_SKINS.find(s => s.key === props.skin)?.label ?? '');

/** 姿态：位置 3 + 旋转 3 */
const P = pose({ x: 0, y: 0, rx: 0, ry: 0, rz: 0 }, ...FEEL.pointer);
/** 撕裂进度 */
const tearP = new Spring(0, 0.1);
/** 撕条整体的两个转角（Z 摆动 / X 翻起） */
const tearTh = new Spring(0, 0.28, 0.35);
const tearPh = new Spring(0, 0.3, 0.2);
/** 被捏住的紧绷感（抓住时 1，撕开后 0） */
const squeeze = new Spring(0, 0.3, 0.45);

const jag: JagPoint[] = createJag();
let tearDir: 1 | -1 = 1;
let flow: RainbowFlow | null = null;

let fall: { y: number; v: number } | null = null;
let fallAt = -1;
let lastPhase = props.phase;
let openedFired = false;
/** 下一次"自己抖一下"的时刻（秒，`t` 坐标系） */
let nudgeAt = 5;
/** 上一帧的撕裂进度，用来算"这一帧撕了多少" */
let tearLast = 0;
let openedAt = 0;
let pw = 280;
let ph = 405;

const pointer = { nx: 0, ny: 0, in: false };
interface DragState { id: number; x0: number; y0: number; p0: number; moved: boolean; dy: number }
let drag: DragState | null = null;

function clamp(v: number, a: number, b: number): number {
    return Math.min(b, Math.max(a, v));
}

function setPly(index: number, el: unknown): void {
    if (el instanceof HTMLElement) plyEls[index] = el;
}

/**
 * 把当前撕口应用到 DOM —— 整段移植自参考站的 `clips()`。
 *
 * 这一步是"撕"的全部：两片 skin 的轮廓、金属亮边的轮廓、撕条整体的铰点、
 * 以及 12 片撕条的裁切与累积弯曲。**没有任何动画曲线**，全是当前状态的几何。
 */
function applyClips(p: number): void {
    const d = tearDir;
    const xt = d > 0 ? p * 100 : 100 - p * 100;
    const yt = yAt(jag, xt);

    // 正面 / 背面：剩下那块 + 已撕掉的上半部分
    const rest = restOutline(jag, p, d);
    if (frontEl.value) frontEl.value.style.clipPath = toPolygon(rest);
    const back = packEl.value?.querySelector('.skin--back') as HTMLElement | null;
    if (back) back.style.clipPath = toPolygon(mirror(rest));

    // 撕口那条金属亮边：沿撕口的一条细带，宽度逐点不同
    const torn = jag.filter(q => (d > 0 ? q.x < xt : q.x > xt));
    const edge: Pt[] = d > 0
        ? [...torn.map(q => [q.x, q.y] as Pt), [xt, yt]]
        : [[xt, yt], ...torn.map(q => [q.x, q.y] as Pt)];
    if (lipEl.value) lipEl.value.style.clipPath = toPolygon(bandOf(edge, 1, torn.map(q => q.metal).concat(1)));

    // 撕条的铰点在撕口尖端
    if (flapEl.value) flapEl.value.style.transformOrigin = `${xt}% ${yt}%`;

    // 12 片撕条：每片的裁切 + 累积变换
    const w = 100 / PLIES;
    const lap = 0.25;
    const k0 = clamp(Math.floor((d > 0 ? xt - 1e-6 : xt) / w), 0, PLIES - 1);
    const bend = (2.6 + 2.6 * p) * 1.05;
    const jitter = Math.min(1, Math.abs(tearP.v) * 0.4) * 1.6;

    for (let k = 0; k < PLIES; k += 1) {
        const el = plyEls[k];
        if (!el) continue;
        const lo = d > 0 ? k * w : Math.max(k * w, xt);
        const hi = d > 0 ? Math.min((k + 1) * w, xt) : (k + 1) * w;

        if (hi <= lo) {
            el.hidden = true;
            continue;
        }
        el.hidden = false;

        const L = Math.max(0, lo - lap);
        const R = Math.min(100, hi + lap);
        const face = el.querySelector('.ply-skin') as HTMLElement | null;
        const foil = el.querySelector('.skin--foil') as HTMLElement | null;
        const lip = el.querySelector('.ply-lip') as HTMLElement | null;
        const outline = plyOutline(jag, L, R);
        if (face) face.style.clipPath = toPolygon(outline);
        if (foil) foil.style.clipPath = toPolygon(mirror(outline));
        if (lip) lip.style.clipPath = toPolygon(bandOf(plyEdge(jag, L, R), -1, jag.filter(q => q.x > L && q.x < R).map(q => q.metal).concat(1)));
    }

    let acc = '';
    let sum = 0;
    for (let n = 0, k = k0; k >= 0 && k < PLIES; n += 1, k -= d) {
        const x = ((n ? (d > 0 ? k + 1 : k) * w : xt) / 100) * pw;
        const a = d * (bend * (0.4 + 0.3 * n) + Math.sin(taf * 16 + n * 0.9) * jitter);
        const el = plyEls[k];
        sum += a;
        acc += `translateX(${x.toFixed(2)}px) rotateY(${a.toFixed(2)}deg) rotateZ(${(d * 0.9 * n / 4).toFixed(2)}deg) translateX(-${x.toFixed(2)}px) `;
        if (el) {
            el.style.transform = acc;
            const toneFront = el.querySelector('.ply-skin .tone') as HTMLElement | null;
            const toneFoil = el.querySelector('.skin--foil .tone') as HTMLElement | null;
            if (toneFront) toneFront.style.opacity = Math.min(0.5, Math.abs(sum) / 200).toFixed(2);
            if (toneFoil) toneFoil.style.opacity = Math.max(0, 0.34 - Math.abs(sum) / 420).toFixed(2);
        }
    }
}

/** 当前时间（给撕条抖动用；`applyClips` 里要读它） */
let taf = 0;

const stage = useStage((dt, t) => {
    const el = packEl.value;
    if (!el) return;
    taf = t;

    // ── 撕裂 ────────────────────────────────────────────────
    stepAll([tearP, tearTh, tearPh, squeeze], dt);
    const p = clamp(tearP.x, 0, 1);
    if (p >= 0.995 && !openedFired) {
        openedFired = true;
        openedAt = t;
        emit('opened');
    }
    if (p > 0) applyClips(p);

    /**
     * 撕动一下 → 整包抖一下、光带往前涌一截、攥紧一点。
     *
     * 这是"撕开"和"彩虹"之间唯一的耦合点（参考站同一处：`dp` 驱动四根弹簧）。
     * 没有它，撕口在动、彩虹在匀速扩散，看起来就是两段不相干的动画。
     */
    const dp = p - tearLast;
    tearLast = p;
    if (dp > 0 && !stage.reduce) {
        const seed = Math.min(dp, 0.02);
        P.rz.v += (Math.random() - 0.5) * seed * 900;
        P.y.v += dp * 420;
        tearTh.v += dp * 300;
        squeeze.v += dp * 20;
        flow?.kick(dp);
    }
    if (flapEl.value) {
        // 松手后撕条在"从撕口吹出的气流"里飘：两个不同频率的正弦叠加
        const draft = drag ? 0 : (Math.sin(t * 5.3) + Math.sin(t * 8.7) * 0.5) * (p > 0 && p < 1 ? 1 : 0);
        flapEl.value.style.transform =
            `rotateZ(${((tearTh.x + draft) * tearDir).toFixed(2)}deg) rotateX(${(tearPh.x + draft * 1.5).toFixed(2)}deg)`;
    }

    // ── 姿态 ────────────────────────────────────────────────
    /**
     * 纵向拉动（还没开始撕时）：包被手拉长，松手弹回去。
     * `170·(1 − 1/(1+|dy|/170))` 是一条饱和曲线 —— 拉得越远越"拉不动"，
     * 与真实的软包装一致（线性会显得像橡皮筋）。
     */
    const tug = drag?.moved && tearP.to === 0
        ? Math.sign(drag.dy) * 170 * (1 - 1 / (1 + Math.abs(drag.dy) / 170))
        : 0;

    // 捏住时蜷缩（弹性衣料被攥住的样子），撕开后松开
    squeeze.to = tug ? -Math.abs(tug) / 90 : (drag?.moved && props.phase === 'sealed' ? 1 : 0);

    const nx = pointer.in ? pointer.nx : 0;
    const ny = pointer.in ? pointer.ny : 0;
    const hold = drag?.moved ? 0.25 : 1;

    P.y.to = Math.sin(t * 1.4) * (props.phase === 'sealed' ? 7 : 2) + tug;
    P.ry.to = nx * 22 * hold;
    P.rx.to = -ny * 16 * hold - squeeze.x * 6;
    P.rz.to = Math.sin(t * 0.9) * 1.6 - (p > 0 && p < 1 ? tearDir * p * 3 : 0);

    /**
     * 没人碰它的时候，过几秒自己抖一下（像放在桌上被风带了一下）。
     * 这是"它是个活物"的最后一笔：一个完全静止的物体在动效里读作"图"。
     */
    if (props.phase === 'sealed' && !drag && tearP.to < 1 && !stage.reduce && t > nudgeAt) {
        P.rz.v += (Math.random() < 0.5 ? -1 : 1) * 70;
        if (tearP.to > 0) tearTh.v += 120;
        nudgeAt = t + 4 + Math.random() * 3;
    }

    stepAll(values(P), dt);

    if (props.phase !== lastPhase) {
        lastPhase = props.phase;
        if (props.phase === 'opening') fallAt = t + 0.24;
    }
    if (!fall && fallAt >= 0 && t >= fallAt) fall = { y: 0, v: (1500 * ph) / 420 };
    if (fall) {
        fall.v += 2600 * dt;
        fall.y += fall.v * dt;
        P.rz.to = tearDir * 9;
    }

    const fy = fall ? fall.y : 0;
    const sq = squeeze.x;
    const xf = `translate3d(${P.x.x.toFixed(2)}px,${(P.y.x + fy).toFixed(2)}px,0) `
        + `rotateX(${P.rx.x.toFixed(2)}deg) rotateY(${P.ry.x.toFixed(2)}deg) `
        + `rotateZ(${P.rz.x.toFixed(2)}deg) scale3d(${(1 + 0.03 * sq).toFixed(3)},${(1 - 0.06 * sq).toFixed(3)},1)`;
    el.style.transform = xf;

    // 光照跟着朝向走：转向哪边，封边下方那道高光就滑向哪边
    el.style.setProperty('--gx', clamp(-P.ry.x * 0.12, -1.5, 3).toFixed(2));
    el.style.setProperty('--gl', clamp(0.8 - P.ry.x * 0.012, 0.45, 1).toFixed(2));
    el.style.setProperty('--gt', clamp(0.85 + P.rx.x * 0.015, 0.5, 1).toFixed(2));
    el.style.setProperty('--gm', clamp(50 + P.ry.x * 1.2, 20, 80).toFixed(1));

    // 光流跟着包走，直到包掉下去
    if (fall && !flowDropped) {
        flowDropped = true;
        flow?.reset();
    }
    if (flowEl.value && !fall) flowEl.value.style.transform = xf;

    flow?.tick({
        t, dt,
        reduce: stage.reduce,
        tearP: p,
        tearDir,
        tearing: p > 0 && p < 1,
        opened: openedFired,
        openedAt,
        anchorRz: P.rz.x,
    });

    // 地面投影
    const ground = groundEl.value;
    if (ground) {
        ground.style.transform = `translate3d(${P.x.x.toFixed(2)}px,${(ph / 2 + 26).toFixed(0)}px,0) scale(${clamp(1 - P.y.x / 300, 0.6, 1.15).toFixed(3)})`;
        ground.style.opacity = fall ? clamp(1 - fall.y / 160, 0, 1).toFixed(3) : clamp(1 - Math.abs(P.x.x) / 300, 0, 1).toFixed(3);
    }
});

let flowDropped = false;

// ── 撕：按下 / 拖动 / 抬手 ────────────────────────────────────
function onDown(ev: PointerEvent) {
    if (props.phase !== 'sealed') return;
    (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
    drag = { id: ev.pointerId, x0: ev.clientX, y0: ev.clientY, p0: tearP.to, moved: false, dy: 0 };
}

function onMove(ev: PointerEvent) {
    if (!drag || ev.pointerId !== drag.id) return;
    const dx = ev.clientX - drag.x0;
    const dy = ev.clientY - drag.y0;
    drag.dy = dy;
    if (!drag.moved) {
        if (Math.hypot(dx, dy) < 6) return;
        drag.moved = true;
        tearP.set(0.1);
    }
    // 真的往侧面拖够远了，才决定从哪头撕
    if (tearP.to === 0) {
        if (Math.abs(dx) < 8 || Math.abs(dx) < Math.abs(dy) * 0.5) return;
        tearDir = dx < 0 ? -1 : 1;
        drag.x0 = ev.clientX;
    }
    tearP.to = clamp(drag.p0 + (drag.p0 ? Math.abs(dx) : dx * tearDir) / (pw * 0.85), tearP.to, 1);
    // 撕条跟着手的上下起伏：往下拉它下潜、往上提它翻起
    tearTh.to = 6 + tearP.to * 14 + clamp(-dy * 0.16, -6, 22);
    tearPh.to = -(8 + tearP.to * 22) - clamp(-dy * 0.2, 0, 24);
    // 未撕的部分整片跟着手弯
    steer(jag, tearP.to, tearDir, clamp(dy / Math.max(60, Math.abs(dx)) * pw / ph, -0.7, 0.7));
}

function onUp() {
    if (!drag) return;
    const moved = drag.moved;
    drag = null;
    if (!moved) {
        if (tearP.to === 0) tearDir = Math.random() < 0.5 ? -1 : 1;
        tearP.set(0.55);
        tearP.to = 1;
        return;
    }
    if (tearP.to > 0.55) {
        tearP.set(0.18);
        tearP.to = 1;
        return;
    }
    // 松手停在中途：撕条松弛下来，留着那道半撕的口子
    tearTh.to = 3 + tearP.to * 10;
    tearPh.to = -tearP.to * 14;
}

function tearAll() {
    if (props.phase !== 'sealed') return;
    if (tearP.to === 0) tearDir = Math.random() < 0.5 ? -1 : 1;
    tearP.set(0.55);
    tearP.to = 1;
}

/**
 * 给页面用的三样东西：撕、包的姿态、包口高度。
 *
 * ⚠️ `pose()` 每帧都会被调用两次（一次给卡片编排、一次给纸屑的 `onStage`），
 * 所以它只**读**现有状态、不做任何计算 —— 别往这里加逻辑。
 */
defineExpose({
    tearAll,
    pose: () => ({
        rx: P.rx.x,
        ry: P.ry.x,
        rz: P.rz.x,
        px: P.x.x,
        py: P.y.x,
        pw,
        ph,
        fallY: fall ? fall.y : 0,
        // 包口 = 撕口最深处的那个点，相对包中心
        mouth: ph * (Math.max(...jag.map(q => q.y)) / 100 - 0.5),
    }),
    tearYAt: (x: number) => yAt(jag, x),
});

/**
 * ⚠️ 归一化用**整个窗口**，不是包自身的矩形。
 *
 * 参考站就是这么做的（`pointer.x / innerWidth * 2 - 1`）。差别很直观：
 *   · 窗口归一化 ⇒ 鼠标在屏幕左半边任何一个位置，包都转到一定程度（像被"远处的手"牵动）；
 *   · 包内归一化 ⇒ 只有鼠标贴到包的边缘才转到底，稍一离开就弹回 —— 反馈显得又急又假。
 * 这一条就是"鼠标在其上的反馈和源码不一样"的主因。
 */
function onPointerTrack(ev: PointerEvent) {
    pointer.in = true;
    pointer.nx = clamp((ev.clientX / window.innerWidth) * 2 - 1, -1, 1);
    pointer.ny = clamp((ev.clientY / window.innerHeight) * 2 - 1, -1, 1);
}

function onPointerLeave() {
    pointer.in = false;
}

function measure() {
    const el = packEl.value;
    if (!el) return;
    pw = el.offsetWidth || 280;
    ph = el.offsetHeight || 405;
    el.style.setProperty('--tooth', `${(pw / 26).toFixed(2)}px`);
}

function onResize() {
    const next = packEl.value?.offsetWidth || 0;
    if (Math.abs(next - pw) < 1) return;
    measure();
    flow?.setSize(pw, ph, window.innerWidth, window.innerHeight);
    if (tearP.x > 0) applyClips(Math.min(1, tearP.x));
}

onMounted(() => {
    measure();

    /**
     * ⚠️ 必须在这里先跑一次 `applyClips(0)`。
     *
     * 12 片撕条在模板里是**铺满整个包**的（每片 `inset: 0`，靠 clip-path 只留自己那一条）。
     * 不先裁一次，12 层铝箔渐变会一起盖在正面 —— 真机表现是"包变成一块灰白大理石"，
     * 颜色全被糊掉（这一条踩过）。
     */
    applyClips(0);

    // 这一包的光影现场画（封边褶皱高光 + 底部暗褶），所以每包都不一样
    const light = paintLight();
    for (const el of [frontEl.value, ...plyEls.map(p => p?.querySelector('.ply-skin') as HTMLElement | null)]) {
        if (el) {
            el.style.setProperty('--shine', light.shine);
            el.style.setProperty('--shade', light.shade);
        }
    }

    if (flowEl.value) {
        flow = new RainbowFlow(flowEl.value);
        flow.setSize(pw, ph, window.innerWidth, window.innerHeight);
    }
    if (!stage.reduce) {
        P.x.x = window.innerWidth * 0.62;
        P.y.x = -50;
        P.ry.x = -200;
        P.rz.x = 16;
    }
    stage.start();

    window.addEventListener('pointermove', onPointerTrack);
    window.addEventListener('resize', onResize);
    document.documentElement.addEventListener('pointerleave', onPointerLeave);
});

onBeforeUnmount(() => {
    window.removeEventListener('pointermove', onPointerTrack);
    window.removeEventListener('resize', onResize);
    document.documentElement.removeEventListener('pointerleave', onPointerLeave);
    stage.stop();
});
</script>

<style scoped lang="less">
/* ── 舞台 ──────────────────────────────────────────────────────────────── */
.pack-stage {
    /* 包是竖直长条：0.69 : 1（真实铝箔卡包的比例） */
    --ph: min(400px, 52vh);
    --pw: calc(var(--ph) * 0.69);
    --crimp: calc(var(--ph) * 0.068);
    --depth: 14px;
    --tooth: calc(var(--pw) / 26);

    position: relative;
    width: var(--pw);
    height: var(--ph);
    perspective: 1400px;
    perspective-origin: 50% 40%;
    pointer-events: none;
}

/* 地面投影：椭圆、模糊。深色主题下几乎看不见（黑阴影落在 #0e0e0e 上），
   所以还配了舞台光晕，让包"浮"起来而不是贴在背景上 */
.ground {
    position: absolute;
    left: 50%;
    top: 130%;
    width: calc(var(--pw) * 1.25);
    height: calc(var(--pw) * 0.3);
    margin: 0 0 0 calc(var(--pw) * -0.625);
    translate: 0 -50%;
    border-radius: 50%;
    background: radial-gradient(closest-side, var(--ff-jewel-shadow), transparent);
    filter: blur(8px);
    pointer-events: none;
}

/* 彩虹光流容器：宽 = 包宽、高 = 包宽 × 0.76 ⇒ 1 svg 单位 = 包宽的 1% */
.flow {
    position: absolute;
    left: 0;
    width: 100%;
    top: calc(10.5% - var(--pw) * .6);
    height: calc(var(--pw) * .76);
    overflow: visible;
    opacity: 0;
    pointer-events: none;
}

/* ── 包体 ──────────────────────────────────────────────────────────────── */
.pack {
    position: absolute;
    inset: 0;
    transform-style: preserve-3d;
    will-change: transform;
    pointer-events: auto;
    cursor: grab;
}

/**
 * 铝箔袋的"皮"：正面、背面、以及每一片撕条的正面与背面都用它。
 *
 * 四层背景叠出来的，缺一层就变成一块纯色板：
 *   ① `--shade`  底部封口的皱褶阴影（每包现画）
 *   ② 右侧 9% 处一道淡影 —— 右边缘背光的样子
 *   ③④ 上下封边的**热压纹**（1px 一组的暗/亮横条）
 *
 * `mask` 是上下两排锯齿 + 一个略收的轮廓 —— 齐边矩形是纸盒，只有被压出齿的封边
 * 才读作"热封过的软包装"。
 */
.skin {
    position: absolute;
    inset: 0;
    backface-visibility: hidden;
    transform: translateZ(calc(var(--depth) / 2));
    background:
        var(--shade, none) 0 0 / 100% 100%,
        linear-gradient(90deg, transparent 91%, color-mix(in srgb, black 14%, transparent) 97.6%) 0 50% / 100% calc(100% - 2 * var(--crimp)) no-repeat,
        repeating-linear-gradient(90deg,
            color-mix(in srgb, black 18%, transparent) 0 1px,
            color-mix(in srgb, white 8%, transparent) 1px 2px,
            transparent 2px 5px) 0 0 / 100% var(--crimp) no-repeat,
        repeating-linear-gradient(90deg,
            color-mix(in srgb, black 18%, transparent) 0 1px,
            color-mix(in srgb, white 8%, transparent) 1px 2px,
            transparent 2px 5px) 0 100% / 100% var(--crimp) no-repeat,
        var(--pack, var(--ff-pack-cobalt));
    mask:
        conic-gradient(from 135deg at 50% 0, transparent, black 1deg 89deg, transparent 90deg)
            0 0 / var(--tooth) calc(var(--tooth) / 2) repeat-x,
        url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100' preserveAspectRatio='none'><path d='M0 0H100V5.6C100 8 97.6 7.6 97.6 10V90C97.6 92.4 100 92 100 94.4V100H0V94.4C0 92 2.4 92.4 2.4 90V10C2.4 7.6 0 8 0 5.6Z'/></svg>")
            0 50% / 100% calc(100% - var(--tooth)) no-repeat,
        conic-gradient(from -45deg at 50% 100%, transparent, black 1deg 89deg, transparent 90deg)
            0 100% / var(--tooth) calc(var(--tooth) / 2) repeat-x;
}

.skin--back {
    transform: rotateY(180deg) translateZ(calc(var(--depth) / 2));
}

/**
 * 箔面上的反光：左边缘一道竖高光（随 `--gx` 横移），顶部封边下方一片褶皱亮光
 * （`--shine`，每包现画）。
 */
.skin::before,
.skin::after {
    content: '';
    position: absolute;
    inset: 0;
    z-index: 1;
    pointer-events: none;
}

.skin::before {
    background: linear-gradient(90deg,
        transparent 2.4%,
        var(--ff-film-sheen) 3%,
        color-mix(in srgb, white 28%, transparent) 5%,
        transparent 9%);
    mask: linear-gradient(transparent 7%, black 13% 48%, transparent 84%);
    translate: calc(var(--gx, 0) * 1%) 0;
    opacity: var(--gl, 0.8);
}

.skin::after {
    background: var(--shine, none) 0 0 / 100% 100%;
    opacity: var(--gt, 0.85);
    mask: linear-gradient(90deg,
        color-mix(in srgb, black 45%, transparent),
        black 40% 60%,
        color-mix(in srgb, black 45%, transparent))
        calc(var(--gm, 50) * 1%) 0 / 250% 100%;
}

/* 印刷 */
.tear-hint {
    position: absolute;
    left: 9%;
    top: calc(var(--crimp) + 0.9%);
    font: 700 calc(var(--pw) * .024)/1 var(--ff-font);
    letter-spacing: .1em;
    text-transform: uppercase;
    color: color-mix(in srgb, white 74%, transparent);
}

.mark {
    position: absolute;
    left: 8%;
    top: 13.5%;
    font: 500 calc(var(--pw) * .085)/1 var(--ff-font);
    letter-spacing: -.01em;
    color: var(--ff-on-band);
}

.series {
    position: absolute;
    right: 9%;
    top: 16%;
    font: 500 calc(var(--pw) * .032)/1 var(--ff-font);
    letter-spacing: .14em;
    text-transform: uppercase;
    color: color-mix(in srgb, white 70%, transparent);
}

/* 居中图形：一张光盘的俯视（我们没有角色，用"这次要抽的东西"代替） */
.orb {
    position: absolute;
    left: 8%;
    width: 84%;
    top: 28%;
    aspect-ratio: 1;
    display: grid;
    place-items: center;
}

.disc {
    width: 100%;
    height: 100%;
    border-radius: 50%;
    background: radial-gradient(circle at 34% 30%,
        var(--ff-disc-sheen), var(--ff-disc-face) 46%, var(--ff-inner-paper) 94%);
    box-shadow:
        inset 0 0 0 1px color-mix(in srgb, white 34%, transparent),
        0 8px 16px -10px var(--ff-jewel-shadow);
    position: relative;
}

.disc::after {
    content: '';
    position: absolute;
    inset: 12%;
    border-radius: 50%;
    background: conic-gradient(from 24deg,
        var(--ff-foil-a), var(--ff-foil-b), var(--ff-foil-c), var(--ff-foil-a),
        var(--ff-foil-c), var(--ff-foil-b), var(--ff-foil-a));
    mix-blend-mode: screen;
    opacity: 0.5;
    mask: radial-gradient(circle, transparent 22%, black 34%, black 86%, transparent 99%);
}

.disc::before {
    content: '';
    position: absolute;
    left: 50%;
    top: 50%;
    width: 13%;
    aspect-ratio: 1;
    translate: -50% -50%;
    border-radius: 50%;
    background: var(--pack, var(--ff-pack-cobalt));
    box-shadow: inset 0 0 0 1px color-mix(in srgb, white 40%, transparent);
}

.foot {
    position: absolute;
    bottom: calc(var(--crimp) + 3.4%);
    font: 500 calc(var(--pw) * .04)/1 var(--ff-font);
    color: color-mix(in srgb, white 78%, transparent);
}

.foot--l { left: 9%; }
.foot--r { right: 9%; }

/* 背面 */
.fin {
    position: absolute;
    left: 45%;
    width: 10%;
    top: 0;
    bottom: 0;
    background:
        repeating-linear-gradient(black 0 1px, transparent 1px 4px),
        linear-gradient(90deg,
            color-mix(in srgb, black 30%, transparent),
            color-mix(in srgb, white 18%, transparent) 45%,
            color-mix(in srgb, black 22%, transparent));
}

.mark--sm {
    left: 0;
    right: 0;
    top: 20%;
    text-align: center;
    font-size: calc(var(--pw) * .1);
}

.blurb {
    position: absolute;
    left: 10%;
    right: 10%;
    top: 40%;
    margin: 0;
    text-align: center;
    font: 500 calc(var(--pw) * .042)/1.5 var(--ff-font);
    color: color-mix(in srgb, white 85%, transparent);
}

.code {
    position: absolute;
    left: 31%;
    right: 31%;
    bottom: calc(var(--crimp) + 6%);
    height: 10%;
    padding: 6px 8px;
    border-radius: 4px;
    background:
        repeating-linear-gradient(90deg,
            var(--ff-inner-band) 0 2px, transparent 2px 3px,
            var(--ff-inner-band) 3px 4px, transparent 4px 7px,
            var(--ff-inner-band) 7px 10px, transparent 10px 12px) content-box,
        var(--ff-panel);
}

/* ── 撕条 ──────────────────────────────────────────────────────────────── */
.flap {
    position: absolute;
    inset: 0;
    transform-style: preserve-3d;
    pointer-events: none;
}

.ply {
    position: absolute;
    inset: 0;
    transform-style: preserve-3d;
    transform-origin: 0 0;
}

.ply-skin {
    transform: translateZ(0.4px);
}

/* 撕条背面是铝箔：银色一条条，与正面完全不同 */
.skin--foil {
    transform: rotateY(180deg) translateZ(0.4px);
    background:
        linear-gradient(97deg,
            var(--ff-disc-face), var(--ff-panel) 12%,
            var(--ff-disc-face) 26%, var(--ff-panel) 44%,
            var(--ff-disc-face) 58%, var(--ff-panel) 76%,
            var(--ff-disc-face));
}

.skin--foil::before,
.skin--foil::after {
    display: none;
}

/* 撕口的金属亮边：一条被磨亮的面，比周围亮一档 */
.lip {
    position: absolute;
    inset: 0;
    z-index: 2;
    background: linear-gradient(100deg,
        var(--ff-panel), var(--ff-disc-sheen) 14%,
        var(--ff-disc-face) 27%, var(--ff-panel) 42%,
        var(--ff-disc-face) 58%, var(--ff-panel) 72%,
        var(--ff-disc-face) 86%, var(--ff-panel));
    filter: drop-shadow(0 1.5px 1.2px var(--ff-jewel-shadow));
}

.lips {
    position: absolute;
    inset: 0;
    z-index: 2;
    pointer-events: none;
}

.tone {
    position: absolute;
    inset: 0;
    z-index: 3;
    background: var(--ff-inner-band);
    opacity: 0;
}

/* 撕条里那层"暗化"用副本来做，`tone` 由 JS 逐片写 opacity */

/* 交互层：盖住整个包，也是按下/拖动的目标 */
.hit {
    position: absolute;
    inset: -24px -16px -8px;
    margin: 0;
    padding: 0;
    border: 0;
    border-radius: 14px;
    background: none;
    appearance: none;
    cursor: grab;
    touch-action: none;
    transform: translateZ(calc(var(--depth) / 2 + 2px));
    -webkit-tap-highlight-color: transparent;

    &:focus-visible {
        outline: 2px solid var(--ff-highlight);
        outline-offset: 8px;
    }
}

@media (prefers-reduced-motion: reduce) {
    .pack {
        transition: none;
    }
}
</style>
