<template>
    <div class="case-stage">
        <!-- 地面投影：随盒子上下浮动缩放、随下落淡出。没有它，盒子像贴在背景上 -->
        <div ref="groundEl" class="ground" aria-hidden="true" />

        <div ref="caseEl" class="case" :class="[`is-${phase}`, `tint-${tint}`]">
            <!-- 盒底（暗的），让掀开后的盒口有深度而不是一张纸 -->
            <div class="inner" aria-hidden="true" />

            <!-- 封面纸：匿名封面 = 光盘俯视的同心圆。拆开前绝不出现任何具体作品 -->
            <div class="front">
                <div class="disc" aria-hidden="true">
                    <span class="disc__ring disc__ring--1" />
                    <span class="disc__ring disc__ring--2" />
                    <span class="disc__ring disc__ring--3" />
                    <span class="disc__hole" />
                </div>
                <div class="brand">File Finder</div>
                <div class="band">
                    <span>随机一包</span>
                    <span>5 discs</span>
                </div>
                <div class="seal" aria-hidden="true">5</div>
            </div>

            <!-- 左侧书脊：盒子的厚度感全靠这一条 -->
            <div class="spine" aria-hidden="true"><span>5 DISCS</span></div>

            <!-- 透明盒盖：掀开时绕右侧铰链翻过去 -->
            <div class="lid" aria-hidden="true" />

            <!-- 撕口的彩虹光：夹在膜和盒盖之间，只有膜裂开后才露出来 -->
            <svg ref="flowEl" class="flow" viewBox="0 0 100 76" aria-hidden="true" />

            <!-- 收缩膜：整张一层，`clip-path` 逐帧按 96 段撕口裁掉已撕的部分 -->
            <div ref="filmEl" class="film" aria-hidden="true" />

            <!-- 拉条：按下即撕、横向拖动跟手、松手停在中途（再点一次撕完） -->
            <button
                v-if="phase === 'sealed'"
                class="tab"
                type="button"
                aria-label="撕开包装"
                @pointerdown.stop="onTabDown"
                @pointermove.stop="onTabMove"
                @pointerup.stop="onTabUp"
                @pointercancel.stop="onTabUp"
                @click.stop
            />
        </div>
    </div>
</template>

<script setup lang="ts">
/**
 * 未拆封的标准 CD 盒 —— 一个受力的**物体**，撕开是**逐帧算出来的**。
 *
 * 三个来源，一条都不许简化（全部移植自 `holo-reverse/src/app.js`）：
 *   ① `spring.ts`   —— 位置/朝向是弹簧：静止时呼吸、跟手转、开包后被踢下去；
 *   ② `tearPath.ts` —— 撕口是 96 段曲线，未撕的部分跟着手弯；
 *   ③ `flow.ts`     —— 35 条 SVG 彩虹带从撕口喷出，撕到哪喷到哪。
 *
 * ## 它不负责的事
 * - 五张卡（在页面里，从盒心飞出）
 * - 时间轴（`phase` 由页面推；本组件只在"撕到 1"时 `emit('opened')`）
 * - 颜色（全部走 `tokens.css` 的 `--ff-*`）
 */
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { FEEL, Spring, pose, stepAll, values } from '@/views/Lucky/spring';
import { useStage } from '@/views/Lucky/useStage';
import { createJag, restOutline, toPolygon } from '@/views/Lucky/tearPath';
import { RainbowFlow } from '@/views/Lucky/flow';

const props = defineProps<{
    phase: 'sealed' | 'opening' | 'open';
    /** 本次专辑的主题色，由页面每包随机给 */
    tint: 'a' | 'b' | 'c';
}>();

const emit = defineEmits<{ opened: [] }>();

const caseEl = ref<HTMLElement | null>(null);
const groundEl = ref<HTMLElement | null>(null);
const filmEl = ref<HTMLElement | null>(null);
const flowEl = ref<SVGSVGElement | null>(null);

