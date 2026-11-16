<template>
    <div ref="stageEl" class="pack-stage">
        <div ref="groundEl" class="ground" aria-hidden="true" />

        <!--
            彩虹光流。⚠️ 两层，缺一层就会偏：
              · `.flow` 与包**同一个框**（承接包的三轴变换，所以它跟着包一起歪）；
              · `.rays` 才是撕口上方那块画布（`top: 10.5% − pw*.6`）。
            曾经把 svg 直接当 `.flow` 用 ⇒ 包一旋转，彩虹的旋转中心就落在自己身上
            （比包心高出一大截），看起来像"彩虹在滑"。
        -->
        <div ref="flowEl" class="flow" aria-hidden="true">
            <canvas ref="raysEl" class="rays" />
        </div>

        <div ref="packEl" class="pack" :class="`is-${phase}`" :style="{ '--pack': packColor }">
            <!-- 正面：撕口提示 + 金属边 + 品牌字 + 居中图形 + 底注 -->
            <div ref="frontEl" class="skin skin--front" aria-hidden="true">
                <span class="tear-hint">Tear here ⟶</span>
                <span class="lips"><i ref="lipEl" class="lip" /></span>
                <b class="mark">Finder</b>
                <span class="series">{{ skinLabel }}</span>
                <div class="orb">
                    <img class="shade" src="/characters/sparkle-body.webp" alt="">
                    <img class="body" src="/characters/sparkle-body.webp" alt="">
                    <i :ref="el => setEye(0, el)" class="eye eye--0">
                        <img :ref="el => setPupil(0, el)" class="pupil" src="/characters/sparkle-eyes-0.webp" alt="">
                    </i>
                    <i :ref="el => setEye(1, el)" class="eye eye--1">
                        <img :ref="el => setPupil(1, el)" class="pupil" src="/characters/sparkle-eyes-1.webp" alt="">
                    </i>
                    <img class="smile" src="/characters/sparkle-mouth.webp" alt="">
                    <img class="ouch" src="/characters/sparkle-ouch.webp" alt="">
                    <img class="drip" src="/characters/sparkle-sweat.webp" alt="">
                </div>
                <span class="foot foot--l">随机一包</span>
                <span class="foot foot--r">5 cards</span>
            </div>

            <!-- 背面：折边 + 小字说明 + 条码 -->
            <div ref="backEl" class="skin skin--back" aria-hidden="true">
                <i class="fin" />
                <b class="mark mark--sm">Finder</b>
                <p class="blurb">5 张已缓存封面<br>每次都不一样</p>
                <i class="code" />
            </div>

            <!--
                圆角鼓起的侧面：左右各 9 条薄片，沿"包厚度的圆"排开，越靠后越短、越暗。
                它才是"这是一只鼓起来的软包装"而不是"一张贴在背景上的图"的原因。
                撕开时被撕到的那一侧会连同顶部一起消失（`applyClips` 里抬 top）。
            -->
            <i
                v-for="(r, i) in RIMS"
                :key="r.key"
                :ref="el => setRim(i, el)"
                class="rim"
                :class="`rim--${r.side}`"
                :style="r.style"
                aria-hidden="true"
            />

            <!-- 撕条：切 12 片，逐片累积弯曲（越靠末端卷得越紧） -->
            <div ref="flapEl" class="flap" aria-hidden="true">
                <div v-for="k in PLIES" :key="k" :ref="el => setPly(k - 1, el)" class="ply" hidden>
                    <div class="skin skin--front ply-skin">
                        <!-- 提示字印在**撕条上**：撕下来那块带着 "Tear here" 一起走（同参考站） -->
                        <span class="tear-hint">Tear here ⟶</span>
                        <i class="lip ply-lip" />
                        <i class="tone" />
                    </div>
                    <div class="skin skin--foil">
                        <i class="tone" />
                    </div>
                </div>
            </div>

            <!--
                唯一的交互面：整只包（热区比包本身大一圈，人是从"上面"抓东西的）。
                没有外置按钮 —— 按一下就是整条撕开（`onUp` 里 `moved === false` 那条），
                横向拖则是跟手撕。提示只在 hover 时给，因为撕开这件事在画面上自明
                （包装正面就印着 "Tear here ⟶"）。
            -->
            <button
                class="hit"
                type="button"
                v-tip="hitTip"
                aria-label="撕开这包：横向拖动撕开，或按一下直接撕"
                @pointerdown.stop="onDown"
                @pointermove.stop="onMove"
                @pointerup.stop="onUp"
                @pointercancel.stop="onUp"
                @lostpointercapture.stop="onUp"
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
import { computed, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref } from 'vue';
import { FEEL, Spring, pose, stepAll, values } from '@/views/Lucky/spring';
import { useStage } from '@/views/Lucky/useStage';
import {
    PLIES, bandOf, mirror, plyEdge, plyOutline, restOutline, toPolygon, yAt,
} from '@/views/Lucky/tearPath';
import type { JagPoint, Pt } from '@/views/Lucky/tearPath';
import { createJag, steer } from '@/views/Lucky/tearPath';
import { RainbowFlow } from '@/views/Lucky/flow';
import { PACK_SKINS, buildRims, paintLight } from '@/views/Lucky/packSkin';
import type { PackRim } from '@/views/Lucky/packSkin';
import { voices, wakeVoices } from '@/views/Lucky/voices';
import { hideTip } from '@/components/FluidTip/fluidTip';

const props = defineProps<{
    phase: 'sealed' | 'opening' | 'open';
    /** 皮肤 key（`cobalt` / `ember` / …），由页面每包换一个且不与上一包重复 */
    skin: string;
}>();

const emit = defineEmits<{ opened: [] }>();

const RIMS: PackRim[] = buildRims();

const stageEl = ref<HTMLElement | null>(null);
const packEl = ref<HTMLElement | null>(null);
const groundEl = ref<HTMLElement | null>(null);
const frontEl = ref<HTMLElement | null>(null);
const backEl = ref<HTMLElement | null>(null);
const flapEl = ref<HTMLElement | null>(null);
const lipEl = ref<HTMLElement | null>(null);
const flowEl = ref<HTMLElement | null>(null);
const raysEl = ref<HTMLCanvasElement | null>(null);
const plyEls: HTMLElement[] = [];
const rimEls: HTMLElement[] = [];
const eyeEls: HTMLElement[] = [];
const pupilEls: HTMLElement[] = [];

function setEye(index: number, el: unknown): void {
    if (el instanceof HTMLElement) eyeEls[index] = el;
}

