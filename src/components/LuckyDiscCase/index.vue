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
            <div class="rays" aria-hidden="true" />

            <!-- 收缩膜：两半，各自的锯齿边由 `tearPolygon` 生成（直线撕口像剪刀剪的） -->
            <div class="film film--l" :style="{ clipPath: polyLeft }" aria-hidden="true" />
            <div class="film film--r" :style="{ clipPath: polyRight }" aria-hidden="true" />

            <!-- 拉条：整张膜的开关。按下即撕（不做跟手拖拽 —— 撕口跟随手指需要逐帧重算
                 锯齿轮廓，成本远大于收益；动画本身已经足够爽） -->
            <button
                v-if="phase === 'sealed'"
                class="tab"
                type="button"
                aria-label="撕开包装"
                @pointerdown.stop="emit('tear')"
            />
        </div>
    </div>
</template>

<script setup lang="ts">
/**
 * 未拆封的标准 CD 盒 —— 一个受力的**物体**，不是一个会动的图标。
 *
 * ## 这一版和上一版的区别（2026-11-15 返工）
 *
 * 上一版用 CSS `transition` 描述"从 A 到 B"：不动时完全静止、鼠标动了才动、
 * 打开后"淡出"了事。参考站的包装**一直在呼吸**、跟着手转、打开后被牌堆**踢下去**。
 * 差别不在参数，在驱动方式（见 `docs/RETRO-LUCKY-VS-HOLO-2026-11-15.md`）。
 *
 * 现在：6 个弹簧（位置 3 + 旋转 3）逐帧积分，`t` 由 `useStage` 统一供给。
 * 三件事因此成立：① 静止时轻微呼吸；② 鼠标离开也带着残余速度回正；
 * ③ 打开时给一个初速就能自己掉下去。
 *
 * ## 它不负责的事
 * - 五张卡（在页面里，从盒心飞到扇形）
 * - 时间轴（`phase` 由页面推，组件内部没有任何计时器）
 * - 颜色（全部走 `tokens.css` 的 `--ff-*`）
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { FEEL, pose, stepAll, values } from '@/views/Lucky/spring';
import { useStage } from '@/views/Lucky/useStage';
import { tearPolygon } from '@/views/Lucky/discCase';

const props = defineProps<{
    phase: 'sealed' | 'opening' | 'open';
    /** 本次专辑的主题色。由页面每包随机给 —— 参考站"六种配色不连续重复"的等价物 */
    tint: 'a' | 'b' | 'c';
}>();
const emit = defineEmits<{ tear: [] }>();

const caseEl = ref<HTMLElement | null>(null);
const groundEl = ref<HTMLElement | null>(null);

/** 位置与朝向。静止时由一条缓慢正弦给它"活气"，不是死摆着 */
const P = pose({ x: 0, y: 0, rx: 0, ry: 0, rz: 0 }, ...FEEL.pointer);

const pointer = { nx: 0, ny: 0 };
/**
 * 盒子的**基础姿态**：略微左转 + 微微前倾。
 *
 * ⚠️ 这不是装饰。`rotateY(0)` 时书脊那面是 `rotateY(-90deg)`，正好侧对镜头 ——
 *    一条彩色都看不见，整盒读起来就是一张平面纸。给 -18° 之后左侧书脊与顶面同时露出来。
 *    它是常量而不是弹簧：弹簧只负责"在这个基础上再多转多少"。
 */
const BASE_RX = 3;
const BASE_RY = -18;
/** 开包后被牌堆踢下去的位移（null = 还没开始掉） */
let fall: { y: number; v: number } | null = null;
/** 多久之后盒子开始下落（秒）。卡片 320ms 起飞，盒子 240ms 后跟上 —— 顺序反了就是"盒子先没了" */
const FALL_DELAY = 0.24;
/** 到点开始下落的时刻（`t` 的坐标系；-1 = 还没排上） */
let fallAt = -1;
/** 上一帧的 phase，用来检测"刚刚进入 opening" */
let lastPhase = props.phase;
/** 盒子的像素尺寸（下落初速按它算，与屏幕大小无关） */
let size = 300;

const polyLeft = computed(() => tearPolygon('left', 12, 4));
const polyRight = computed(() => tearPolygon('right', 12, 4));

function clamp(v: number, a: number, b: number): number {
    return Math.min(b, Math.max(a, v));
}