/** 位置与朝向 */
const P = pose({ x: 0, y: 0, rx: 0, ry: 0, rz: 0 }, ...FEEL.pointer);
/** 撕裂进度（0~1）。`.1` 的手感 = 很快 —— 跟手拖动时它会紧紧追着目标 */
const tearP = new Spring(0, 0.1);

const pointer = { nx: 0, ny: 0 };
let tearDir: 1 | -1 = 1;
const jag = createJag();
let flow: RainbowFlow | null = null;

/** 开包后被牌堆踢下去的位移 */
let fall: { y: number; v: number } | null = null;
const FALL_DELAY = 0.24;
let fallAt = -1;
let lastPhase = props.phase;

let openedFired = false;
/** 盒子掉下去后光流只收一次 */
let flowDropped = false;
/** 开包时刻（`t` 坐标系），光流"冲出去"的计时起点 */
let openedAt = 0;
let size = 300;

interface DragState { id: number; x0: number; p0: number; moved: boolean }
let drag: DragState | null = null;

function clamp(v: number, a: number, b: number): number {
    return Math.min(b, Math.max(a, v));
}

const stage = useStage((dt, t) => {
    const el = caseEl.value;
    if (!el) return;

    // ── 撕裂进度 ──────────────────────────────────────────────
    stepAll([tearP], dt);
    const p = clamp(tearP.x, 0, 1);
    if (p >= 0.995 && !openedFired) {
        openedFired = true;
        openedAt = t;
        emit('opened');
    }
    // 撕口形状逐帧重算：手一动，未撕的那段就跟着弯下去
    if (filmEl.value && p > 0) {
        filmEl.value.style.clipPath = toPolygon(restOutline(jag, p, tearDir));
    }

    // ── 包装的姿态 ────────────────────────────────────────────
    P.y.to = Math.sin(t * 1.4) * (props.phase === 'sealed' ? 7 : 2);
    const follow = props.phase === 'sealed' ? 1 : 0.35;
    P.ry.to = pointer.nx * 22 * follow;
    P.rx.to = -pointer.ny * 16 * follow;
    P.rz.to = Math.sin(t * 0.9) * 1.6 - (p > 0 && p < 1 ? tearDir * p * 3 : 0);

    stepAll(values(P), dt);

    if (props.phase !== lastPhase) {
        lastPhase = props.phase;
        if (props.phase === 'opening') fallAt = t + FALL_DELAY;
    }
    if (!fall && fallAt >= 0 && t >= fallAt) fall = { y: 0, v: (1500 * size) / 420 };
    if (fall) {
        fall.v += 2600 * dt;
        fall.y += fall.v * dt;
        P.rz.to = tearDir * 9;
    }

    const fy = fall ? fall.y : 0;
    el.style.transform =
        `translate3d(${P.x.x.toFixed(2)}px, ${(P.y.x + fy).toFixed(2)}px, 0) ` +
        `rotateX(${(P.rx.x + 3).toFixed(2)}deg) rotateY(${(P.ry.x - 18).toFixed(2)}deg) ` +
        `rotateZ(${P.rz.x.toFixed(2)}deg)`;

    el.style.setProperty('--gx', clamp(-P.ry.x * 0.12, -1.5, 3).toFixed(2));
    el.style.setProperty('--gt', clamp(0.85 + P.rx.x * 0.015, 0.5, 1).toFixed(2));

    // ── 彩虹光流 ──────────────────────────────────────────────
    // 盒子开始下落 = 光流的"根"没了，必须立刻收（否则会在半空留一片彩虹，
    // 因为它挂在盒子内部、跟着盒子一起移出屏幕时 filter 层会留下脏块）
    if (fall && !flowDropped) {
        flowDropped = true;
        flow?.reset();
    }
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

    const ground = groundEl.value;
    if (ground) {
        ground.style.transform = `translate3d(${P.x.x.toFixed(2)}px, 0, 0) scale(${clamp(1 - P.y.x / 300, 0.6, 1.15).toFixed(3)})`;
        ground.style.opacity = fall ? clamp(1 - fall.y / 160, 0, 1).toFixed(3) : '0.55';
    }
});