function setPupil(index: number, el: unknown): void {
    if (el instanceof HTMLElement) pupilEls[index] = el;
}

/**
 * 每片撕条要写的五个子元素。
 *
 * ⚠️ 必须缓存：`clips()` 每帧对 12 片各做 5 次 `querySelector` = 60 次选择器求值 / 帧，
 *    而且是在一个会重排的 3D 子树里 —— 这是纯浪费（参考站是先把引用存下来的）。
 */
interface PlyParts { face: HTMLElement; foil: HTMLElement; lip: HTMLElement; toneF: HTMLElement; toneV: HTMLElement }
const plyParts: (PlyParts | null)[] = [];

function indexPlies(): void {
    plyEls.forEach((el, i) => {
        const face = el?.querySelector('.ply-skin') as HTMLElement | null;
        const foil = el?.querySelector('.skin--foil') as HTMLElement | null;
        const lip = el?.querySelector('.ply-lip') as HTMLElement | null;
        const toneF = el?.querySelector('.ply-skin .tone') as HTMLElement | null;
        const toneV = el?.querySelector('.skin--foil .tone') as HTMLElement | null;
        plyParts[i] = face && foil && lip && toneF && toneV ? { face, foil, lip, toneF, toneV } : null;
    });
}

/** 撕条是否已索引（见 `ensurePlies`） */
let pliesIndexed = false;

/**
 * 索引 12 片撕条的子元素 —— **第一次撕之前一秒都不需要**。
 *
 * ⚠️ 60 次 `querySelector` 是一场会重排的 3D 子树里的选择器求值，放在 `onMounted` 就是
 *    压在入场首帧上（参考站 `spawn`/`enter` 都不做这件事）。撕到 0 以后第一次调用时再来。
 */
function ensurePlies(): void {
    if (pliesIndexed) return;
    pliesIndexed = true;
    indexPlies();
}

/**
 * 封包态：把上一次撕开的痕迹抹干净。
 *
 * ⚠️ 源项目 `enter()` 是 `clipPath = ''`，不是"再写一个覆盖整包的多边形"。
 *    我们曾经在封包态给正/背面各挂一条 96 点多边形 `clip-path`：那一秒它一点用都没有，
 *    但每一次绘制都得带着它跑一遍多边形遮罩 —— 包括入场的那一次首绘。
 */
function resetFaceClips(): void {
    if (frontEl.value) frontEl.value.style.clipPath = '';
    if (backEl.value) backEl.value.style.clipPath = '';
    if (lipEl.value) lipEl.value.style.clipPath = '';
    if (flapEl.value) flapEl.value.style.transformOrigin = '';
    for (let i = 0; i < RIMS.length; i += 1) {
        const el = rimEls[i];
        if (el) el.style.top = `${RIMS[i].baseTop.toFixed(2)}%`;
    }
}

const packColor = computed(() => `var(--ff-pack-${props.skin})`);
const skinLabel = computed(() => PACK_SKINS.find(s => s.key === props.skin)?.label ?? '');

/** 姿态：位置 3 + 旋转 3 */
const P = pose({ x: 0, y: 0, rx: 0, ry: 0, rz: 0 }, ...FEEL.pointer);
/** 吉祥物注视弹簧（移植自 holo-reverse 的 eye = pose({ x: 0, y: 0 }, 0.18, 0.3)） */
const eye = pose({ x: 0, y: 0 }, 0.18, 0.3);
/** 撕裂进度 */
const tearP = new Spring(0, 0.1);
/** 撕条整体的两个转角（Z 摆动 / X 翻起） */
const tearTh = new Spring(0, 0.28, 0.35);
const tearPh = new Spring(0, 0.3, 0.2);
/** 被捏住的紧绷感（抓住时 1，撕开后 0） */
const squeeze = new Spring(0, 0.3, 0.45);

const jag: JagPoint[] = createJag();
const mouthY = Math.max(...jag.map(q => q.y));
let tearDir: 1 | -1 = 1;
let flow: RainbowFlow | null = null;
/** 这一条撕条的卷曲程度（每包一个）—— 参考站的 `tear.roll` */
const tearRoll = 0.65 + Math.random() * 0.75;
/** 手把未撕那半压下去的量（参考站 `drag.k`，逐帧向目标插值，不直接跟手） */
let steerK = 0;
/** 这一道撕口是否已经开始（决定 eep / phew / boing 三个音） */
let started = false;

let fly: { x: number; y: number; vx: number; vy: number; th: number; vth: number; ph: number; vph: number } | null = null;
let fall: { y: number; v: number } | null = null;
let fallAt = -1;
let lastPhase = props.phase;
let openedFired = false;
/** 下一次"自己抖一下"的时刻（秒，`t` 坐标系） */
let nudgeAt = 5;
/** 下一次自然眨眼的时刻（秒，`t` 坐标系） */
let blinkAt = 2.5;

function blink(list: HTMLElement[], times = 1): void {
    for (const e of list) {
        if (!e) continue;
        e.animate(
            [
                { scale: '1 1' },
                { scale: '1 0.08' },
                { scale: '1 1' },
            ],
            {
                duration: 170,
                iterations: times,
                easing: 'cubic-bezier(0.77, 0, 0.175, 1)',
            },
        );
    }
}

/** 上一帧的撕裂进度，用来算"这一帧撕了多少" */
let tearLast = 0;
let openedAt = 0;
let pw = 280;
let ph = 405;
/** 包心到容器四边的距离（px）—— 光流用它决定能长多高、多宽 */
let box = { left: 600, right: 600, top: 400, bottom: 400 };
/** 包落下后光流"扶正"用的锚点（参考站 `anchor`） */
const anchor = { y: 0, rz: 0, rx: 0, ry: 0, sq: 0 };

/**
 * 上一帧写进 DOM 的字符串。
 *
 * ⚠️ 值没变就别碰 `style`：自定义属性一写就会让整棵子树重算样式 + 重绘箔面，
 *    而静置时这四个数只在小数点后第 2~3 位蠕动 —— 抖动一下也不该换来一次全量重绘。
 */
const last = { tf: '', gx: '', gl: '', gt: '', gm: '', sh: '' };

const pointer = { x: 0, y: 0, nx: 0, ny: 0, in: false };
interface DragState { id: number; x0: number; y0: number; p0: number; moved: boolean; dy: number }
let drag: DragState | null = null;

function clamp(v: number, a: number, b: number): number {
    return Math.min(b, Math.max(a, v));
}

