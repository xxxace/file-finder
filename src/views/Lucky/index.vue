<template>
    <div class="lucky">
        <header class="top">
            <div class="top__left">
                <span class="pool-count">池中 {{ total }} 部</span>
                <span v-if="!onlineKnown" class="warn">磁盘状态未知，已包含全部缓存</span>
            </div>
            <n-checkbox v-model:checked="includeOffline" :disabled="loading || !onlineKnown">
                包含离线盘缓存
            </n-checkbox>
        </header>

        <div class="stage">
            <div v-if="loading" class="state">
                <n-spin size="small" />
                <span>正在汇总已缓存封面…</span>
            </div>

            <div v-else-if="!cards.length" class="state state--empty">
                <p class="empty__title">还没有可以抽的封面</p>
                <p class="empty__desc">先去「文件」里浏览并扫描一次，认出封面的作品才会进池子。</p>
                <n-button size="small" @click="goFiles">前往文件浏览</n-button>
            </div>

            <div v-else class="fan" :style="{ '--n': cards.length }">
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
        </div>

        <footer v-if="!loading && cards.length" class="bottom">
            <n-button size="small" @click="redraw">再来一包</n-button>
            <span class="keys"><kbd>←</kbd><kbd>→</kbd> 选 · <kbd>Enter</kbd> 播 · <kbd>空格</kbd> 换一包</span>
        </footer>
    </div>
</template>

<script setup lang="ts">
/**
 * 手气不错 —— 页面编排。
 *
 * 分工（本文件只管"什么时候做什么"，不含任何抽卡规则与视觉参数）：
 *   · 抽哪几张   → `drawModel.ts`（纯逻辑，探针覆盖）
 *   · 池子从哪来 → `usePool.ts`（两个已有接口，零读盘）
 *   · 怎么打开   → `views/FileFinder/openCover.ts`（与 3D 漫游共用）
 *   · 卡片长什么样 → `components/LuckyDiscCard`
 *   · 摆成扇形   → `discCase.ts` 的 `fanOf`
 */
import { computed, onActivated, onBeforeUnmount, onDeactivated, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { NButton, NCheckbox, NSpin } from 'naive-ui';
import LuckyDiscCard from '@/components/LuckyDiscCard/index.vue';
import { cardOf, drawPack, rememberRecent } from './drawModel';
import type { DrawCard } from './drawModel';
import { fetchPool } from './usePool';
import { fanOf } from './discCase';
import { openCover } from '@/views/FileFinder/openCover';
import useNotify from '@/hooks/useNotify';

const router = useRouter();
const notify = useNotify();

/** 质感配方 —— 对应 `docs/probes/lucky-texture/spike.html` 的三档。
 *  `deco` = 箔只在信息条/贴纸/书脊。真实封面不吃色相，这是「保质感 + 兼容自定义」的落点。 */
const foil = 'deco' as const;

const loading = ref(true);
const sources = ref<Awaited<ReturnType<typeof fetchPool>> | null>(null);
const cards = ref<DrawCard[]>([]);
/** 最近抽过的 sig（最多 3 包）—— 连按两次不会出现一模一样的五张 */
const recent = ref<string[]>([]);
const activeIndex = ref(0);

const includeOffline = ref(true);

const total = computed(() => sources.value?.total ?? 0);
const onlineKnown = computed(() => sources.value?.onlineKnown ?? false);

/**
 * 实际生效的"含离线"开关。
 *
 * ⚠️ `/getDisks` 失败时 `onlineSerials` 是空集 —— 若此时仍按"不含离线"筛，
 * 整个池子会被滤成空，用户只会看到"没有可抽的封面"。所以状态未知时**强制包含**，
 * 并把勾选框禁用（上头那行小字说明原因）。
 */
const effectiveIncludeOffline = computed(() => includeOffline.value || !onlineKnown.value);

function slotStyle(index: number) {
    const spot = fanOf(index, cards.value.length);
    return {
        transform: `rotate(${spot.rot}deg) translateY(${spot.dy}px)`,
        zIndex: String(spot.z),
    };
}

function redraw() {
    const pool = sources.value;
    if (!pool) return;
    const pack = drawPack(pool.sources, pool.onlineSerials, {
        includeOffline: effectiveIncludeOffline.value,
        exclude: new Set(recent.value),
    });
    cards.value = pack.map(item => cardOf(item, pool.onlineSerials, pool.letters));
    recent.value = rememberRecent(recent.value, cards.value);
    activeIndex.value = 0;
}

async function load() {
    loading.value = true;
    try {
        sources.value = await fetchPool();
        redraw();
    } catch (e) {
        notify('error', '读取封面池失败', e instanceof Error ? e.message : String(e));
        sources.value = null;
        cards.value = [];
    } finally {
        loading.value = false;
    }
}

async function open(card: DrawCard) {
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
 * ⚠️ 焦点在输入类元素上时一律放行：`NCheckbox` 内部是 `<input>`，空格属于它。
 */
function onKey(ev: KeyboardEvent) {
    const el = ev.target as HTMLElement | null;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
    if (!cards.value.length) return;

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
        case 'Escape':
            ev.preventDefault();
            goFiles();
            break;
        default:
            break;
    }
}

/** KeepAlive 下首次进入也会触发 onActivated ⇒ 用 loaded 挡住重复加载 */
let loaded = false;
onActivated(() => {
    window.addEventListener('keydown', onKey);
    if (loaded) return;
    loaded = true;
    void load();
});

onDeactivated(() => window.removeEventListener('keydown', onKey));
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));
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

.stage {
    flex: 1;
    min-height: 0;
    display: grid;
    place-items: center;
    padding: var(--ff-sp-4);
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

/* 扇形：五张并排，各自的 rotate / translateY 由 `fanOf` 给出（写在内联 style 上）。
   ⚠️ 卡片本身还有 preserve-3d + 自己的倾斜 transform，所以旋转必须落在**外面这层**
      `.slot` 上 —— 同一个元素上两个 rotate 会互相覆盖。 */
.fan {
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
    transition: transform 320ms cubic-bezier(0.19, 1, 0.22, 1);
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
</style>