/** 按下：开始一次可能的撕 */
function onTabDown(ev: PointerEvent) {
    if (props.phase !== 'sealed') return;
    (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
    drag = { id: ev.pointerId, x0: ev.clientX, p0: tearP.to, moved: false };
}

/** 拖动：横向跟手。第一次真往侧面拖时才决定从哪边撕 */
function onTabMove(ev: PointerEvent) {
    if (!drag || ev.pointerId !== drag.id) return;
    const dx = ev.clientX - drag.x0;
    if (!drag.moved) {
        if (Math.abs(dx) < 6) return;
        drag.moved = true;
    }
    if (tearP.to === 0) {
        tearDir = dx < 0 ? -1 : 1;
        drag.x0 = ev.clientX;
    }
    tearP.to = clamp(drag.p0 + (drag.p0 ? Math.abs(dx) : dx * tearDir) / (size * 0.85), tearP.to, 1);
}

/** 抬手：没拖动 = 点了一下（撕到一半）；拖到中途 = 留着那道口子 */
function onTabUp() {
    if (!drag) return;
    const moved = drag.moved;
    drag = null;
    if (!moved) {
        if (tearP.to === 0) tearDir = Math.random() < 0.5 ? -1 : 1;
        tearP.set(0.55);
        tearP.to = 1;
        return;
    }
    if (tearP.to < 0.95) tearP.to = Math.max(tearP.to, 0.35);
}

/** 外部按钮入口：一撕到底 */
function tearAll() {
    if (props.phase !== 'sealed') return;
    if (tearP.to === 0) tearDir = Math.random() < 0.5 ? -1 : 1;
    tearP.set(0.55);
    tearP.to = 1;
}

defineExpose({ tearAll });

function onMove(ev: PointerEvent) {
    const el = caseEl.value;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    pointer.nx = clamp(((ev.clientX - rect.left) / rect.width) * 2 - 1, -1, 1);
    pointer.ny = clamp(((ev.clientY - rect.top) / rect.height) * 2 - 1, -1, 1);
}

function onLeave() {
    pointer.nx = 0;
    pointer.ny = 0;
}

function onResize() {
    const next = caseEl.value?.offsetWidth || 300;
    if (next === size) return;
    size = next;
    flow?.setSize(size, size, window.innerWidth, window.innerHeight);
}

onMounted(() => {
    size = caseEl.value?.offsetWidth || 300;
    if (flowEl.value) {
        flow = new RainbowFlow(flowEl.value);
        flow.setSize(size, size, window.innerWidth, window.innerHeight);
    }
    if (!stage.reduce) {
        // 进场：从右侧旋转飞入（参考站同一手法）
        P.x.x = window.innerWidth * 0.62;
        P.y.x = -50;
        P.ry.x = -200;
        P.rz.x = 16;
    }
    stage.start();
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerleave', onLeave);
    window.addEventListener('resize', onResize);
});

onBeforeUnmount(() => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerleave', onLeave);
    window.removeEventListener('resize', onResize);
    stage.stop();
});
</script>

<style scoped lang="less">
.case-stage {
    --size: clamp(240px, 38vh, 360px);
    position: relative;
    display: grid;
    place-items: center;
    /* 盒子必须压在扇形卡片之上：卡片在 sealed 阶段虽然 `opacity: 0`，但仍占着
       同一个中心格 —— 不给 z-index 的话盒子的点击区会被透明卡片盖住一半。 */
    z-index: 4;
    perspective: 1400px;
    perspective-origin: 50% 42%;
    pointer-events: none;
}

/* 背后的光晕。
   ⚠️ 深色主题下**投影是无效的**：黑色阴影落在 #0e0e0e 上等于没画。暗背景要靠"光"
   分层 —— 盒子浮在一团柔光里，轮廓才立得起来（浅色主题这团光几乎看不出，无害）。 */