function setPly(index: number, el: unknown): void {
    if (el instanceof HTMLElement) plyEls[index] = el;
}

function setRim(index: number, el: unknown): void {
    if (el instanceof HTMLElement) rimEls[index] = el;
}

/**
 * 把当前撕口应用到 DOM —— 整段移植自参考站的 `clips()`。
 *
 * 这一步是"撕"的全部：两片 skin 的轮廓、金属亮边的轮廓、撕条整体的铰点、
 * 以及 12 片撕条的裁切与累积弯曲。**没有任何动画曲线**，全是当前状态的几何。
 */
/** 每片撕条的裁剪形状缓存（一旦撕口越过该片，其多边形永不再变，对齐源项目 s.done 避免密集 DOM 重算） */
const plyDone = new Array<boolean>(PLIES).fill(false);

function applyClips(p: number): void {
    if (p <= 0) {
        plyDone.fill(false);
        resetFaceClips();
        return;
    }
    ensurePlies();
    const d = tearDir;
    const xt = d > 0 ? p * 100 : 100 - p * 100;
    const yt = yAt(jag, xt);

    // 正面 / 背面：剩下那块 + 已撕掉的上半部分
    const rest = restOutline(jag, p, d);
    if (frontEl.value) frontEl.value.style.clipPath = toPolygon(rest);
    if (backEl.value) backEl.value.style.clipPath = toPolygon(mirror(rest));

    // 撕口那条金属亮边：沿撕口的一条细带，宽度逐点不同
    const torn = jag.filter(q => (d > 0 ? q.x < xt : q.x > xt));
    const edge: Pt[] = d > 0
        ? [...torn.map(q => [q.x, q.y] as Pt), [xt, yt]]
        : [[xt, yt], ...torn.map(q => [q.x, q.y] as Pt)];
    if (lipEl.value) lipEl.value.style.clipPath = toPolygon(bandOf(edge, 1, torn.map(q => q.metal).concat(1)));

    // 撕条的铰点在撕口尖端
    if (flapEl.value) flapEl.value.style.transformOrigin = `${xt}% ${yt}%`;

    // 圆角侧面：被撕到的那一侧（侧边已经落在撕口之后）连同顶部一起消失
    // —— 缺这一步，撕开的口子两端会挂着两片鼓起的边，像没撕干净
    for (let i = 0; i < RIMS.length; i += 1) {
        const rim = RIMS[i];
        const el = rimEls[i];
        if (!el) continue;
        if (p <= 0) {
            el.style.top = `${rim.baseTop.toFixed(2)}%`;
            continue;
        }
        const side = rim.side === 'r' ? 100 : 0;
        if (d > 0 ? side <= xt : side >= xt) {
            el.style.top = `${Math.max(rim.baseTop, yAt(jag, side) + 1.4).toFixed(2)}%`;
        }
    }

    // 12 片撕条：每片的裁切 + 累积变换
    const w = 100 / PLIES;
    const lap = 0.25;
    const k0 = clamp(Math.floor((d > 0 ? xt - 1e-6 : xt) / w), 0, PLIES - 1);
    const bend = (2.6 + 2.6 * p) * tearRoll;
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
        if (plyDone[k]) continue;

        // ⚠️ 两端不加重叠：撕口尖端那片要正好收到尖端，否则会多出一小截伸出撕口
        const L = d < 0 && lo === xt ? lo : Math.max(0, lo - lap);
        const R = d > 0 && hi === xt ? hi : Math.min(100, hi + lap);
        const parts = plyParts[k];
        if (!parts) continue;
        const outline = plyOutline(jag, L, R);
        parts.face.style.clipPath = toPolygon(outline);
        parts.foil.style.clipPath = toPolygon(mirror(outline));
        parts.lip.style.clipPath = toPolygon(bandOf(plyEdge(jag, L, R), -1, jag.filter(q => q.x > L && q.x < R).map(q => q.metal).concat(1)));
        plyDone[k] = d > 0 ? hi < xt || xt >= 100 : lo > xt || xt <= 0;
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
            const parts = plyParts[k];
            if (parts) {
                parts.toneF.style.opacity = Math.min(0.5, Math.abs(sum) / 200).toFixed(2);
                parts.toneV.style.opacity = Math.max(0, 0.34 - Math.abs(sum) / 420).toFixed(2);
            }
        }
    }
}

/** 当前时间（给撕条抖动用；`applyClips` 里要读它） */
let taf = 0;

/**
 * 当前姿态 → `transform` 字符串。
 *
 * ⚠️ 入场要分成两帧：先"插进来 + 首布局 + 首绘"，下一帧弹簧才起跑。所以挂载那一帧
 *    必须自己把起始姿态写进 `style` —— 否则包会先以默认位姿（舞台正中）闪一下。
 *    两份实现迟早会飘，故循环与挂载共用这一份。
 */
function poseTransform(fy: number, sq: number): string {
    return `translate3d(${P.x.x.toFixed(2)}px,${(P.y.x + fy).toFixed(2)}px,0) `
        + `rotateX(${P.rx.x.toFixed(2)}deg) rotateY(${P.ry.x.toFixed(2)}deg) `
        + `rotateZ(${P.rz.x.toFixed(2)}deg) scale3d(${(1 + 0.03 * sq).toFixed(3)},${(1 - 0.06 * sq).toFixed(3)},1)`;
}

/**
 * 入场旋转期间不画 18 条侧面。
 *
 * ⚠️ 探针实测（`docs/probes/lucky-entry/entry-cost.cjs`，同页面只改一处、各跑 1.4s）：
 *    459px 宽下带着这 18 条 `clip-path` 侧面飞入，p50 = 33ms、32 帧 >24ms；
 *    把 `clip-path` 去掉（形状仍在、只是变成矩形）立刻回到 p50 = 16.7ms、0 帧超过 24ms。
 *    单去掉 `translateZ` 无效 ⇒ 凶手是**多边形遮罩**：父级 perspective 旋转每一帧都在改
 *    投影尺寸，每条带 clip 的图层都要重光栅一次，18 条一起就是 18 份。
 *
 * 旋转时它们本来就贴在包侧、几乎正好侧对视线（`-200° → 0`），看不见；
 * 等转到 `|ry| < 20°` 再显形，形状一个点都没改。
 */
let rimHidden = false;

function setRimsHidden(hide: boolean): void {
    if (rimHidden === hide) return;
    rimHidden = hide;
    packEl.value?.classList.toggle('is-spin', hide);
}

