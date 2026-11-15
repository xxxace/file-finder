<template>
    <div class="lucky">
        <header class="top">
            <div class="top__left">
                <span class="pool-count">池中 {{ total }} 部</span>
                <span v-if="!onlineKnown && !loading" class="warn">磁盘状态未知，已包含全部缓存</span>
            </div>
            <n-checkbox v-model:checked="includeOffline" :disabled="loading || !onlineKnown || phase !== 'sealed'">
                包含离线盘缓存
            </n-checkbox>
        </header>

        <div class="stage">
            <div v-if="loading" class="state">
                <n-spin size="small" />
                <span>正在汇总已缓存封面…</span>
            </div>

            <div v-else-if="loadError" class="state state--empty">
                <p class="empty__title">连不上本地服务</p>
                <p class="empty__desc">{{ loadError }}</p>
                <n-button size="small" @click="load">重试</n-button>
            </div>

            <div v-else-if="!cards.length" class="state state--empty">
                <p class="empty__title">还没有可以抽的封面</p>
                <p class="empty__desc">先去「文件」里浏览并扫描一次，认出封面的作品才会进池子。</p>
                <n-button size="small" @click="goFiles">前往文件浏览</n-button>
            </div>

            <template v-else>
                <canvas ref="fxRef" class="fx" aria-hidden="true" />

                <LuckyDiscCase v-if="phase !== 'open'" :phase="phase" @tear="startOpen" />

                <div class="fan" :data-phase="phase" :style="{ '--n': cards.length, '--t-cards': `${T_CARDS}ms` }">
                    <span class="sweep" aria-hidden="true" />
                    <div
                        v-for="(card, i) in cards"
                        :key="card.key"
                        class="slot"
                        :style="slotStyle(i)"
                    >
                        <LuckyDiscCard
                            :card="card"
                            :index="i"
                            :count="cards.length"
                            :active="i === activeIndex"
                            :foil="foil"
                            @open="open"
                            @focus="activeIndex = $event"
                        />
                    </div>
                </div>
            </template>
        </div>

        <footer class="bottom">
            <template v-if="phase === 'open'">
                <n-button size="small" type="primary" @click="redraw">再来一包</n-button>
                <span class="keys"><kbd>←</kbd><kbd>→</kbd> 选 · <kbd>Enter</kbd> 播</span>
            </template>
            <n-button
                v-else-if="phase === 'sealed' && cards.length"
                size="small"
                type="primary"
                @click="startOpen"
            >
                拆开这一包
            </n-button>
        </footer>
    </div>
</template>

<script setup lang="ts">
/**
 * 手气不错 —— 页面编排（只放"什么时候做什么"，不含抽卡规则、不含视觉参数）。
 *
 * 分工：
 *   · 抽哪几张     → `drawModel.ts`（纯逻辑，探针覆盖）
 *   · 池子从哪来   → `usePool.ts`（两个已有接口，零读盘）
 *   · 怎么打开     → `views/FileFinder/openCover.ts`（与 3D 漫游共用）
 *   · 卡片 / 包装盒 → `components/LuckyDiscCard`、`components/LuckyDiscCase`
 *   · 扇形落点     → `discCase.ts` 的 `fanOf`
 *
 * 时间轴也**只在这里**（0 / 180 / 320 / 1400ms）。盒子组件内部只有 CSS class，
 * 自己不带任何计时器 —— 两处各管一半时间轴必然对不上。
 */