const stage = useStage((dt, t) => {
    const el = caseEl.value;
    if (!el) return;

    // ── 目标姿态 ──────────────────────────────────────────────────
    // 静止时上下呼吸 7px；撕开/开包时收小，因为"它正被按着"
    const breath = props.phase === 'sealed' ? 7 : 2;
    P.y.to = Math.sin(t * 1.4) * breath;
    // 跟手：水平 ±22°、垂直 ±16°；打开后减半（盒子已经不属于手了）
    const follow = props.phase === 'sealed' ? 1 : 0.35;
    P.ry.to = pointer.nx * 22 * follow;
    P.rx.to = -pointer.ny * 16 * follow;
    // 极慢的侧倾，像被放在桌上没放平
    P.rz.to = Math.sin(t * 0.9) * 1.6;

    stepAll(values(P), dt);

    // ── 下落：卡片先射出，盒子随后被踢开 ──────────────────────────
    if (props.phase !== lastPhase) {
        lastPhase = props.phase;
        if (props.phase === 'opening') fallAt = t + FALL_DELAY;
    }
    if (!fall && fallAt >= 0 && t >= fallAt) {
        fall = { y: 0, v: (1500 * size) / 420 };
    }
    if (fall) {
        fall.v += 2600 * dt;
        fall.y += fall.v * dt;
        // 掉下去的过程中是"翻着"落的，不是平着平移
        P.rz.to = 9;
    }

    const fy = fall ? fall.y : 0;
    el.style.transform =
        `translate3d(${P.x.x.toFixed(2)}px, ${(P.y.x + fy).toFixed(2)}px, 0) ` +
        `rotateX(${(P.rx.x + BASE_RX).toFixed(2)}deg) rotateY(${(P.ry.x + BASE_RY).toFixed(2)}deg) ` +
        `rotateZ(${P.rz.x.toFixed(2)}deg)`;

    // ── 光照跟着朝向走：转向哪边，高光就滑向哪边 ──────────────────
    // 这一条是"它是实物"的关键：拿在手里转，反光会动；贴纸转，反光不动。
    el.style.setProperty('--gx', clamp(-P.ry.x * 0.12, -1.5, 3).toFixed(2));
    el.style.setProperty('--gt', clamp(0.85 + P.rx.x * 0.015, 0.5, 1).toFixed(2));

    // ── 地面投影：随浮动缩放，掉出屏幕后消失 ──────────────────────
    const ground = groundEl.value;
    if (ground) {
        const shrink = clamp(1 - P.y.x / 300, 0.6, 1.15);
        ground.style.transform = `translate3d(${P.x.x.toFixed(2)}px, 0, 0) scale(${shrink.toFixed(3)})`;
        ground.style.opacity = fall ? clamp(1 - fall.y / 160, 0, 1).toFixed(3) : '0.55';
    }
});

/** 鼠标在**整个舞台**上移动都要算：指针离开盒子边缘时不该突然"松手回正" */
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

onMounted(() => {
    size = caseEl.value?.offsetWidth || 300;

    if (!stage.reduce) {
        // 进场：从右侧旋转飞入（参考站同一手法）。只在首帧前摆好，随后交给弹簧收敛
        P.x.x = window.innerWidth * 0.62;
        P.y.x = -50;
        P.ry.x = -200;
        P.rz.x = 16;
    }
    stage.start();

    // 指针挂在 window 上：`.case-stage` 是 `pointer-events: none`（要让点击穿透到盒子），
    // 而且 3D 子层会吃掉边缘的 pointermove —— 挂 window 不会漏事件。
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerleave', onLeave);
});



onBeforeUnmount(() => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerleave', onLeave);
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
.rays {
    position: absolute;
    left: 50%;
    top: 44%;
    width: 46%;
    aspect-ratio: 1;
    translate: -50% -50%;
    border-radius: 50%;
    background: radial-gradient(closest-side,
        transparent 30%,
        var(--ff-foil-a) 46%,
        var(--ff-foil-b) 60%,
        var(--ff-foil-c) 72%,
        transparent 86%);
    opacity: 0;
    transform: translateZ(4px) scale(0.2);
    pointer-events: none;
    filter: blur(2px);
}

.is-opening .rays {
    animation: rays-out 560ms 100ms cubic-bezier(0.19, 1, 0.22, 1) forwards;
}

@keyframes rays-out {
    0% { opacity: 0; transform: translateZ(4px) scale(0.2); }
    35% { opacity: 0.78; }
    100% { opacity: 0; transform: translateZ(4px) scale(1.55); }
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

/* 两半膜朝各自方向飞走 */
.is-opening .film--l {
    transform: translate3d(-64%, -30%, 9px) rotate(-14deg);
    opacity: 0;
}

.is-opening .film--r {
    transform: translate3d(64%, -34%, 9px) rotate(12deg);
    opacity: 0;
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