const stage = useStage((dt, t) => {
    const el = packEl.value;
    if (!el) return;
    taf = t;

    // ── 撕裂 ────────────────────────────────────────────────
    stepAll([tearP, tearTh, tearPh, squeeze], dt);
    const p = clamp(tearP.x, 0, 1);

    /**
     * 撕动一下 → 整包抖一下、光带往前涌一截、攥紧一点。
     *
     * 这是"撕开"和"彩虹"之间唯一的耦合点（参考站同一处：`dp` 驱动四根弹簧）。
     */
    const dp = p - tearLast;
    tearLast = p;
    // 手停住时撕口形状和上一帧一样 ⇒ 不重写（参考站：`dp > 0 || |v| > .001`）
    if (p > 0 && (dp > 0 || Math.abs(tearP.v) > 0.001)) applyClips(p);

    // 撕裂声：音量 = 这一帧撕了多少 ÷ dt。慢拉是零星脆响，一甩就是一声长撕
    if (props.phase === 'sealed' && p > 0) {
        voices()?.rip(dp > 0 ? (dp / Math.max(dt, 0.004) / 4) ** 0.6 : 0);
    }

    if (dp > 0 && !stage.reduce) {
        const seed = Math.min(dp, 0.02);
        P.rz.v += (Math.random() - 0.5) * seed * 900;
        P.y.v += dp * 420;
        tearTh.v += dp * 300;
        squeeze.v += dp * 20;
        flow?.kick(dp);
    }
    if (fly) {
        fly.vy += 2600 * dt;
        fly.x += fly.vx * dt;
        fly.y += fly.vy * dt;
        fly.th += fly.vth * dt;
        fly.ph += fly.vph * dt;
        if (flapEl.value) {
            flapEl.value.style.transform =
                `translate3d(${fly.x.toFixed(1)}px,${fly.y.toFixed(1)}px,0) `
                + `rotateZ(${(fly.th * tearDir).toFixed(1)}deg) rotateX(${fly.ph.toFixed(1)}deg)`;
        }
        if (t - openedAt > 1.6) {
            fly = null;
            if (flapEl.value) flapEl.value.className = 'flap';
        }
    } else if (flapEl.value) {
        // 松手后撕条在"从撕口吹出的气流"里飘：两个不同频率的正弦叠加
        const draft = drag ? 0 : (Math.sin(t * 5.3) + Math.sin(t * 8.7) * 0.5) * (p > 0 && p < 1 ? 1 : 0);
        flapEl.value.style.transform =
            `rotateZ(${((tearTh.x + draft) * tearDir).toFixed(2)}deg) rotateX(${(tearPh.x + draft * 1.5).toFixed(2)}deg)`;
    }
    if (p > 0.985 && tearP.to >= 1) openPack(t);

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

    /**
     * ⚠️ 姿态目标**只在封着的时候算**（参考站的 `state === 'enter' || 'idle'` 分支）。
     * 开包之后还继续跟鼠标 ⇒ 包被踢下去的同时还在扭头，看起来像"被拽着走"。
     */
    if (props.phase === 'sealed') {
        P.y.to = Math.sin(t * 1.4) * 7 + tug;
        P.ry.to = nx * 22 * hold;
        P.rx.to = -ny * 16 * hold - squeeze.x * 6;
        P.rz.to = Math.sin(t * 0.9) * 1.6 - (p > 0 && p < 1 ? tearDir * p * 3 : 0);

        /**
         * 没人碰它的时候，过几秒自己抖一下（像放在桌上被风带了一下）。
         * 这是"它是个活物"的最后一笔：一个完全静止的物体在动效里读作"图"。
         */
        if (!drag && tearP.to < 1 && !stage.reduce && t > nudgeAt) {
            P.rz.v += (Math.random() < 0.5 ? -1 : 1) * 70;
            if (tearP.to > 0) tearTh.v += 120;
            nudgeAt = t + 4 + Math.random() * 3;
        }

        // 自然眨眼（偶发连眨两下，对齐源项目）
        if (t > blinkAt) {
            blinkAt = t + 2.2 + Math.random() * 3.3;
            if (!stage.reduce && !packEl.value?.classList.contains('is-held')) {
                blink(eyeEls, Math.random() < 0.25 ? 2 : 1);
            }
        }
    }

    stepAll(values(P), dt);

    // 转到侧面不再正对视线的角度，就把那 18 条侧面放出来（见 `setRimsHidden`）
    if (rimHidden && Math.abs(P.ry.x) < 20) setRimsHidden(false);

    // 吉祥物瞳孔注视追踪与回弹
    if (pointer.in && !fall) {
        const dx = pointer.x - (window.innerWidth / 2 + P.x.x);
        const dy = pointer.y - (window.innerHeight / 2 + P.y.x - ph * 0.02);
        const dl = Math.hypot(dx, dy) || 1;
        const k = Math.min(1, dl / 260) * pw * 0.014;
        eye.x.to = (dx / dl) * k;
        eye.y.to = (dy / dl) * k;
    } else {
        eye.x.to = 0;
        eye.y.to = 0;
    }
    stepAll(values(eye), dt);
    for (const pEl of pupilEls) {
        if (pEl) pEl.style.transform = `translate(${eye.x.x.toFixed(2)}px,${eye.y.x.toFixed(2)}px)`;
    }

    if (props.phase !== lastPhase) {
        lastPhase = props.phase;
        // 包只在该掉的时候掉：参考站是开包后 20ms，不是等半个秒
        if (props.phase === 'opening') fallAt = stage.reduce ? -1 : t + 0.02;
    }
    if (!fall && fallAt >= 0 && t >= fallAt) fall = { y: 0, v: (1500 * ph) / 420 };
    if (fall) {
        // ⚠️ 掉出屏幕就停：不设上界的话 `fall.y` 会一直涨，transform 里的数字越滚越大，
        //    而元素早就不在画面里了 —— 白算（参考站到 `innerHeight` 就把包藏起来）
        if (fall.y < window.innerHeight) {
            fall.v += 2600 * dt;
            fall.y += fall.v * dt;
        }
        P.rz.to = tearDir * 9;
    }

    const fy = fall ? fall.y : 0;
    const sq = squeeze.x;
    const xf = poseTransform(fy, sq);
    if (xf !== last.tf) {
        last.tf = xf;
        el.style.transform = xf;
    }

    // 光照跟着朝向走：转向哪边，封边下方那道高光就滑向哪边（值没变就不写，见 `last`）
    const gx = clamp(-P.ry.x * 0.12, -1.5, 3).toFixed(2);
    if (gx !== last.gx) { last.gx = gx; el.style.setProperty('--gx', gx); }
    const gl = clamp(0.8 - P.ry.x * 0.012, 0.45, 1).toFixed(2);
    if (gl !== last.gl) { last.gl = gl; el.style.setProperty('--gl', gl); }
    const gt = clamp(0.85 + P.rx.x * 0.015, 0.5, 1).toFixed(2);
    if (gt !== last.gt) { last.gt = gt; el.style.setProperty('--gt', gt); }
    const gm = clamp(50 + P.ry.x * 1.2, 20, 80).toFixed(1);
    if (gm !== last.gm) { last.gm = gm; el.style.setProperty('--gm', gm); }
    const sh = clamp(P.ry.x * 1.2 + P.rx.x * 0.8, -22, 22).toFixed(1);
    if (sh !== last.sh) { last.sh = sh; el.style.setProperty('--sh', sh); }

    // 光流跟着包走，直到包掉下去；掉下去之后它留在原地、把倾斜慢慢扶正（参考站 `anchor`）
    if (!fall) {
        anchor.y = P.y.x;
        anchor.rz = P.rz.x;
        anchor.rx = P.rx.x;
        anchor.ry = P.ry.x;
        anchor.sq = sq;
        if (flowEl.value) flowEl.value.style.transform = xf;
    } else if (Math.abs(anchor.rz) + Math.abs(anchor.rx) + Math.abs(anchor.sq) > 0.01) {
        const k = Math.exp(-dt / 0.05);
        anchor.rz *= k;
        anchor.rx *= k;
        anchor.ry *= k;
        anchor.sq *= k;
        if (flowEl.value) {
            flowEl.value.style.transform =
                `translate3d(${P.x.x.toFixed(2)}px,${anchor.y.toFixed(2)}px,0) `
                + `rotateX(${anchor.rx.toFixed(2)}deg) rotateY(${anchor.ry.toFixed(2)}deg) rotateZ(${anchor.rz.toFixed(2)}deg) `
                + `scale3d(${(1 + 0.03 * anchor.sq).toFixed(3)},${(1 - 0.06 * anchor.sq).toFixed(3)},1)`;
        }
    }

    flow?.tick({
        t, dt,
        reduce: stage.reduce,
        tearP: p,
        tearDir,
        tearing: p > 0 && p < 1,
        opened: openedFired,
        openedAt,
        anchorRz: anchor.rz,
    });

    // 地面投影
    const ground = groundEl.value;
    if (ground) {
        ground.style.transform = `translate3d(${P.x.x.toFixed(2)}px,${(ph / 2 + 26).toFixed(0)}px,0) scale(${clamp(1 - P.y.x / 300, 0.6, 1.15).toFixed(3)})`;
        ground.style.opacity = fall ? clamp(1 - fall.y / 160, 0, 1).toFixed(3) : clamp(1 - Math.abs(P.x.x) / 300, 0, 1).toFixed(3);
    }
});