.case-stage::before {
    content: '';
    position: absolute;
    width: calc(var(--size) * 2.4);
    aspect-ratio: 1;
    border-radius: 50%;
    background: radial-gradient(closest-side, var(--ff-jewel-edge), transparent 72%);
    opacity: 0.5;
    filter: blur(22px);
    pointer-events: none;
}

.case {
    position: relative;
    width: var(--size);
    height: var(--size);
    transform-style: preserve-3d;
    /* 基础倾斜 + 逐帧写入的位移/旋转都在 JS 里拼（见 `stage` 回调）。
       ⚠️ 这里**不许**写 `transition: transform`：逐帧写 transform 时两者互相打架，
          表现为"跟手但慢半拍、松手后又飘一下"。
       ⚠️ 基础倾斜 -18° 不是装饰：正面 0° 时书脊那面（`rotateY(-90deg)`）正好侧对镜头，
          一条金色都看不见，整盒读起来是张平面纸。 */
    pointer-events: auto;
    cursor: grab;
    will-change: transform;
}

/* 地面投影 */
.ground {
    position: absolute;
    left: 50%;
    top: 50%;
    width: calc(var(--size) * 0.95);
    height: calc(var(--size) * 0.16);
    margin: calc(var(--size) * 0.42) 0 0 calc(var(--size) * -0.475);
    border-radius: 50%;
    background: radial-gradient(closest-side, var(--ff-jewel-shadow), transparent);
    filter: blur(7px);
    pointer-events: none;
    will-change: transform, opacity;
}

/* 掀开 780ms 后整个盒子淡出让位给卡片；`phase=open` 时父级会把它 v-if 掉 */
.case.is-opening {
    animation: case-away 520ms 260ms ease forwards;
}

@keyframes case-away {
    /* ⚠️ 只动 `opacity` 与独立的 `translate`：写 `transform` 会覆盖掉 `.case` 上那个
       基础倾斜（-13°），退场瞬间盒子会突然"转正"一下，很扎眼。 */
    to {
        opacity: 0;
        translate: 0 26px;
    }
}

.inner {
    position: absolute;
    inset: 0;
    border-radius: 3px;
    background: var(--ff-inner-band);
    transform: translateZ(-8px);
    box-shadow: 0 40px 60px -30px var(--ff-jewel-shadow);
}

.front {
    position: absolute;
    inset: 0;
    border-radius: 3px;
    /* 封面纸用**本次的主题色**。灰纸是"一个盒子"，彩纸才是"一张专辑" ——
       而且这是参考站"每包换配色"的等价物：他换软包颜色，我们换专辑主色。 */
    background: var(--cover, var(--ff-inner-paper));
    transform: translateZ(0);
    overflow: hidden;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    box-shadow: inset 0 0 0 1px var(--ff-line);
}

.case.tint-a { --cover: var(--ff-foil-a); }
.case.tint-b { --cover: var(--ff-foil-b); }
.case.tint-c { --cover: var(--ff-foil-c); }

/* 顶光：纸面从上方吃到一道光，底部渐渐暗下去。
   没有它，深色主题下整块纸是均质的一块灰 —— 有明暗走向才像"被灯照着的实物" */
.front::after {
    content: '';
    position: absolute;
    inset: 0;
    pointer-events: none;
    background:
        linear-gradient(180deg, var(--ff-jewel-edge), transparent 42%),
        linear-gradient(0deg, var(--ff-jewel-shadow), transparent 24%);
    opacity: 0.5;
}

/* 匿名封面：光盘正面俯视。同心圆 + 中心孔，用 `--ff-disc-*` 而不是图片 */
.disc {
    position: absolute;
    left: 50%;
    top: 42%;
    width: 62%;
    aspect-ratio: 1;
    translate: -50% -50%;
    border-radius: 50%;
    background: radial-gradient(circle at 32% 28%,
        var(--ff-disc-sheen), var(--ff-disc-face) 52%, var(--ff-inner-paper) 96%);
    box-shadow: 0 10px 18px -12px var(--ff-jewel-shadow);
}

