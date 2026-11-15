<template>
    <div class="case-stage">
        <div
            class="case"
            :class="`is-${phase}`"
            @pointermove="onMove"
            @pointerleave="onLeave"
        >
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
 * 未拆封的标准 CD 盒 —— 撕膜 / 掀盖 / 喷光。
 *
 * 它**只负责包装本身**：五张卡在页面里，由页面按 `phase` 控制飞出（卡片要从盒心飞到扇形
 * 落点，盒子与卡片必须共享同一个坐标系，所以不能把卡片塞进这里再交接 —— 那会闪一下）。
 *
 * `phase` 由页面驱动（`sealed` → `opening` → `open`），组件内部没有任何计时器：
 * 时间轴只有一份，在页面里。
 */
import { computed } from 'vue';
import { tearPolygon } from '@/views/Lucky/discCase';

defineProps<{ phase: 'sealed' | 'opening' | 'open' }>();

const emit = defineEmits<{ tear: [] }>();

/** 锯齿边的两条轮廓（纯函数，同一条线拼得回去） */
const polyLeft = computed(() => tearPolygon('left', 12, 4));
const polyRight = computed(() => tearPolygon('right', 12, 4));

/** 停在盒面上的鼠标位置，只做一点轻微倾斜 —— 幅度比卡片小一半，它是个"实物"不是卡牌 */
function onMove(ev: PointerEvent) {
    const el = ev.currentTarget as HTMLElement;
    const rect = el.getBoundingClientRect();
    const nx = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
    const ny = ((ev.clientY - rect.top) / rect.height) * 2 - 1;
    el.style.setProperty('--rx', (-ny * 4).toFixed(2) + 'deg');
    el.style.setProperty('--ry', (nx * 4).toFixed(2) + 'deg');
}

function onLeave(ev: PointerEvent) {
    const el = ev.currentTarget as HTMLElement;
    el.style.setProperty('--rx', '0deg');
    el.style.setProperty('--ry', '0deg');
}
</script>

<style scoped lang="less">
.case-stage {
    display: grid;
    place-items: center;
    /* 盒子必须压在扇形卡片之上：卡片在 sealed 阶段虽然 `opacity: 0`，但仍占着
       同一个中心格 —— 不给 z-index 的话盒子的点击区会被透明卡片盖住一半。 */
    z-index: 4;
    perspective: 1400px;
    perspective-origin: 50% 42%;
    pointer-events: none;
}

.case {
    --size: clamp(220px, 34vh, 320px);
    position: relative;
    width: var(--size);
    height: var(--size);
    transform-style: preserve-3d;
    transform: rotateX(var(--rx, 0deg)) rotateY(var(--ry, 0deg));
    transition: transform 420ms cubic-bezier(0.19, 1, 0.22, 1);
    pointer-events: auto;
    cursor: grab;
}

/* 掀开 780ms 后整个盒子淡出让位给卡片；`phase=open` 时父级会把它 v-if 掉 */
.case.is-opening {
    animation: case-away 520ms 900ms ease forwards;
}

@keyframes case-away {
    to {
        opacity: 0;
        transform: translateY(26px) scale(0.94);
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
    background: var(--ff-inner-paper);
    transform: translateZ(0);
    overflow: hidden;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    box-shadow: inset 0 0 0 1px var(--ff-line);
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
        var(--ff-disc-sheen), var(--ff-disc-face) 46%, var(--ff-inner-paper) 92%);
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

.brand {
    position: relative;
    margin: 7% 0 0 8%;
    font: 500 3.4cqw/1 var(--ff-font);
    letter-spacing: 0.28em;
    text-transform: uppercase;
    color: var(--ff-text-2);
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

/* 书脊：绕左边缘转 90°，`transform-origin: left` 让它贴着盒子左边立起来 */
.spine {
    position: absolute;
    left: 0;
    top: 0;
    width: 16px;
    height: 100%;
    transform-origin: left center;
    transform: rotateY(-90deg) translateZ(0);
    background: var(--ff-foil-b);
    overflow: hidden;
    display: grid;
    place-items: center;

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
    animation: rays-out 720ms 120ms cubic-bezier(0.19, 1, 0.22, 1) forwards;
}

@keyframes rays-out {
    0% { opacity: 0; transform: translateZ(4px) scale(0.2); }
    35% { opacity: 0.9; }
    100% { opacity: 0; transform: translateZ(4px) scale(2.6); }
}

/* ── 收缩膜 ────────────────────────────────────────────────────────────────
   ⚠️ 必须是**不透明的雾**：撕开前看不清里面，才有悬念；撕开后才"变清晰"。
      如果做成透明，撕膜这个动作在画面上等于没发生。 */
.film {
    position: absolute;
    inset: 0;
    transform: translateZ(9px);
    background:
        linear-gradient(154deg, transparent 62%, var(--ff-film-sheen) 63%, transparent 68%),
        linear-gradient(96deg, transparent 24%, var(--ff-film-sheen) 25%, transparent 30%),
        var(--ff-film-veil);
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