/**
 * 撕到底：收尾（参考站的 `open()`）。
 *
 * 四件事缺一不可：
 *   ① 撕口抹到 1（弹簧可能停在 .99）；
 *   ② 撕裂声归零、放"爆开"；
 *   ③ **把包摆平** —— 卡片要从正上方出去，包还歪着就斜着吐；
 *   ④ 反冲（往上顶一下、绕 Z 拧一下），这是"整包被扯开"的物理回执。
 */
function openPack(t: number): void {
    if (openedFired) return;
    openedFired = true;
    openedAt = t;
    tearP.x = tearP.to = 1;
    applyClips(1);
    voices()?.rip(0);
    voices()?.pop(!stage.reduce);
    P.rx.set(0.3);
    P.ry.set(0.3);
    P.rx.to = 0;
    P.ry.to = 0;
    if (!stage.reduce) {
        fly = {
            x: 0,
            y: 0,
            vx: tearDir * 240,
            vy: -1900,
            th: tearTh.x,
            vth: 520,
            ph: tearPh.x,
            vph: -320,
        };
        flapEl.value?.classList.add('is-open');
        P.y.v += 320;
        P.rz.v -= tearDir * 40;
    }
    releasePack();
    emit('opened');
}

function startTear(): void {
    ensureFlow();
    if (!started) {
        started = true;
        voices()?.eep();
    }
    flapEl.value?.classList.add('is-open');
    packEl.value?.classList.remove('is-tug');
    packEl.value?.classList.add('is-held', 'is-hurt');
}

/** 松手/结束：把"被抓住"与受痛状态摘掉（光标回到 grab） */
function releasePack(): void {
    packEl.value?.classList.remove('is-held', 'is-hurt', 'is-tug');
}

/** 撕条收尾的两个角（参考站的 `finish()`：这两个值是随机的，不是定值） */
function finishTear(response: number): void {
    tearP.set(response);
    tearP.to = 1;
    tearTh.to = 14 + Math.random() * 16;
    tearPh.to = -(20 + Math.random() * 24);
}

// ── 撕：按下 / 拖动 / 抬手 ────────────────────────────────────
/**
 * 唯一的操作提示（hover 才出现）。
 *
 * 只标**真绑定过键盘**的键：空格在页面里确实撕包，所以给键帽；横向拖动没有键，
 * 写进正文。撕开之后包会被摘掉，这个 computed 不必再考虑 `open` 阶段。
 *
 * `used` 是"动过一次手就永久收掉"：`<button>` 在 pointerdown 之后会拿到焦点，
 * 而 `v-tip` 的 focus 也会 `showTip`（延迟 150ms）——
 * 只调一次 `hideTip()` 挡不住它，必须让绑定值本身变空。
 */
const used = ref(false);
const hitTip = computed(() =>
    used.value || props.phase !== 'sealed'
        ? ''
        : {
            text: '撕开这一包 · 也可以横向拖',
            keys: 'Space',
            offsetY: 24,
            anchorEl: stageEl.value,
        },
);