.disc__ring {
    position: absolute;
    left: 50%;
    top: 50%;
    translate: -50% -50%;
    border-radius: 50%;
    border: 1px solid var(--ff-jewel-edge);
    opacity: 0.55;
}

.disc__ring--1 { width: 78%; height: 78%; }
.disc__ring--2 { width: 52%; height: 52%; opacity: 0.4; }
.disc__ring--3 { width: 30%; height: 30%; opacity: 0.3; }

.disc__hole {
    position: absolute;
    left: 50%;
    top: 50%;
    width: 12%;
    aspect-ratio: 1;
    translate: -50% -50%;
    border-radius: 50%;
    background: var(--ff-canvas);
    box-shadow: inset 0 0 0 1px var(--ff-jewel-edge);
}

/**
 * 光盘的彩虹衍射。
 *
 * 这不是"为了好看硬加的色相" —— 真实光盘表面有沟槽，白光打上去就是一圈衍射彩环。
 * 它是这个页面**唯一合法的彩色来源**：它属于"介质本身"，不覆盖任何真实封面内容。
 * `mask` 挖掉中心孔与外缘，让彩虹只落在盘面上（否则会糊成一个彩色圆饼）。
 */
.disc::after {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: 50%;
    background: conic-gradient(from 24deg,
        var(--ff-foil-a), var(--ff-foil-b), var(--ff-foil-c), var(--ff-foil-a),
        var(--ff-foil-c), var(--ff-foil-b), var(--ff-foil-a));
    mix-blend-mode: screen;
    /* ⚠️ 不要超过 0.5：在彩色封面上（`screen` 混合）再高就会与底色相消，
       圆盘会读成一块脏灰紫，而不是"银色光盘上的一圈衍射"。 */
    opacity: 0.44;
    mask: radial-gradient(circle, transparent 15%, #000 28%, #000 84%, transparent 98%);
}

.brand {
    position: relative;
    margin: 7% 0 0 8%;
    font: 500 3.4cqw/1 var(--ff-font);
    letter-spacing: 0.28em;
    text-transform: uppercase;
    color: var(--ff-inner-band);
    container-type: inline-size;
}

/* 底部窄信息条 */
.band {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 3.2% 5%;
    background: var(--ff-inner-band);
    color: var(--ff-on-band);
    font: 500 11px/1 var(--ff-font);
    letter-spacing: 0.14em;
}

.seal {
    position: absolute;
    top: 6%;
    right: 6%;
    width: 34px;
    height: 34px;
    display: grid;
    place-items: center;
    border-radius: 50%;
    background: var(--ff-foil-b);
    color: var(--ff-inner-band);
    font: 500 13px/1 var(--ff-font);
}

/* 书脊：绕左边缘转 90°，`transform-origin: left` 让它贴着盒子左边立起来。
   宽度 5% 而不是固定 px —— 它要在 240~360px 的盒子上都保持同一条比例。
   ⚠️ 它只有在 `.case` 有基础倾斜（-13°）时才可见，见上面那条注释。 */
.spine {
    position: absolute;
    left: 0;
    top: 0;
    width: 5%;
    height: 100%;
    transform-origin: left center;
    transform: rotateY(-90deg) translateZ(0);
    background: linear-gradient(90deg, var(--ff-foil-b), var(--ff-foil-a));
    overflow: hidden;
    display: grid;
    place-items: center;
    box-shadow: inset -1px 0 0 var(--ff-jewel-shadow);

    span {
        font: 500 7px/1 var(--ff-font);
        letter-spacing: 0.12em;
        color: var(--ff-inner-band);
        white-space: nowrap;
        transform: rotate(90deg);
    }
}

/* 透明盒盖：只画边缘与内高光，不填色（填了就看不见下面的封面） */
.lid {
    position: absolute;
    inset: 0;
    border-radius: 3px;
    transform-origin: right center;
    transform: translateZ(6px);
    box-shadow:
        inset 0 0 0 1px var(--ff-jewel-edge),
        inset 0 2px 3px var(--ff-jewel-edge),
        inset 0 -3px 6px var(--ff-jewel-shadow);
    background: linear-gradient(112deg,
        transparent 38%, var(--ff-jewel-edge) 39%, transparent 46%);
    opacity: 0.5;
    transition: transform 520ms cubic-bezier(0.34, 1.4, 0.64, 1), opacity 520ms ease;
    pointer-events: none;
}

.is-opening .lid {
    transform: translateZ(6px) rotateY(-108deg);
    opacity: 0.22;
}

/* 撕口喷出的彩虹：一圈箔色的环，随膜裂开被"放出来"然后放大淡去 */
/**
 * 彩虹光流的容器。
 *
 * ⚠️ 尺寸与位置**精确对应**，改一个数整片扇形就会歪：
 *   · `viewBox="0 0 100 76"`：x 0~100 = 包装宽度，y≈60 是撕口线；
 *   · 元素宽 = 包装宽、高 = 包装宽 × 0.76 ⇒ 1 个 svg 单位恰好 = 包装宽的 1%；
 *   · `top` 把它上移到"撕口线往上 0.6 个包装宽"，光带才从口子里冒出来；
 *   · `overflow: visible` 必须开着 —— 光带要冲出屏幕顶边，超出 viewBox 是常态。
 */
.flow {
    position: absolute;
    left: 0;
    width: 100%;
    top: calc(10.5% - var(--size) * .6);
    height: calc(var(--size) * .76);
    overflow: visible;
    opacity: 0;
    transform: translateZ(4px);
    pointer-events: none;
}

/* ── 收缩膜 ────────────────────────────────────────────────────────────────
   ⚠️ 必须是**不透明的雾**：撕开前看不清里面，才有悬念；撕开后才"变清晰"。
      如果做成透明，撕膜这个动作在画面上等于没发生。 */
.film {
    position: absolute;
    inset: 0;
    transform: translateZ(9px);
    /* `--gx/--gt` 由逐帧循环按盒子朝向写入 —— 膜上的高光随倾斜滑动，
       这是"它在反光"而不是"它贴了一张渐变图"。 */
    background: linear-gradient(154deg, transparent 62%,
            var(--ff-film-sheen) 63%, transparent 68%) var(--gx, 0) 0 / 100% 100%,
        linear-gradient(96deg, transparent 24%,
            var(--ff-film-sheen) 25%, transparent 30%),
        var(--ff-film-veil);
    opacity: var(--gt, 1);
    transition: transform 460ms cubic-bezier(0.3, 0.9, 0.4, 1), opacity 460ms ease;
    pointer-events: none;
}

/* 拉条：右上角一片可以按下去的小三角 */
.tab {
    position: absolute;
    top: 0;
    right: 0;
    width: 46px;
    height: 46px;
    padding: 0;
    border: 0;
    background: var(--ff-film-sheen);
    clip-path: polygon(100% 0, 100% 100%, 0 0);
    cursor: pointer;
    transform: translateZ(10px);
    transition: background-color 160ms ease;

    &:hover {
        background: var(--ff-jewel-edge);
    }

    &:focus-visible {
        outline: 2px solid var(--ff-highlight);
        outline-offset: -4px;
    }
}

/* 撕到底：已被 clip-path 挖空，剩下的残膜淡出 */
.is-opening .film,
.is-open .film {
    opacity: 0;
    transition: opacity 300ms ease;
}

@media (prefers-reduced-motion: reduce) {
    .case,
    .lid,
    .film {
        transition: none;
    }

    .is-opening .rays,
    .case.is-opening {
        animation: none;
    }
}
</style>