import { computed, onActivated, onBeforeUnmount, onDeactivated, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { NButton, NCheckbox, NSpin } from 'naive-ui';
import LuckyDiscCard from '@/components/LuckyDiscCard/index.vue';
import LuckyDiscCase from '@/components/LuckyDiscCase/index.vue';
import { burst } from '@/components/LuckyDiscCase/confetti';
import { cardOf, drawPack, rememberRecent } from './drawModel';
import type { DrawCard } from './drawModel';
import { fetchPool } from './usePool';
import { fanOf } from './discCase';
import { openCover } from '@/views/FileFinder/openCover';
import { playSfx } from '@/utils/sfx';
import useNotify from '@/hooks/useNotify';

type Phase = 'sealed' | 'opening' | 'open';

const router = useRouter();
const notify = useNotify();

/** 质感配方 —— 对应 `docs/probes/lucky-texture/spike.html` 的三档。
 *  `deco` = 箔只在信息条 / 贴纸 / 书脊。真实封面不吃色相，这是「保质感 + 兼容自定义」的落点。 */
const foil = 'deco' as const;

/** 拆封时间轴（ms）。改这里就够了，盒子与卡片的 CSS 延迟都按这几个数对齐 */
const T_BURST = 180;   // 盒盖弹开 + 爆开音 + 彩带
const T_CARDS = 320;   // 第一张卡起飞（与 fan 的 CSS delay 起点同值）
const T_DONE = 1450;   // 盒子退场完毕（CSS: 900ms 延迟 + 520ms 动画 = 1420ms），切到 open

const loading = ref(true);
/**
 * 拉池子失败的原文。
 *
 * ⚠️ 为什么单列一个状态、而不是"失败就当空池"（2026-11-15 探针实测）：
 *    服务被另一个实例占端口 / 口令对不上时，两个接口都 403，而界面会显示
 *    「还没有可以抽的封面」+「前往文件浏览」—— 把人引去扫描，方向完全错了。
 *    这两种情况必须长得不一样：一个要你去扫描，一个要你重启。
 */
const loadError = ref('');
const phase = ref<Phase>('sealed');
const sources = ref<Awaited<ReturnType<typeof fetchPool>> | null>(null);
const cards = ref<DrawCard[]>([]);
const recent = ref<string[]>([]);
const activeIndex = ref(0);
const includeOffline = ref(true);

const fxRef = ref<HTMLCanvasElement | null>(null);
let stopFx: (() => void) | null = null;
const timers: number[] = [];

const total = computed(() => sources.value?.total ?? 0);
const onlineKnown = computed(() => sources.value?.onlineKnown ?? false);

/**
 * 实际生效的"含离线"开关。
 *
 * ⚠️ `/getDisks` 失败时 `onlineSerials` 是空集 —— 若此时仍按"不含离线"筛，整个池子
 * 会被滤成空，用户只会看到"没有可抽的封面"。所以状态未知时**强制包含**并禁用勾选框。
 */
const effectiveIncludeOffline = computed(() => includeOffline.value || !onlineKnown.value);

function slotStyle(index: number) {
    const spot = fanOf(index, cards.value.length);
    return {
        '--rot': `${spot.rot}deg`,
        '--dy': `${spot.dy}px`,
        '--z': String(spot.z),
        '--i': String(index),
    } as Record<string, string>;
}

function clearTimers() {
    while (timers.length) window.clearTimeout(timers.pop());
}

function stopConfetti() {
    stopFx?.();
    stopFx = null;
}

/** 从令牌里取箔的三段色 —— canvas 里不能用 `var()`，只能读出来传进去 */
function foilColors(): string[] {
    const cs = getComputedStyle(document.documentElement);
    return ['--ff-foil-a', '--ff-foil-b', '--ff-foil-c']
        .map(name => cs.getPropertyValue(name).trim())
        .filter(Boolean);
}

function fireConfetti() {
    const canvas = fxRef.value;
    if (!canvas) return;
    stopConfetti();
    stopFx = burst(canvas, {
        count: 120,
        origin: { x: 0.5, y: 0.44 },
        colors: foilColors(),
    });
}

/** 撕开：整条时间轴唯一入口（点击拉条与空格都走这里） */
function startOpen() {
    if (phase.value !== 'sealed' || !cards.value.length) return;
    phase.value = 'opening';
    playSfx('lucky-tear');

    timers.push(window.setTimeout(() => {
        playSfx('lucky-burst');
        fireConfetti();
    }, T_BURST));

    timers.push(window.setTimeout(() => {
        phase.value = 'open';
        activeIndex.value = 0;
    }, T_DONE));
}

function redraw() {
    const pool = sources.value;
    if (!pool) return;
    clearTimers();
    stopConfetti();

    const pack = drawPack(pool.sources, pool.onlineSerials, {
        includeOffline: effectiveIncludeOffline.value,
        exclude: new Set(recent.value),
    });
    cards.value = pack.map(item => cardOf(item, pool.onlineSerials, pool.letters));
    recent.value = rememberRecent(recent.value, cards.value);
    activeIndex.value = 0;
    phase.value = 'sealed';
}

async function load() {
    loading.value = true;
    loadError.value = '';
    try {
        sources.value = await fetchPool();
        redraw();
    } catch (e) {
        loadError.value = e instanceof Error ? e.message : String(e);
        sources.value = null;
        cards.value = [];
        notify('error', '读取封面池失败', loadError.value);
    } finally {
        loading.value = false;
    }
}

async function open(card: DrawCard) {
    if (phase.value !== 'open') return;
    const result = await openCover(card.src);
    if (result.ok) {
        notify('success', '已交给播放器', card.title);
        return;
    }
    if (result.reason === 'offline') {
        notify('warning', '磁盘未在线', `这块盘（序列号 ${result.serial}）现在没插。`);
        return;
    }
    notify('error', '打开失败', result.message);
}

function goFiles() {
    void router.push('/');
}

/** 勾选变化就重抽一包（不是过滤现有五张 —— 那样会出现"只剩三张"的空位） */
watch(includeOffline, redraw);

/**
 * 全局键盘。
 *
 * ⚠️ 必须挂/卸在 activated/deactivated 上：外壳用 KeepAlive，离开本页组件不会卸载，
 *    只在 `onMounted` 挂监听的话，人在文件页按空格也会在这儿换一包。
 * ⚠️ 焦点在输入类元素上时放行：`NCheckbox` 内部是 `<input>`，空格属于它。
 */
function onKey(ev: KeyboardEvent) {
    const el = ev.target as HTMLElement | null;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;

    if (ev.key === 'Escape') {
        ev.preventDefault();
        goFiles();
        return;
    }
    if (!cards.value.length) return;

    if (phase.value === 'sealed') {
        if (ev.key === ' ' || ev.key === 'Enter') {
            ev.preventDefault();
            startOpen();
        }
        return;
    }
    if (phase.value !== 'open') return;

    switch (ev.key) {
        case 'ArrowLeft':
            ev.preventDefault();
            activeIndex.value = (activeIndex.value - 1 + cards.value.length) % cards.value.length;
            break;
        case 'ArrowRight':
            ev.preventDefault();
            activeIndex.value = (activeIndex.value + 1) % cards.value.length;
            break;
        case 'Enter':
            ev.preventDefault();
            void open(cards.value[activeIndex.value]);
            break;
        case ' ':
            ev.preventDefault();
            redraw();
            break;
        default:
            break;
    }
}

/**
 * 离页多久后把数据与画布一起还回去。
 *
 * 外壳是 KeepAlive ⇒ 切页不会触发 `onBeforeUnmount`；不显式停，彩带的 RAF 会在后台
 * 一直跑（隧道页那个 idle dispose 是同一个坑，照它的 2 分钟阈值）。
 */
const IDLE_DISPOSE_MS = 2 * 60 * 1000;
let idleTimer: number | null = null;
let disposed = false;
let loaded = false;

function disposeIdle() {
    idleTimer = null;
    disposed = true;
    clearTimers();
    stopConfetti();
    cards.value = [];
    phase.value = 'sealed';
    loading.value = true;   // 回来时先转圈，不闪那张空态卡
}

onActivated(() => {
    window.addEventListener('keydown', onKey);
    if (idleTimer !== null) {
        window.clearTimeout(idleTimer);
        idleTimer = null;
    }
    if (disposed) {
        disposed = false;
        void load();
        return;
    }
    if (!loaded) {
        loaded = true;
        void load();
    }
});

onDeactivated(() => {
    window.removeEventListener('keydown', onKey);
    stopConfetti();
    clearTimers();
    idleTimer = window.setTimeout(disposeIdle, IDLE_DISPOSE_MS);
});

onBeforeUnmount(() => {
    window.removeEventListener('keydown', onKey);
    if (idleTimer !== null) window.clearTimeout(idleTimer);
    stopConfetti();
    clearTimers();
});
</script>

<style scoped lang="less">
.lucky {
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100%;
    background: var(--ff-canvas);
    color: var(--ff-text-1);
}

.top,
.bottom {
    display: flex;
    align-items: center;
    gap: var(--ff-sp-3);
    padding: 0 var(--ff-sp-6);
    flex: none;
}

.top {
    height: var(--ff-header-h);
    justify-content: space-between;
}

.top__left {
    display: flex;
    align-items: baseline;
    gap: var(--ff-sp-3);
    min-width: 0;
}

.pool-count {
    font-size: var(--ff-fs-meta);
    color: var(--ff-text-2);
}

.warn {
    font-size: var(--ff-fs-meta);
    color: var(--ff-warn);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

/* 舞台：盒子与扇形卡片共用同一个中心 —— 卡片要从盒心飞出去，两个中心必须重合。
   ⚠️ 2026-11-15：必须显式 `grid-area: 1/1` 让所有直接子项**叠在同一格**。
      默认的 grid 是单列多行 —— 盒子占一行、扇形占一行，盒子会被挤到上方甚至挤出容器，
      真机表现就是"根本没看到开包，一进来就是五张卡"。
      同理 `grid-template` 要用 `minmax(0,1fr)`：写 `100%` 会把 padding 算到外面去。 */
.stage {
    position: relative;
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template: minmax(0, 1fr) / minmax(0, 1fr);
    place-items: center;
    padding: var(--ff-sp-4);
}

.stage > * {
    grid-area: 1 / 1;
}

.fx {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
}

.state {
    display: flex;
    align-items: center;
    gap: var(--ff-sp-2);
    font-size: var(--ff-fs-body);
    color: var(--ff-text-2);
}

.state--empty {
    flex-direction: column;
    text-align: center;
    max-width: 380px;
    gap: var(--ff-sp-2);
}

.empty__title {
    margin: 0;
    font-size: var(--ff-fs-title);
    color: var(--ff-text-1);
}

.empty__desc {
    margin: 0 0 var(--ff-sp-2);
    font-size: var(--ff-fs-body);
    line-height: 1.7;
    color: var(--ff-text-2);
}

/**
 * 扇形。卡片各自的倾斜在子组件内部（preserve-3d），所以旋转与位移必须落在**外面这层**
 * `.slot` 上 —— 同一个元素上两套 transform 会互相覆盖。
 *
 * 三个阶段的差异全部靠 CSS 变量：
 *   sealed  卡片缩在盒心、透明、不吃点击
 *   opening 依次弹出到扇形落点（每张 +60ms）
 *   open    静置
 */
.fan {
    position: relative;
    /* 卡片必须压在包装盒之上：爆开时盒子还带着 3D 变换，同层级下它会把飞出的卡切掉一半 */
    z-index: 6;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 18px;
    width: 100%;
    padding: var(--ff-sp-6) 0;
}

.slot {
    width: min(190px, calc((100% - 120px) / var(--n)));
    flex: none;
    z-index: var(--z);
    transform: translate(0, calc(var(--dy) + var(--fy, 0px))) scale(var(--fs, 1)) rotate(var(--rot));
    opacity: var(--fo, 1);
    transition:
        transform 620ms cubic-bezier(0.19, 1, 0.22, 1) var(--delay, 0ms),
        opacity 320ms ease var(--delay, 0ms);
}

.fan[data-phase='sealed'] .slot {
    --fy: 36px;
    --fs: 0.5;
    --fo: 0;
    pointer-events: none;
}

.fan[data-phase='opening'] .slot {
    --fy: 0px;
    --fs: 1;
    --fo: 1;
    /* 起点由页面传下来的 `--t-cards` 决定 —— 盒子掀盖与卡片起飞必须同一条时间轴 */
    --delay: calc(var(--t-cards, 320ms) + var(--i) * 60ms);
    pointer-events: none;
}

.fan[data-phase='open'] .slot {
    --delay: 0ms;
}

/* 爆开瞬间横扫过五张卡的一道彩虹 —— 只跑一次，静置画面不留色相 */
.sweep {
    position: absolute;
    inset: -8% -4%;
    pointer-events: none;
    opacity: 0;
    background: linear-gradient(104deg,
        transparent 38%, var(--ff-foil-a) 46%, var(--ff-foil-b) 50%,
        var(--ff-foil-c) 54%, transparent 62%);
    mix-blend-mode: screen;
}

.fan[data-phase='opening'] .sweep {
    animation: sweep-across 760ms 340ms ease-out forwards;
}

@keyframes sweep-across {
    0% { opacity: 0; transform: translateX(-46%); }
    28% { opacity: 0.6; }
    100% { opacity: 0; transform: translateX(46%); }
}

.bottom {
    height: 56px;
    justify-content: center;
    gap: var(--ff-sp-4);
}

.keys {
    font-size: var(--ff-fs-meta);
    color: var(--ff-text-2);
}

kbd {
    display: inline-block;
    min-width: 18px;
    padding: 1px 5px;
    margin: 0 2px;
    border-radius: var(--ff-r-ctl);
    border: 1px solid var(--ff-line);
    background: var(--ff-raised);
    font: inherit;
    font-size: var(--ff-fs-eyebrow);
    text-align: center;
    color: var(--ff-text-1);
}

@media (max-width: 900px) {
    .fan {
        gap: 10px;
    }

    .slot {
        width: min(150px, calc((100% - 60px) / var(--n)));
    }
}

@media (prefers-reduced-motion: reduce) {
    .slot {
        transition: opacity 240ms ease;
    }

    .fan[data-phase='opening'] .sweep {
        animation: none;
    }
}
</style>