function onDown(ev: PointerEvent) {
    wakeVoices();
    // 一旦上手就把提示收掉：跟手撕的全程它都挂在包上会一直挡着撕口
    used.value = true;
    hideTip();
    if (props.phase !== 'sealed') return;
    (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
    drag = { id: ev.pointerId, x0: ev.clientX, y0: ev.clientY, p0: tearP.to, moved: false, dy: 0 };
    steerK = 0;
    started = false;
    voices()?.grab();
}

function onMove(ev: PointerEvent) {
    if (!drag || ev.pointerId !== drag.id) return;
    // 按键在页面外松开：pointerup 收不到，靠"移动时没有按键"兜住，否则会一直粘在手上
    if (ev.pointerType === 'mouse' && !ev.buttons) {
        onUp(ev);
        return;
    }
    const dx = ev.clientX - drag.x0;
    let dy = ev.clientY - drag.y0;
    drag.dy = dy;
    if (!drag.moved) {
        if (Math.hypot(dx, dy) < 6) return;
        drag.moved = true;
        tearP.set(0.1);
        packEl.value?.classList.add('is-tug');
    }
    // 真的往侧面拖够远了，才决定从哪头撕。此时把纵向基准挪到手现在的位置：
    // 之前那段上下位移是"拉包"，不该继续算进撕条的翻起角
    if (tearP.to === 0) {
        if (Math.abs(dx) < 8 || Math.abs(dx) < Math.abs(dy) * 0.5) return;
        tearDir = dx < 0 ? -1 : 1;
        drag.y0 = ev.clientY;
        dy = 0;
    }
    startTear();
    tearP.to = clamp(drag.p0 + (drag.p0 ? Math.abs(dx) : dx * tearDir) / (pw * 0.85), tearP.to, 1);
    // 撕条跟着手的上下起伏：往下拉它下潜、往上提它翻起
    tearTh.to = 6 + tearP.to * 14 + clamp(-dy * 0.16, -6, 22);
    tearPh.to = -(8 + tearP.to * 22) - clamp(-dy * 0.2, 0, 24);
    // 未撕的部分整片跟着手弯。⚠️ 目标值先钳到 ±.7 再乘 `pw/ph`（参考站同一行），
    // 并且**逐帧向它插值**（`.3`）：直接跟手会让撕口像被钳子夹着抖
    steerK += (clamp(dy / Math.max(60, Math.abs(dx)), -0.7, 0.7) * pw / ph - steerK) * 0.3;
    steer(jag, tearP.to, tearDir, steerK);
}

function onUp(ev?: PointerEvent) {
    if (!drag) return;
    if (ev && ev.pointerId !== drag.id) return;
    const moved = drag.moved;
    drag = null;
    if (!moved) {
        // 单击整条撕开：进入撕裂态并撕到底
        if (tearP.to === 0) tearDir = Math.random() < 0.5 ? -1 : 1;
        startTear();
        finishTear(0.55);
        return;
    }
    if (tearP.to > 0.55) {
        // 拖动撕过半：顺势撕到底，保持 is-held 动画
        startTear();
        finishTear(0.18);
        return;
    }
    // 未撕完松手：解开抓住状态，撕条松弛下来
    releasePack();
    voices()?.[started ? 'phew' : 'boing']();
    // 松手停在中途：撕条松弛下来，留着那道半撕的口子
    tearTh.to = 3 + tearP.to * 10;
    tearPh.to = -tearP.to * 14;
}

function tearAll() {
    wakeVoices();
    if (props.phase !== 'sealed') return;
    if (tearP.to === 0) tearDir = Math.random() < 0.5 ? -1 : 1;
    startTear();
    finishTear(0.55);
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
        // 包口 = 撕口最深处的那个点，相对包中心（创建时预先算好，避免每帧 96 次 map）
        mouth: ph * (mouthY / 100 - 0.5),
        mouthY,
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
    pointer.x = ev.clientX;
    pointer.y = ev.clientY;
    pointer.nx = clamp((ev.clientX / window.innerWidth) * 2 - 1, -1, 1);
    pointer.ny = clamp((ev.clientY / window.innerHeight) * 2 - 1, -1, 1);
}

function onPointerLeave() {
    pointer.in = false;
}

/**
 * 量两个东西：包自己的尺寸，和"包心到舞台四边"的距离。
 *
 * ⚠️ 后者必须量**舞台**（`.stage`），不是窗口：舞台上下有顶栏/底栏，包心比窗口
 * 中心低几十像素。用窗口算，光流会提前收尾，上面留一条白。
 */
function measure() {
    const el = packEl.value;
    const wrapper = stageEl.value;
    if (!el || !wrapper) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    /**
     * ⚠️ 量不到就**什么都不写**，别拿 280 / 405 顶上去。
     *
     * 空闲回收会在这个页面被 KeepAlive 收起时挂载卡包，那时 `offsetWidth` 是 0 ——
     * 兜底值会让光流可达高度、裁剪换算、地面投影全按一个不存在的尺寸算，且无声无息。
     * 激活时 `onActivated` 会再量一次，那次才是真的。
     */
    if (!w || !h) return;
    pw = w;
    ph = h;
    el.style.setProperty('--tooth', `${(pw / 26).toFixed(2)}px`);

    const r = wrapper.getBoundingClientRect();
    const host = (wrapper.closest('.stage') as HTMLElement | null)?.getBoundingClientRect() ?? r;
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    box = {
        left: Math.max(0, cx - host.left),
        right: Math.max(0, host.right - cx),
        top: Math.max(0, cy - host.top),
        bottom: Math.max(0, host.bottom - cy),
    };
}

/** 光流的画布尺寸/几何是否已经算过（`onMounted` 里刻意不算，见那里的注释） */
let flowSized = false;

/** 第一次撕之前把光流的几何与画布备好（分配后台缓冲 + 生成这一包的条带） */
function ensureFlow(): void {
    if (!flow || flowSized) return;
    flowSized = true;
    flow.setSize(pw, ph, box);
}

function onResize() {
    const next = packEl.value?.offsetWidth || 0;
    if (Math.abs(next - pw) < 1) return;
    measure();
    // 没算过就等 `ensureFlow` 用新尺寸算；`measure()` 已经把 pw/ph/box 更新了
    if (flowSized) flow?.setSize(pw, ph, box);
    if (tearP.x > 0) applyClips(Math.min(1, tearP.x));
}

onMounted(() => {
    /**
     * 封包态只需要"没有撕痕"，不需要"先把撕痕算出来"。
     *
     * ⚠️ 这里曾经是 `indexPlies()` + `applyClips(0)`：60 次 `querySelector` 索引 12 片撕条，
     *    再给正/背面各写一条 96 点多边形的 `clip-path`。两样都只在撕开之后才有意义，
     *    却全压在入场首帧上（参考站 `enter()` 是把 `clipPath` 清成空，什么都不算）。
     */
    resetFaceClips();

    // 这一包的光影现场画（封边褶皱高光 + 底部暗褶），设置在父级包体上，由 .skin 继承
    const light = paintLight();
    if (packEl.value) {
        packEl.value.style.setProperty('--shine', light.shine);
        packEl.value.style.setProperty('--shade', light.shade);
    }

    /**
     * ⚠️ 光流的画布**不在入场帧分配**：撕开之前它一丝都不显示（`RainbowFlow.tick` 没有条带
     *    就直接返回），而 `setSize` 要算几何 + 分配一块几十万像素的后台缓冲。
     *    留到第一次撕（`ensureFlow`）—— 那时用户的手已经在动，几毫秒没人看得出来。
     */
    if (raysEl.value) flow = new RainbowFlow(raysEl.value);

    if (!stage.reduce) {
        P.x.x = window.innerWidth * 0.62;
        P.y.x = -50;
        P.ry.x = -200;
        P.rz.x = 16;
    }

    // 起始姿态必须先落进 DOM：下面那一帧是留给首布局/首绘的，不能让它看见包停在舞台正中
    if (packEl.value) packEl.value.style.transform = poseTransform(0, 0);

    // 从 `-200°` 转回来的这一路，侧面侧对着视线 ⇒ 先不画（理由见 `setRimsHidden`）
    if (!stage.reduce) setRimsHidden(true);

    // 进场声：从右边飞进来、落定后"滋啦"一声跟一句招呼（参考站的 arrive）
    if (!stage.reduce) voices()?.arrive();

    /**
     * ⚠️ 弹簧晚一帧起跑。
     *
     * 挂载这一帧要付的是"插入 DOM + 首布局 + 建立合成层 + 首绘"，而飞入第 0 帧只需要一个
     * `transform`。拆到两帧里做，飞入就不用背着重启跑（晚 16ms，肉眼看不出来）。
     * `measure()` 也挪到这里：它是强制布局（`offsetWidth` + 两次 `getBoundingClientRect`），
     * 挂载帧读了就要把整棵刚插进来的子树同步算一遍。
     */
    requestAnimationFrame(() => {
        if (!packEl.value) return;  // 已经卸载（开包后 `v-if` 会把它摘掉）
        measure();
        stage.start();
    });

    // 浏览器只允许在用户手势里起 AudioContext ⇒ 和参考站一样，在第一次交互时把它唤醒
    for (const type of ['pointerdown', 'pointerup', 'click', 'keydown'] as const) {
        window.addEventListener(type, onWake, true);
    }
    window.addEventListener('pointermove', onPointerTrack);
    window.addEventListener('resize', onResize);
    document.documentElement.addEventListener('pointerleave', onPointerLeave);
});

onActivated(() => {
    measure();
    stage.start();
    window.addEventListener('pointermove', onPointerTrack);
    window.addEventListener('resize', onResize);
    document.documentElement.addEventListener('pointerleave', onPointerLeave);
});

onDeactivated(() => {
    window.removeEventListener('pointermove', onPointerTrack);
    window.removeEventListener('resize', onResize);
    document.documentElement.removeEventListener('pointerleave', onPointerLeave);
    releasePack();
    drag = null;
    stage.stop();
});

onBeforeUnmount(() => {
    for (const type of ['pointerdown', 'pointerup', 'click', 'keydown'] as const) {
        window.removeEventListener(type, onWake, true);
    }
    window.removeEventListener('pointermove', onPointerTrack);
    window.removeEventListener('resize', onResize);
    document.documentElement.removeEventListener('pointerleave', onPointerLeave);
    voices()?.rip(0);
    stage.stop();
});

function onWake(): void {
    wakeVoices();
}
</script>

<style scoped lang="less">
/* ── 舞台 ──────────────────────────────────────────────────────────────── */
.pack-stage {
    /* 包是竖直长条：0.69 : 1（真实铝箔卡包的比例）
       自适应支持大屏（最大可自适应扩大至 680px，适配 2560px 宽屏） */
    --ph: clamp(380px, min(60vh, 26vw), 680px);
    --pw: calc(var(--ph) * 0.69);
    --crimp: calc(var(--ph) * 0.068);
    --depth: 14px;
    --tooth: calc(var(--pw) / 26);

    position: relative;
    width: var(--pw);
    height: var(--ph);
    /* 跟随页面：整体下沉（`--pack-drop` 在 `.lucky` 上定义） */
    translate: 0 var(--pack-drop, 0);
    perspective: 1400px;
    perspective-origin: 50% 40%;
    pointer-events: none;
}

/* 地面投影：椭圆、模糊。暗色下叠加上柔光环境晕与深度落影，确保不同主题下层次分明 */
.ground {
    position: absolute;
    left: 50%;
    top: 50%;
    width: calc(var(--pw) * .95);
    height: calc(var(--pw) * .18);
    margin: calc(var(--pw) * -.09) 0 0 calc(var(--pw) * -.475);
    border-radius: 50%;
    background: radial-gradient(ellipse closest-side, var(--ff-pack-ground-shadow) 0%, transparent 80%);
    filter: blur(6px);
    pointer-events: none;

    &::before {
        content: '';
        position: absolute;
        inset: -22px -44px;
        border-radius: 50%;
        background: radial-gradient(ellipse closest-side, var(--ff-pack-ground-glow) 0%, transparent 100%);
        z-index: -1;
        pointer-events: none;
    }
}

/* 光流外层：**与包同一个框**，所以能承接包的三轴变换（跟着包一起歪）。
   ⚠️ 别把 svg 直接放这一层（踩过）：那样旋转中心落在 svg 自己身上，比包心高一截。 */
.flow {
    position: absolute;
    inset: 0;
    transform-style: preserve-3d;
    pointer-events: none;
}

/* 光流的画布：位置与尺寸由 `RainbowFlow.fit()` 按"包宽的 1% = 1 单位"算好写上来
   （它要盖住扇形真正画到的范围，不能写死成包框大小） */
.rays {
    position: absolute;
    pointer-events: none;
    opacity: 0;
}

/* 圆角侧面：几何全在 `packSkin.buildRims()` 里算，这里只给材质。
   受光的一侧往白里提、背光的一侧往黑里压 —— 与正面是同一束左上光。 */
.rim {
    position: absolute;
    background: color-mix(in srgb, var(--pack, var(--ff-pack-cobalt)), var(--rim-tone) var(--rim-mix));
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
 * 入场旋转期间侧面不画。
 *
 * ⚠️ 18 条侧面各有自己的 `clip-path` 多边形，父级 perspective 旋转时投影尺寸每帧都在变
 *    ⇒ 每条都要重光栅；实测（`docs/probes/lucky-entry/entry-cost.cjs`）这是入场掉帧的
 *    唯一大头。`setRimsHidden()` 在 `|ry| < 20°` 时把类摘掉（那时它们已经该看得见了）。
 */
.pack.is-spin .rim {
    visibility: hidden;
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
            0 0 / var(--tooth) calc(var(--tooth) / 2 + 1px) repeat-x,
        url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100' preserveAspectRatio='none'><path d='M0 0H100V5.6C100 8 97.6 7.6 97.6 10V90C97.6 92.4 100 92 100 94.4V100H0V94.4C0 92 2.4 92.4 2.4 90V10C2.4 7.6 0 8 0 5.6Z'/></svg>")
            0 50% / 100% calc(100% - var(--tooth) + 3px) no-repeat,
        conic-gradient(from -45deg at 50% 100%, transparent, black 1deg 89deg, transparent 90deg)
            0 100% / var(--tooth) calc(var(--tooth) / 2 + 1px) repeat-x;
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
    font: 700 calc(var(--pw) * 0.029)/1 var(--ff-font);
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: color-mix(in srgb, white 74%, transparent);
}

.mark {
    position: absolute;
    left: 9%;
    top: 15%;
    font: 800 calc(var(--pw) * 0.17)/1 ui-rounded, "SF Pro Rounded", var(--ff-font);
    letter-spacing: -0.045em;
    color: var(--ff-on-band);
}

.series {
    position: absolute;
    right: 9%;
    top: 17.5%;
    font: 600 calc(var(--pw) * 0.036)/1 var(--ff-font);
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: color-mix(in srgb, white 70%, transparent);
}

/* 居中吉祥物：炫彩四芒星（Sparkle）
   姿态倾角联动色相变换（--sh），并附带实时注视、眨眼、受力忍痛与冒汗全套表情 */
.orb {
    position: absolute;
    left: 8%;
    width: 84%;
    top: 26.5%;
    aspect-ratio: 1;
    pointer-events: none;
    transition: scale 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275);

    img {
        user-select: none;
        -webkit-user-drag: none;
        pointer-events: none;
    }
}

.body,
.shade {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
}

.orb .body {
    filter: hue-rotate(calc(var(--sh, 0) * 1deg));
}

.shade {
    translate: 0 3.5%;
    filter: brightness(0) blur(calc(var(--pw) * 0.024));
    opacity: 0.34;
}

.eye {
    position: absolute;
    transition: opacity 0.09s, scale 0.14s cubic-bezier(0.23, 1, 0.32, 1);
}

.eye--0 {
    left: 33.05%;
    top: 45.52%;
    width: 13.91%;
}

.eye--1 {
    left: 52.94%;
    top: 42.95%;
    width: 14.37%;
}

.pupil {
    display: block;
    width: 100%;
    height: auto;
    transition: scale 0.2s cubic-bezier(0.23, 1, 0.32, 1);
}

.smile {
    position: absolute;
    left: 45.79%;
    top: 55.74%;
    width: 10%;
    height: auto;
    transition: opacity 0.08s, scale 0.2s cubic-bezier(0.23, 1, 0.32, 1);
}

/* 撕扯时龇牙忍痛（ouch）与冒冷汗（drip） */
.ouch {
    position: absolute;
    left: 34.01%;
    top: 44.62%;
    width: 32.03%;
    height: auto;
    opacity: 0;
    scale: 0.6;
    transition: opacity 0.08s, scale 0.24s cubic-bezier(0.175, 0.885, 0.32, 1.275);
}

.drip {
    position: absolute;
    left: 60.12%;
    top: 29.9%;
    width: 14.84%;
    height: auto;
    opacity: 0;
    scale: 0.7;
    translate: 0 -45%;
    transition:
        opacity 0.18s,
        scale 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275),
        translate 0.5s cubic-bezier(0.23, 1, 0.32, 1);
}

/* 拆包动态交互：悬停瞳孔微笑放大 / 纵向轻拉紧绷 / 撕裂剧烈颤动忍痛龇牙与冷汗 */
@media (hover: hover) and (pointer: fine) {
    .pack:has(.hit:hover) .pupil {
        scale: 1.06;
    }

    .pack:has(.hit:hover) .smile {
        scale: 1.1;
    }
}

.is-tug .orb {
    scale: 0.98 1.03;
}

.is-held .orb {
    scale: 1.06 0.92;
    animation: ff-orb-tremble 90ms steps(2) infinite;
}

.is-held .eye {
    scale: 1 0;
}

.is-held .smile {
    opacity: 0;
    scale: 0.3;
}

.is-held .ouch {
    opacity: 1;
    scale: 1;
}

.is-hurt .drip {
    opacity: 1;
    scale: 1;
    translate: 0 0;
}

@keyframes ff-orb-tremble {
    50% {
        translate: 1.2px -0.8px;
    }
}

.foot {
    position: absolute;
    bottom: calc(var(--crimp) + 3.4%);
    font: 500 calc(var(--pw) * 0.042)/1 var(--ff-font);
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
    display: none;

    &.is-open {
        display: block;
    }
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

/* 撕条背面是铝箔：银色折光，实体物理材质，两套主题同色 */
.skin--foil {
    transform: rotateY(180deg) translateZ(0.4px);
    background: var(--ff-pack-inner-foil);
}

.skin--foil::before,
.skin--foil::after {
    display: none;
}

/* 撕口的金属亮边：断面金属亮带，两套主题同色 */
.lip {
    position: absolute;
    inset: 0;
    z-index: 2;
    clip-path: polygon(0 0);
    background: var(--ff-pack-tear-lip);
}

/* ⚠️ 投影必须挂在**容器**上，不能挂在被裁切的 `.lip` 上：
   `clip-path` 在 filter 之后生效，同一元素上写 drop-shadow 会把影子一起裁掉。 */
.lips {
    position: absolute;
    inset: 0;
    z-index: 2;
    pointer-events: none;
    filter: drop-shadow(0 1.5px 1.2px var(--ff-jewel-shadow));
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

    /* 抓住 / 正在拉：光标要立刻变成"攥住"的状态（参考站同两处 class） */
    .is-held &,
    .is-tug & {
        cursor: grabbing;
    }
}

@media (prefers-reduced-motion: reduce) {
    .pack {
        transition: none;
    }
    .orb,
    .body,
    .eye,
    .pupil,
    .smile,
    .ouch,
    .drip {
        animation: none !important;
        transition: none !important;
    }
}
</style>
