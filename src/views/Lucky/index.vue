<template>
    <div class="lucky">
        <!-- 磁盘状态异常轻量浮动提示（绝对定位不占舞台高度） -->
        <div v-if="!onlineKnown && !loading" class="top-warn" aria-live="polite">
            <span class="warn">磁盘状态未知，已包含全部缓存</span>
        </div>

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

            <template v-else-if="!loading">
                <canvas ref="fxRef" class="fx" :class="{ 'is-active': phase === 'opening' }" aria-hidden="true" />

                <LuckyPack v-if="phase !== 'open'" ref="caseRef" :phase="phase" :skin="skin" @opened="onOpened" />

                <!--
                    卡片层：每张卡绝对定位在舞台中心，位置**全部由 JS 每帧写**
                    （射出 → 螺旋 → 落位）。所以这里没有任何 transform/transition ——
                    一旦给 CSS transition，JS 写的每一帧都会被它拖回上一帧，
                    表现为"卡片跟着走但慢半拍、螺旋变成一条抖动的直线"。
                -->
                <div ref="sceneEl" class="scene" :data-phase="phase"
                    :class="{ 'is-inspecting': inspectingCard !== null }">
                    <div v-for="(card, i) in cards" :key="card.key" :ref="el => setSlot(i, el)" class="slot">
                        <LuckyDiscCard :card="card" :index="i" :count="cards.length" :revealed="phase !== 'sealed'"
                            :active="kbNav && activeIndex === i"
                            @open="open" @select="onCardSelect(card, i)" @focus="activeIndex = $event" />
                    </div>
                </div>

                <!-- 居中放大详情卡片（固定 5:7 黄金比例，标准 3:2 封面窗，实体卡纸三层叠片与全息/清漆质感） -->
                <transition name="inspect-zoom">
                    <div v-if="inspectingCard" class="inspect-overlay" role="dialog" aria-modal="true"
                        :aria-label="inspectingCard.title" @click.self="closeInspect">
                        <button v-if="cards.length > 1" class="inspect-nav-btn inspect-nav-btn--prev"
                            aria-label="查看上一张卡片" title="上一张 (←)" @click.stop="prevInspectCard">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                                <polyline points="15 18 9 12 15 6" />
                            </svg>
                        </button>

                        <article ref="inspectCardEl" class="inspect-card" :class="inspectingCard.tier"
                            :style="inspectingPaperStyle ? { '--frame': inspectingPaperStyle.frame, '--edge': inspectingPaperStyle.edge } : undefined"
                            tabindex="0" @pointermove="onInspectPointerMove" @pointerleave="onInspectPointerLeave"
                            @dblclick="open(inspectingCard)">
                            <span class="slab" aria-hidden="true" />
                            <span class="slab" aria-hidden="true" />
                            <span class="slab" aria-hidden="true" />

                            <div class="inspect-face">
                                <!-- 封面图窗：与 file-finder 统一固定 3:2 标准封面比例（--ff-cover-ratio） -->
                                <div class="inspect-win" :style="{ background: inspectWinBg }">
                                    <img v-if="inspectingCard.sig" class="inspect-art-img"
                                        :src="thumbUrl('t-' + inspectingCard.sig + '.enc')" :alt="inspectingCard.title"
                                        crossorigin="anonymous" draggable="false" @load="onInspectArtLoaded">
                                    <div v-else class="inspect-art-empty">无封面</div>

                                    <!-- 浮动圆形播放按钮：半透毛玻璃质感，悬停高亮，不抢封面风头又极易认出 -->
                                    <button class="inspect-play-circle" title="立即播放 (Enter)" aria-label="立即播放"
                                        @click.stop="open(inspectingCard)">
                                        <svg class="inspect-play-triangle" viewBox="0 0 24 24" fill="currentColor">
                                            <polygon points="7 4 19 12 7 20 7 4" />
                                        </svg>
                                    </button>
                                </div>

                                <!-- 卡片详情排版：纯正 TCG 收藏卡语汇 -->
                                <div class="inspect-content">
                                    <div class="inspect-row-title">
                                        <h2 class="inspect-title" :class="titleClass" :title="inspectingCard.title">{{
                                            inspectingCard.title }}</h2>
                                        <span class="inspect-type"
                                            :class="{ 'inspect-type--off': !inspectingCard.online }">
                                            {{ inspectingCard.online ? (inspectingCard.letter ?
                                                `${inspectingCard.letter} 盘` : '在线') : '离线' }}
                                        </span>
                                    </div>

                                    <!-- 规格与序列号条目 -->
                                    <div class="inspect-meta-row">
                                        <span class="inspect-meta-item">{{ positionText }}</span>
                                        <span class="inspect-meta-dot">·</span>
                                        <span class="inspect-meta-item">{{ inspectingCard.sizeText || '未知大小' }}</span>
                                        <span v-if="inspectingCard.serial" class="inspect-meta-dot">·</span>
                                        <span v-if="inspectingCard.serial"
                                            class="inspect-meta-item inspect-meta-serial">卷 {{ inspectingCard.serial
                                            }}</span>
                                        <span class="inspect-meta-rarity">{{ inspectingCard.mark }} {{
                                            inspectingCard.label }}</span>
                                    </div>

                                    <div class="inspect-rule" aria-hidden="true" />

                                    <!-- 存储地址铭牌：游戏王卡牌效果说明栏排版，纯粹沉浸，无截断换行展示 -->
                                    <div class="inspect-address-plate">
                                        <div class="inspect-address-header">
                                            <span class="inspect-address-tag">【存储地址】</span>
                                        </div>
                                        <div class="inspect-address-text" :title="getDisplayPath(inspectingCard)">
                                            <span v-if="isResolvingPath" class="inspect-resolving">正在解析挂载路径…</span>
                                            <span v-else>{{ getDisplayPath(inspectingCard) }}</span>
                                        </div>
                                    </div>
                                </div>

                                <!-- 三层真实材质（全息 / 眩光 / 清漆）：不盖在封面图上，在卡框随鼠标动态反光 -->
                                <i class="holo" aria-hidden="true" />
                                <i class="glare" aria-hidden="true" />
                                <i class="glaze" aria-hidden="true" />
                            </div>
                        </article>

                        <button v-if="cards.length > 1" class="inspect-nav-btn inspect-nav-btn--next"
                            aria-label="查看下一张卡片" title="下一张 (→)" @click.stop="nextInspectCard">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                                <polyline points="9 18 15 12 9 6" />
                            </svg>
                        </button>
                    </div>
                </transition>
            </template>
        </div>

        <!--
            底栏：绝对定位悬浮在舞台底部，岛屿式胶囊布局，操作组与配置项呼吸感分区
        -->
        <footer class="bottom">
            <div class="bottom-bar">
                <template v-if="phase === 'open'">
                    <div class="bottom-action-group">
                        <n-button size="small" type="primary" class="redraw-btn" @click="redraw">再来一包</n-button>
                        <span class="keys">
                            <kbd>←</kbd><kbd>→</kbd>
                            <span style="display: inline-block; margin:0 10px;">选</span>
                            <kbd>Enter</kbd>
                            <span style="display: inline-block; margin:0 10px;">播</span>
                        </span>
                    </div>
                    <div class="bottom-divider" aria-hidden="true" />
                </template>
                <div class="bottom-opt-group">
                    <n-checkbox v-model:checked="includeOffline" class="bottom-checkbox">
                        包含离线盘缓存
                    </n-checkbox>
                </div>
            </div>
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
 *   · 卡片 / 卡包 → `components/LuckyDiscCard`、`components/LuckyPack`
 *   · 扇形落点     → `cardStage.ts` 的 `fanSpot`（宽屏一排 / 窄屏手牌 / 竖屏 2-1-2）
 *   · 音效         → `voices.ts`（参考站的实时合成；时机由撕/编排本身给）
 *
 * 时间轴**只有"盒子何时摘掉"是定值**：撕多久由手决定，所以彩带、音效、卡片起飞
 * 全部挂在 `opened` / `CardShow` 的真实进度上，不许再用固定延时假装。
 */
import { computed, nextTick, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { NButton, NCheckbox, NSpin } from 'naive-ui';
import LuckyDiscCard from '@/components/LuckyDiscCard/index.vue';
import LuckyPack from '@/components/LuckyPack/index.vue';
import { burst } from './confetti';
import { cardOf, drawPack, rememberRecent, rollRarities } from './drawModel';
import type { DrawCard } from './drawModel';
import { ORBIT } from './cardStage';
import { applyDisksUpdate, fetchPool } from './usePool';
import { CardShow } from './cardShow';
import type { PackPose } from './cardShow';
import { useStage } from './useStage';
import { nextSkin } from './packSkin';
import { ipcRenderer } from 'electron';
import { API_BASE, getAction } from '@/utils/request';
import { anchorOf, openCover, pickFileName } from '@/views/FileFinder/openCover';
import { sleepVoices, voices } from './voices';
import useNotify from '@/hooks/useNotify';
import { thumbUrl } from '@/utils/thumb';
import { extractDominantHue, generatePaperStyle } from './extractColor';
import type { PaperStyle } from './extractColor';

type Phase = 'sealed' | 'opening' | 'open';

const router = useRouter();
const notify = useNotify();

/**
 * 本次专辑的主题色。
 *
 * 参考站每包换一种封面色，且**绝不与上一包重复** —— 这是"再来一包"最便宜的新鲜感。
 */
const skin = ref('cobalt');

/**
 * 拆封时间轴（ms）。
 *
 * ⚠️ 只有"盒子什么时候摘掉"是定值 —— 撕多久由手决定，彩带与音效都在 `opened`
 *    那一刻就发（源码同一处 `open()`：`burst()` + `sfx.pop()` 是同步的）。
 */
const T_DONE = 1450;   // 包已掉出画面、卡片也快落位 ⇒ 摘掉盒子、放出"再来一包"

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

/** 卡片编排全在 `CardShow` 里：射出 → 螺旋 → 落位。页面只负责把 DOM 交给它。 */
const sceneEl = ref<HTMLElement | null>(null);
const show = new CardShow();
// 音效的时机由编排本身给：螺旋开始、每张落位（页面里猜时间是猜不准的）
show.onUnwind = () => {
    voices()?.swirl(ORBIT);
    // 卡出包之后换成 flat（= 参考站 `scene.classList.add('flat')`）：
    // 五张卡各自成层、按 z-index 叠，不再参与 3D 排序 —— 这是整页最省的一刀
    sceneEl.value?.classList.add('is-flat');
};
show.onLand = slot => voices()?.land('', slot);

/**
 * 把舞台的矩形交给卡片编排。
 *
 * 尺寸与中心都必须是**容器**的：卡片缩放要按容器算（小窗口才装得下），
 * 命中测试的原点也要对得上（差几十像素就会选错卡）。
 */
function syncOrigin() {
    const stageEl = (sceneEl.value?.closest('.stage') as HTMLElement | null) ?? (document.querySelector('.stage') as HTMLElement | null);
    const r = stageEl?.getBoundingClientRect();
    const w = (r && r.width > 0) ? r.width : window.innerWidth;
    const h = (r && r.height > 0) ? r.height : window.innerHeight;
    const left = r ? r.left : 0;
    const top = r ? r.top : 0;
    show.setBox({
        w,
        h,
        ox: left + w / 2,
        oy: top + h / 2,
        p0y: top + h * 0.4,
        cw: cardW(),
        ch: cardH(),
    });
}

function setSlot(index: number, el: unknown) {
    show.setSlot(index, el instanceof HTMLElement ? el : null);
}

function clearTimers() {
    while (timers.length) window.clearTimeout(timers.pop());
}

function stopConfetti() {
    stopFx?.();
    stopFx = null;
    const canvas = fxRef.value;
    if (canvas) {
        const ctx = canvas.getContext('2d');
        if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
}

function fireConfetti() {
    const canvas = fxRef.value;
    const packer = caseRef.value;
    if (!canvas || !packer) return;
    stopConfetti();
    stopFx = burst(canvas, {
        vw: window.innerWidth,
        vh: window.innerHeight,
        getPose: () => packer.pose(),
        tearYAt: packer.tearYAt,
        count: 240,
    });
}

/**
 * 拆开这一段由**包装盒自己**负责（撕口、跟手、光流全在它的逐帧循环里）。
 *
 * 页面只做两件事：① 按钮/空格去叫它撕；② 它撕到底（`opened`）之后接着演卡片。
 * 时间轴以 `opened` 为 0 点 —— 撕多久由手决定，不能由一个固定延时假装。
 */
const caseRef = ref<InstanceType<typeof LuckyPack> | null>(null);

/**
 * 卡片编排：射出 → 螺旋 → 落位。全部在 `CardShow` 里逐帧算，页面只喂时间和指针。
 *
 * `pendingStart` 是因为 `opened` 事件里拿不到舞台时间 `t` —— 置个标志，
 * 下一帧主循环用当时的 `t` 作为"射出"的零点。别在事件里用 `performance.now()`：
 * 那和 `useStage` 的 `t` 不是同一个零点，卡片会整体飘几帧。
 */
let pendingStart = false;
const hoverIndex = ref(-1);
/** 键盘是否参与选卡：只有它走过一格，`activeIndex` 才被当作"抬起" */
const kbNav = ref(false);
let lastPack: PackPose | null = null;

/** 与 CSS 的 `--ph / --pw / --cw / --ch` 同一套公式（两处必须同值）
 *  自适应支持大屏（最大可自适应扩大至 680px，适配 2560px 宽屏） */
function packHeight(): number {
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    const target = Math.min(vh * 0.60, vw * 0.26);
    return Math.max(380, Math.min(680, target));
}
function packWidth(): number {
    return packHeight() * 0.69;
}
function cardW(): number {
    return packWidth() * 0.84;
}
function cardH(): number {
    return cardW() * 1.4;
}

/** 居中放大详情浮层状态 */
const inspectCardEl = ref<HTMLElement | null>(null);
const inspectingCard = ref<DrawCard | null>(null);
const inspectingIndex = ref(-1);
const inspectingLivePath = ref('');
const isResolvingPath = ref(false);
const copiedFeedback = ref(false);
const inspectingPaperStyle = ref<PaperStyle | null>(null);
let copyFeedbackTimer: number | null = null;

/** 卡片在视觉排布中从左到右的视觉 slot 序号（0 ~ count-1，左侧 slot 0，右侧 count - 1） */
function getVisualSlot(cardIndex: number, total: number = cards.value.length): number {
    if (total <= 0) return 0;
    return total - 1 - cardIndex;
}

/** 给定视觉 slot 序号（从左到右 0 ~ total-1），获取其对应的 cards 数组索引 */
function getCardIndexByVisualSlot(visualSlot: number, total: number = cards.value.length): number {
    if (total <= 0) return 0;
    return total - 1 - visualSlot;
}

const positionText = computed(() => {
    if (inspectingIndex.value < 0 || !cards.value.length) return '01/05';
    const visualSlot = getVisualSlot(inspectingIndex.value);
    return `${String(visualSlot + 1).padStart(2, '0')}/${String(cards.value.length).padStart(2, '0')}`;
});

/**
 * 放大卡片图窗背景图案（1:1 复刻源项目 holo-reverse 五大经典角色图窗背景）
 * - Holo rare (◆◆) => Ringo 星空渐变
 * - Ultra rare (★) => Star (Nova) 放射光芒
 * - Rare (◆) => Facet 棱镜深蓝渐变
 * - Common (●) => 随机使用 Blip（粉橙同心圆）或 Cubit（抹茶网格）
 */
const inspectWinBg = computed(() => {
    const card = inspectingCard.value;
    if (!card) return 'var(--ff-raised)';
    if (card.tier === 'ultra') {
        return 'var(--ff-card-win-star)';
    }
    if (card.tier === 'rare') {
        if (card.label === 'Holo rare') {
            return 'var(--ff-card-win-ringo)';
        }
        return 'var(--ff-card-win-facet)';
    }
    // common: 依据 sig 确定性伪随机分布在 Blip 和 Cubit 之间
    const hash = (card.sig || card.title || '').split('').reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
    return hash % 2 === 0 ? 'var(--ff-card-win-blip)' : 'var(--ff-card-win-cubit)';
});

/** 动态自适应字号：根据标题字符长度自动分档，保障长标题完整展现无省略 */
const titleClass = computed(() => {
    const len = inspectingCard.value?.title?.length ?? 0;
    if (len > 34) return 'inspect-title--xlong';
    if (len > 18) return 'inspect-title--long';
    return 'inspect-title--normal';
});

function onInspectPointerMove(ev: PointerEvent) {
    const el = inspectCardEl.value;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const y = ev.clientY - rect.top;
    const px = Math.max(0, Math.min(100, (x / rect.width) * 100));
    const py = Math.max(0, Math.min(100, (y / rect.height) * 100));
    const hyp = Math.min(1, Math.hypot(px - 50, py - 50) / 50);
    const rx = ((py - 50) / 50) * -7;
    const ry = ((px - 50) / 50) * 7;
    el.style.setProperty('--px', px.toFixed(1));
    el.style.setProperty('--py', py.toFixed(1));
    el.style.setProperty('--hyp', hyp.toFixed(2));
    el.style.setProperty('--rx', rx.toFixed(2));
    el.style.setProperty('--ry', ry.toFixed(2));
}

function onInspectPointerLeave() {
    const el = inspectCardEl.value;
    if (!el) return;
    el.style.setProperty('--px', '50');
    el.style.setProperty('--py', '50');
    el.style.setProperty('--hyp', '0');
    el.style.setProperty('--rx', '0');
    el.style.setProperty('--ry', '0');
}

function onCardSelect(card: DrawCard, index: number) {
    inspectingCard.value = card;
    inspectingIndex.value = index;
    inspectingPaperStyle.value = null;
    resolveCardAddress(card);
}

function onInspectArtLoaded(ev: Event) {
    if (inspectingCard.value?.tier !== 'common') return;
    const img = ev.target as HTMLImageElement;
    if (!img) return;
    const rgb = extractDominantHue(img);
    if (rgb) {
        inspectingPaperStyle.value = generatePaperStyle(rgb);
    }
}

function closeInspect() {
    inspectingCard.value = null;
    inspectingIndex.value = -1;
    inspectingLivePath.value = '';
    copiedFeedback.value = false;
    inspectingPaperStyle.value = null;
    if (copyFeedbackTimer !== null) {
        window.clearTimeout(copyFeedbackTimer);
        copyFeedbackTimer = null;
    }
}

function prevInspectCard() {
    if (!cards.value.length || inspectingIndex.value < 0) return;
    const curSlot = getVisualSlot(inspectingIndex.value);
    const prevSlot = (curSlot - 1 + cards.value.length) % cards.value.length;
    const nextIdx = getCardIndexByVisualSlot(prevSlot);
    inspectingIndex.value = nextIdx;
    inspectingCard.value = cards.value[nextIdx];
    inspectingPaperStyle.value = null;
    resolveCardAddress(cards.value[nextIdx]);
}

function nextInspectCard() {
    if (!cards.value.length || inspectingIndex.value < 0) return;
    const curSlot = getVisualSlot(inspectingIndex.value);
    const nextSlot = (curSlot + 1) % cards.value.length;
    const nextIdx = getCardIndexByVisualSlot(nextSlot);
    inspectingIndex.value = nextIdx;
    inspectingCard.value = cards.value[nextIdx];
    inspectingPaperStyle.value = null;
    resolveCardAddress(cards.value[nextIdx]);
}

function resolveCardAddress(card: DrawCard) {
    inspectingLivePath.value = '';
    isResolvingPath.value = false;

    // 离线卡绝对不调 resolveAnchor，直接走离线合成路径（杜绝触发后端 26 盘符强扫）
    if (!card.online) return;

    // 在线且前端已持有盘符，同步直出物理路径，0 次网络往返、0 延迟
    if (card.letter) {
        const fileName = pickFileName(card.src);
        const subDir = card.src.dir ? card.src.dir.replace(/\//g, '\\') : '';
        inspectingLivePath.value = `${card.letter}:\\${subDir ? subDir + '\\' : ''}${fileName}`;
        return;
    }

    // 极端边缘兜底：仅当标记在线但盘符映射缺失时才发起异步解析
    isResolvingPath.value = true;
    const anchor = anchorOf(card.src);
    getAction(`${API_BASE}/resolveAnchor?path=${encodeURIComponent(anchor)}`)
        .then(res => {
            if (res && typeof res.path === 'string') {
                inspectingLivePath.value = res.path;
            }
        })
        .catch(() => {
            // 离线或解析异常使用离线合成路径
        })
        .finally(() => {
            isResolvingPath.value = false;
        });
}

function getDisplayPath(card: DrawCard): string {
    if (inspectingLivePath.value) return inspectingLivePath.value;
    const fileName = pickFileName(card.src);
    const subDir = card.src.dir ? card.src.dir.replace(/\//g, '\\') : '';
    if (card.online && card.letter) {
        return `${card.letter}:\\${subDir ? subDir + '\\' : ''}${fileName}`;
    }
    return `[${card.serial}]\\${subDir ? subDir + '\\' : ''}${fileName}`;
}

async function copyAddress(card: DrawCard) {
    const textToCopy = getDisplayPath(card);
    let copied = false;
    try {
        const err = await ipcRenderer.invoke('copyText', textToCopy);
        if (!err) copied = true;
    } catch {
        // fallback
    }
    if (!copied && navigator.clipboard) {
        try {
            await navigator.clipboard.writeText(textToCopy);
            copied = true;
        } catch {
            // failed
        }
    }
    if (copied) {
        copiedFeedback.value = true;
        if (copyFeedbackTimer !== null) window.clearTimeout(copyFeedbackTimer);
        copyFeedbackTimer = window.setTimeout(() => {
            copiedFeedback.value = false;
            copyFeedbackTimer = null;
        }, 1800);
        notify('success', '已复制地址', textToCopy);
    } else {
        notify('error', '复制失败', '剪贴板写入受阻');
    }
}

async function revealCard(card: DrawCard) {
    const path = inspectingLivePath.value || (card.online && card.letter ? getDisplayPath(card) : '');
    if (!path) {
        notify('warning', '无法定位', '该磁盘当前未挂载在线，无法在资源管理器中定位。');
        return;
    }
    const err = await ipcRenderer.invoke('ff-reveal-item', path);
    if (err) {
        notify('error', '定位失败', String(err));
    }
}

/** 主进程 diskWatch 插拔广播事件（事件驱动，零轮询、零读盘更新在线集合与卡片状态） */
const onDisksChangedIpc = (_e: unknown, diskList: { serial: string; drive: string }[]) => {
    const list = Array.isArray(diskList) ? diskList : [];
    applyDisksUpdate(sources.value, list);
    if (sources.value) {
        const onlineSerials = sources.value.onlineSerials;
        const letters = sources.value.letters;
        for (const card of cards.value) {
            const online = onlineSerials.has(card.serial);
            card.online = online;
            card.letter = online ? (letters.get(card.serial) ?? '') : '';
        }
        if (inspectingCard.value) {
            const online = onlineSerials.has(inspectingCard.value.serial);
            inspectingCard.value.online = online;
            inspectingCard.value.letter = online ? (letters.get(inspectingCard.value.serial) ?? '') : '';
            resolveCardAddress(inspectingCard.value);
        }
    }
};

const stage = useStage((dt, t) => {
    // 包在 `open` 阶段会被 v-if 摘掉，所以缓存最后一帧的姿态给卡片用
    const pose = caseRef.value?.pose() ?? lastPack;
    if (!pose) return;
    lastPack = pose;

    if (pendingStart) {
        pendingStart = false;
        show.start(t, stage.reduce, pose);
        // 减少动态效果时不走 unwind（直接落位），flat 也要补上
        if (stage.reduce) sceneEl.value?.classList.add('is-flat');
    }
    // 只有在开包后才跑卡片帧计算，封包状态下零开销，确保卡包入场 60/120fps 满帧
    if (phase.value !== 'sealed') {
        // 只有键盘走过一格才把"选中"算作抬起；否则一进页面第一张就是浮着的（源码里没有这回事）
        show.setActive(kbNav.value ? activeIndex.value : -1);
        show.tick(t, dt, pose, stage.reduce);
    }
});

/** 指针落在哪张卡上（用落位几何算，不用它当前飞到的位置 —— 否则悬停会闪） */
function onPointer(ev: PointerEvent) {
    if (inspectingCard.value) return;
    if (phase.value !== 'open') return;
    const i = show.hitTest(ev.clientX, ev.clientY);
    if (i === hoverIndex.value) return;
    hoverIndex.value = i;
    show.setHover(i);
    if (i >= 0) {
        kbNav.value = false;
        // 声道按"它在整排里的第几张"分左右，用 slot 不用 i（i 是洗牌后的顺序）
        voices()?.lift(cards.value.length - 1 - i);
    }
}

function tearAll() {
    if (phase.value !== 'sealed' || !cards.value.length) return;
    caseRef.value?.tearAll();
}

function onOpened() {
    if (phase.value !== 'sealed') return;
    phase.value = 'opening';
    syncOrigin();
    pendingStart = true;
    lastPack = caseRef.value?.pose() ?? null;
    stage.start();
    fireConfetti();

    timers.push(window.setTimeout(() => {
        phase.value = 'open';
        activeIndex.value = 0;
    }, T_DONE));
}

function redraw() {
    closeInspect();
    const pool = sources.value;
    if (!pool) return;
    clearTimers();
    stopConfetti();
    voices()?.tick();

    const pack = drawPack(pool.sources, pool.onlineSerials, {
        includeOffline: effectiveIncludeOffline.value,
        exclude: new Set(recent.value),
    });
    // 等级按"一包的构成"洗牌（同参考站），不是按容量推算
    const rarities = rollRarities(pack.length);
    cards.value = pack.map((item, i) => cardOf(item, pool.onlineSerials, pool.letters, rarities[i]));
    // 封包飞入阶段（phase === 'sealed'）严禁加载/解码封面图片，0 线程争抢保障入场极致丝滑；
    // 待用户撕开卡包（phase 进入 opening）后，卡片在 1.45s 螺旋落位动画期间按需并行加载。
    skin.value = nextSkin(skin.value).key;
    recent.value = rememberRecent(recent.value, cards.value);
    activeIndex.value = 0;
    kbNav.value = false;
    hoverIndex.value = -1;
    sceneEl.value?.classList.remove('is-flat');
    phase.value = 'sealed';
    stage.stop();
    show.reset(cards.value.length);
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
    if (!card.online) {
        notify('warning', '磁盘未在线', `这块盘（序列号 ${card.serial}）现在没插。`);
        return;
    }
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

/** 卡片层挂上去之后才有矩形，命中测试的原点要等它落地 */
watch(cards, () => { void nextTick(syncOrigin); });

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

    if (inspectingCard.value) {
        if (ev.key === 'Escape') {
            ev.preventDefault();
            closeInspect();
            return;
        }
        if (ev.key === 'ArrowLeft') {
            ev.preventDefault();
            prevInspectCard();
            return;
        }
        if (ev.key === 'ArrowRight') {
            ev.preventDefault();
            nextInspectCard();
            return;
        }
        if (ev.key === 'Enter') {
            ev.preventDefault();
            void open(inspectingCard.value);
            return;
        }
        return;
    }

    if (ev.key === 'Escape') {
        ev.preventDefault();
        goFiles();
        return;
    }
    if (!cards.value.length) return;

    if (phase.value === 'sealed') {
        if (ev.key === ' ' || ev.key === 'Enter') {
            ev.preventDefault();
            tearAll();
        }
        return;
    }
    if (phase.value !== 'open') return;

    switch (ev.key) {
        case 'ArrowLeft':
            ev.preventDefault();
            kbNav.value = true;
            if (cards.value.length > 0) {
                const curSlot = getVisualSlot(activeIndex.value);
                const prevSlot = (curSlot - 1 + cards.value.length) % cards.value.length;
                activeIndex.value = getCardIndexByVisualSlot(prevSlot);
            }
            break;
        case 'ArrowRight':
            ev.preventDefault();
            kbNav.value = true;
            if (cards.value.length > 0) {
                const curSlot = getVisualSlot(activeIndex.value);
                const nextSlot = (curSlot + 1) % cards.value.length;
                activeIndex.value = getCardIndexByVisualSlot(nextSlot);
            }
            break;
        case 'Enter':
            ev.preventDefault();
            // 鼠标指着哪张就开哪张；没指就开键盘选中的那张
            void open(cards.value[hoverIndex.value >= 0 ? hoverIndex.value : activeIndex.value]);
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
    closeInspect();
    idleTimer = null;
    disposed = true;
    clearTimers();
    stopConfetti();
    cards.value = [];
    phase.value = 'sealed';
    loading.value = true;   // 回来时先转圈，不闪那张空态卡
}

function onResize() {
    syncOrigin();
    // 卡片落点按**新**的舞台尺寸重算（参考站 resize 里同一句）—— 少了它就是"没有自适应"
    show.refan();
}

function onPointerDown() {
    // 鼠标点击任意位置：取消方向键锁定的抬升状态，恢复卡片自身的自然呼吸摇摆动画
    if (kbNav.value) {
        kbNav.value = false;
        show.setActive(-1);
    }
}

onMounted(() => {
    syncOrigin();
    window.addEventListener('pointermove', onPointer);
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('resize', onResize);
    ipcRenderer.on('ff-disks-changed', onDisksChangedIpc);
});

onActivated(() => {
    if (phase.value !== 'sealed') stage.start();
    window.addEventListener('keydown', onKey);
    // ⚠️ 指针监听要在 activated 里补回来：deactivated 会卸掉它，只挂一次的话
    //    "切走再回来"之后就再也悬停不了了
    window.addEventListener('pointermove', onPointer);
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('resize', onResize);
    syncOrigin();
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
    window.removeEventListener('pointermove', onPointer);
    window.removeEventListener('pointerdown', onPointerDown);
    window.removeEventListener('resize', onResize);
    stage.stop();
    stopConfetti();
    clearTimers();
    idleTimer = window.setTimeout(disposeIdle, IDLE_DISPOSE_MS);
});

onBeforeUnmount(() => {
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('pointermove', onPointer);
    window.removeEventListener('pointerdown', onPointerDown);
    window.removeEventListener('resize', onResize);
    ipcRenderer.off('ff-disks-changed', onDisksChangedIpc);
    stage.stop();
    if (idleTimer !== null) window.clearTimeout(idleTimer);
    stopConfetti();
    clearTimers();
    sleepVoices();
});
</script>

<style scoped lang="less">
/* 抽卡页：舞台 + 上下两条 chrome。舞台尺寸与 `usable` 无关 —— 只跟视口走 */
.lucky {
    position: relative;
    width: 100%;
    height: 100%;
    overflow: hidden;
    background: var(--ff-canvas);
    color: var(--ff-text-1);

    /* 与 `LuckyPack` 里同一套尺寸：包高、包宽、卡宽、卡高。
       ⚠️ 两处必须同值 —— 卡片是从包口飞出来的，尺寸对不上就"从包外面冒出来"。
       自适应支持大屏（最大可自适应扩大至 680px，适配 2560px 宽屏）。 */
    --ph: clamp(380px, min(60vh, 26vw), 680px);
    --pw: calc(var(--ph) * .69);
    --cw: calc(var(--pw) * .84);
    --ch: calc(var(--cw) * 1.4);
    /* 舞台占满全高时，视觉重心微沉 */
    --pack-drop: clamp(10px, 3.2vh, 40px);
}

.top-warn {
    position: absolute;
    top: var(--ff-sp-3);
    left: var(--ff-sp-6);
    z-index: 10;
    pointer-events: none;
}

.warn {
    font-size: var(--ff-fs-meta);
    color: var(--ff-warn);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

/**
 * 舞台：占满父容器（.lucky）的全部宽高，中心与整个页面完全重合
 *
 * ⚠️ 必须显式 `grid-area: 1/1` 让所有直接子项**叠在同一格**。
 *    默认的 grid 是单列多行 —— 盒子占一行、扇形占一行，盒子会被挤到上方甚至挤出容器，
 *    真机表现就是"根本没看到开包，一进来就是五张卡"。
 *    同理 `grid-template` 要用 `minmax(0,1fr)`：写 `100%` 会把 padding 算到外面去。
 */
.stage {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    display: grid;
    grid-template: minmax(0, 1fr) / minmax(0, 1fr);
    place-items: center;
    padding: 0;
    overflow: hidden;
    /* 防止边缘卡片探出舞台 */
}

.stage>* {
    grid-area: 1 / 1;
}

.fx {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
    display: none;

    &.is-active {
        display: block;
    }
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
 * 卡片层：**绝对定位 + 每帧由 `CardShow` 写 transform**。
 *
 * ⚠️ 这里不许出现任何 `transition`。射出、螺旋、落位每一帧的位置都由 JS 算，
 *    CSS 过渡会把每一帧拖回上一帧 —— 表现是"跟着走但慢半拍、螺旋变成抖动的直线"。
 * ⚠️ 包还没开时整层不可见、层级压到包之下：否则五张卡会叠在包装**前面**，
 *    真机表现是"包装还没撕，卡片已经出来了"。
 */
.scene {
    position: absolute;
    inset: 0;
    translate: 0 var(--pack-drop);
    transform-style: preserve-3d;
    /* ⚠️ 透视必须挂在这一层：卡片有 `translateZ`（厚度、悬停抬升 110、螺旋进出 ±300），
       没有 perspective 的话 z 完全不产生视觉变化 —— 倾斜只剩"剪切"，读起来是一张平图。 */
    perspective: 1400px;
    perspective-origin: 50% 40%;
    pointer-events: none;
    z-index: 6;
    opacity: 0;
    transition: opacity 0.22s ease;

    &.is-inspecting {
        visibility: hidden !important;
        opacity: 0 !important;
        pointer-events: none !important;

        .slot {
            visibility: hidden !important;
        }
    }
}

/* 卡片出包之后：拆掉的 3D 上下文（参考站 `.scene.flat`）——
   五张卡各自成层、靠 z-index 排序，不再每帧做 3D 排序与前后的裁剪计算 */
.scene.is-flat {
    transform-style: flat;
}

.scene[data-phase='opening'],
.scene[data-phase='open'] {
    display: block;
    opacity: 1;
}

.scene[data-phase='sealed'] {
    z-index: 1;
    display: none;
    pointer-events: none;
}

/* 封包及开包动画中，卡片不可吞噬事件；落位后由每张卡自己处理 hover/click */
.scene:not([data-phase='open']) .slot {
    pointer-events: none;
}

/* 卡片的 3D 层：位移/旋转/缩放全在它身上（同一个元素上两套 transform 会互相覆盖） */
.slot {
    position: absolute;
    left: 50%;
    top: 50%;
    width: var(--cw);
    height: var(--ch);
    margin: calc(var(--ch) / -2) 0 0 calc(var(--cw) / -2);
    transform-style: preserve-3d;
    pointer-events: auto;
}

/* 仅在开包与展开阶段提升合成层，封包状态下释放合成瓦片内存 */
.scene:not([data-phase='sealed']) .slot {
    will-change: transform;
}

.bottom {
    position: absolute;
    bottom: var(--ff-sp-4);
    left: 0;
    right: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    z-index: 20;
    pointer-events: none;
}

.bottom-bar {
    display: inline-flex;
    align-items: center;
    height: 44px;
    padding: 0 var(--ff-sp-4);
    gap: var(--ff-sp-4);
    pointer-events: auto;
    user-select: none;
    transition: all 0.24s cubic-bezier(0.19, 1, 0.22, 1);
}

.bottom-action-group {
    display: inline-flex;
    align-items: center;
    gap: var(--ff-sp-3);
}

.redraw-btn {
    font-weight: 500;
}

.bottom-divider {
    width: 1px;
    height: 14px;
    background: var(--ff-line-strong);
    opacity: 0.6;
}

.bottom-opt-group {
    display: inline-flex;
    align-items: center;
}

.bottom-checkbox {
    user-select: none;
    font-size: var(--ff-fs-body);
}

.keys {
    font-size: var(--ff-fs-meta);
    color: var(--ff-text-2);
    display: inline-flex;
    align-items: center;
    white-space: nowrap;
}

kbd {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 18px;
    height: 18px;
    padding: 0 4px;
    margin: 0 2px;
    border-radius: var(--ff-r-ctl);
    border: 1px solid var(--ff-line);
    background: var(--ff-panel);
    color: var(--ff-text-1);
    font: inherit;
    font-size: var(--ff-fs-eyebrow);
    line-height: 1;
}

/* ── 居中放大详情浮层 ────────────────────────────────────────── */
.inspect-overlay {
    position: fixed;
    inset: 0;
    z-index: 100;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--ff-sp-4);
    background: color-mix(in srgb, var(--ff-canvas) 85%, transparent);
    backdrop-filter: blur(16px);
    -webkit-backdrop-filter: blur(16px);
    padding: var(--ff-sp-4);
    cursor: pointer;
    /* 点击卡片外部任意空白区域关闭 */
}

.inspect-zoom-enter-active,
.inspect-zoom-leave-active {
    transition: opacity 0.24s cubic-bezier(0.16, 1, 0.3, 1),
        backdrop-filter 0.24s cubic-bezier(0.16, 1, 0.3, 1);

    .inspect-card {
        transition: transform 0.24s cubic-bezier(0.16, 1, 0.3, 1),
            opacity 0.24s cubic-bezier(0.16, 1, 0.3, 1);
    }
}

.inspect-zoom-enter-from,
.inspect-zoom-leave-to {
    opacity: 0;

    .inspect-card {
        transform: scale(0.9) translateY(16px);
        opacity: 0;
    }
}

/* 详情卡主体：固定 5:7 黄金比例，保留实体卡纸三层叠片厚度与 3D 浮动感 */
.inspect-card {
    position: relative;
    width: clamp(320px, min(36vw, 58vh * 5 / 7), 520px);
    aspect-ratio: 5 / 7;
    transform-style: preserve-3d;
    outline: none;
    cursor: default;
    --px: 50;
    --py: 50;
    --hyp: 0;
    --rx: 0;
    --ry: 0;
    --frame: linear-gradient(165deg, var(--ff-card-paper-top), var(--ff-card-paper-bottom));
    --ink: var(--ff-card-ink);
    --edge: var(--ff-card-edge);

    transform: perspective(1200px) rotateX(calc(var(--rx, 0) * 1deg)) rotateY(calc(var(--ry, 0) * 1deg));
    transition: transform 0.12s ease-out;

    &.rare {
        --frame: linear-gradient(165deg, var(--ff-card-rare-top), var(--ff-card-rare-bottom));
        --ink: var(--ff-card-rare-ink);
        --edge: var(--ff-card-rare-edge);
    }

    &.ultra {
        --frame: var(--ff-card-ultra-frame);
        --ink: var(--ff-card-ultra-ink);
        --edge: var(--ff-card-ultra-edge);
    }

    .slab {
        position: absolute;
        inset: 0;
        border-radius: calc(var(--ff-r-card) * 1.6);
        background: var(--edge);
        transition: background 0.35s ease-out;
        pointer-events: none;

        &:nth-child(1) {
            transform: translateZ(-2px);
        }

        &:nth-child(2) {
            transform: translateZ(-4px);
        }

        &:nth-child(3) {
            transform: translateZ(-6px);
            box-shadow: var(--ff-card-stage-shadow-lift);
        }
    }
}

.inspect-face {
    position: absolute;
    inset: 0;
    border-radius: calc(var(--ff-r-card) * 1.6);
    overflow: hidden;
    background: var(--frame);
    color: var(--ink);
    transition: background 0.35s ease-out;
    display: flex;
    flex-direction: column;
    padding: 4.8%;
    gap: 3.5%;
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--ink) 14%, transparent);
    container-type: inline-size;
    isolation: isolate;
}

/* 封面图窗：与 file-finder 一致的 3:2 标准封面比例（--ff-cover-ratio） */
.inspect-win {
    position: relative;
    width: 100%;
    aspect-ratio: var(--ff-cover-ratio, 3 / 2);
    border-radius: var(--ff-r-ctl);
    overflow: hidden;
    display: flex;
    align-items: center;
    justify-content: center;
    background: color-mix(in srgb, var(--ink) 10%, transparent);
    box-shadow: inset 0 2px 6px color-mix(in srgb, black 35%, transparent), inset 0 0 0 1px color-mix(in srgb, var(--ink) 14%, transparent);
    z-index: 4;
    flex: none;
}

.rare .inspect-win,
.ultra .inspect-win {
    box-shadow: inset 0 2px 6px color-mix(in srgb, black 45%, transparent), inset 0 0 0 1px color-mix(in srgb, white 28%, transparent);
}

.inspect-art-backdrop {
    position: absolute;
    inset: 0;
    background-size: cover;
    background-position: center;
    filter: blur(18px);
    transform: scale(1.18);
    opacity: 0.45;
    pointer-events: none;
}

.inspect-art-img {
    position: relative;
    z-index: 2;
    width: 100%;
    height: 100%;
    object-fit: contain;
    object-position: center;
    display: block;
    user-select: none;
    filter: drop-shadow(0 3px 8px color-mix(in srgb, black 35%, transparent));
}

.inspect-art-empty {
    font-size: var(--ff-fs-body);
    color: color-mix(in srgb, var(--ink) 55%, transparent);
    font-weight: 500;
}

/* 浮动圆形播放按钮：半透毛玻璃质感，悬停高亮，不抢封面风头又极易认出 */
.inspect-play-circle {
    position: absolute;
    z-index: 5;
    width: 52px;
    height: 52px;
    border-radius: 50%;
    background: color-mix(in srgb, black 46%, transparent);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    border: 1.5px solid color-mix(in srgb, white 45%, transparent);
    color: white;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    box-shadow: 0 4px 18px color-mix(in srgb, black 50%, transparent);
    transition: transform 0.18s cubic-bezier(0.16, 1, 0.3, 1),
        background 0.18s ease,
        border-color 0.18s ease,
        box-shadow 0.18s ease;

    &:hover {
        transform: scale(1.12);
        background: var(--ff-highlight);
        border-color: transparent;
        box-shadow: 0 6px 24px color-mix(in srgb, black 60%, transparent),
            0 0 20px var(--ff-highlight-weak);
    }

    &:active {
        transform: scale(0.96);
    }
}

.inspect-play-triangle {
    width: 22px;
    height: 22px;
    margin-left: 3px;
}

/* 卡片信息排版：完全对齐 TCG 收藏卡语汇（顶层独立隔离，防全息噪点渗透） */
.inspect-content {
    position: relative;
    z-index: 8;
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    gap: 3%;
    isolation: isolate;
}

.inspect-row-title {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--ff-sp-2);
    min-width: 0;
}

/* 卡片标题：2 行动态自适应字号，杜绝单行被省略号截断 */
.inspect-title {
    margin: 0;
    font-weight: 800;
    line-height: 1.25;
    color: var(--ink);
    letter-spacing: -0.01em;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    word-break: break-word;

    &.inspect-title--normal {
        font-size: clamp(15px, 4.6cqw, 19px);
    }

    &.inspect-title--long {
        font-size: clamp(13px, 3.8cqw, 15.5px);
    }

    &.inspect-title--xlong {
        font-size: clamp(11.5px, 3.2cqw, 13.5px);
    }
}

.inspect-type {
    padding: 4px 10px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--ink) 14%, transparent);
    font: 700 13px/1 var(--ff-font);
    letter-spacing: 0.06em;
    white-space: nowrap;
    flex: none;
    backface-visibility: hidden;
    transform: translateZ(0);
    -webkit-font-smoothing: antialiased;
    text-rendering: geometricPrecision;
}

.inspect-type--off {
    background: var(--ff-danger-badge);
    color: var(--ff-on-danger);
    border: 1px solid color-mix(in srgb, white 25%, transparent);
    box-shadow: 0 1px 4px color-mix(in srgb, black 35%, transparent);
}

/* 规格子行 */
.inspect-meta-row {
    display: flex;
    align-items: center;
    gap: 5px;
    font-size: var(--ff-fs-eyebrow);
    color: color-mix(in srgb, var(--ink) 70%, transparent);
    font-variant-numeric: tabular-nums;
    min-width: 0;
}

.inspect-meta-item {
    font-weight: 600;
    white-space: nowrap;
}

.inspect-meta-serial {
    font-family: monospace;
    opacity: 0.85;
}

.inspect-meta-dot {
    opacity: 0.4;
}

.inspect-meta-rarity {
    margin-left: auto;
    font-weight: 700;
    color: var(--ink);
    opacity: 0.9;
    white-space: nowrap;
}

.inspect-rule {
    width: 100%;
    height: 1px;
    background: currentColor;
    opacity: 0.15;
}

/* 存储地址铭牌：游戏王卡牌效果说明栏排版，无截断换行展示 */
.inspect-address-plate {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px 10px;
    background: color-mix(in srgb, var(--ink) 7%, transparent);
    border: 1px solid color-mix(in srgb, var(--ink) 14%, transparent);
    border-radius: var(--ff-r-ctl);
    min-width: 0;
    flex: 1;
    min-height: 0;
}

.inspect-address-header {
    display: flex;
    align-items: center;
    gap: var(--ff-sp-2);
    flex: none;
}

.inspect-address-tag {
    font-size: var(--ff-fs-eyebrow);
    font-weight: 700;
    color: color-mix(in srgb, var(--ink) 70%, transparent);
    letter-spacing: 0.04em;
}

.inspect-address-text {
    font-size: var(--ff-fs-eyebrow);
    font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
    line-height: 1.45;
    color: var(--ink);
    word-break: break-all;
    white-space: normal;
    overflow-y: auto;
    user-select: text;
}

.inspect-resolving {
    opacity: 0.6;
    font-style: italic;
}

/* 材质层：全息 / 眩光 / 清漆 */
.inspect-card .holo,
.inspect-card .glare {
    position: absolute;
    inset: 0;
    z-index: 2;
    border-radius: inherit;
    pointer-events: none;
}

.inspect-card .holo {
    background: var(--ff-card-foil) calc(var(--px) * 1%) calc(var(--py) * 1%) / 400% 400%;
    mix-blend-mode: color-dodge;
    opacity: calc(0.3 + var(--hyp) * 0.6);
    filter: brightness(0.7) contrast(1.5) saturate(1.4);

    &::after {
        content: '';
        position: absolute;
        inset: 0;
        border-radius: inherit;
        background: inherit;
        mask: var(--ff-glitter) 0 0 / 140px 140px;
        filter: brightness(1.8);
    }
}

.inspect-card.common .holo {
    display: none;
}

.inspect-card.ultra .holo {
    mix-blend-mode: overlay;
    opacity: calc(0.5 + var(--hyp) * 0.5);
    background:
        repeating-conic-gradient(from calc(var(--px) * 1deg) at 50% 40%,
            transparent 0 3deg,
            color-mix(in srgb, white 45%, transparent) 4deg 5deg,
            transparent 6deg 10deg),
        var(--ff-card-foil) calc(var(--px) * 1%) calc(var(--py) * 1%) / 400% 400%;
}

.inspect-card .glare {
    background: radial-gradient(farthest-corner circle at calc(var(--px) * 1%) calc(var(--py) * 1%),
            color-mix(in srgb, white 80%, transparent),
            color-mix(in srgb, white 12%, transparent) 38%,
            color-mix(in srgb, black 30%, transparent));
    mix-blend-mode: overlay;
    opacity: calc(0.25 + var(--hyp) * 0.55);
}

.inspect-card .glaze {
    position: absolute;
    inset: 0;
    z-index: 3;
    border-radius: inherit;
    pointer-events: none;
    box-shadow:
        inset 0 0 0 1px color-mix(in srgb, white 28%, transparent),
        inset 0 2px 1.5px color-mix(in srgb, white 80%, transparent),
        inset 0 -2px 4px color-mix(in srgb, black 18%, transparent);
    background:
        radial-gradient(42% 26% at calc(var(--px) * 1%) calc(var(--py) * 1%),
            color-mix(in srgb, white calc((0.1 + var(--hyp) * 0.5) * 100%), transparent), transparent),
        linear-gradient(color-mix(in srgb, white 24%, transparent), transparent 16%);
}

.inspect-card .glaze::before {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: inherit;
    mask: linear-gradient(black 30%, transparent 88%);
    background: linear-gradient(112deg,
            transparent 44%,
            color-mix(in srgb, white 40%, transparent) 44.4%,
            color-mix(in srgb, white 13%, transparent) 52%,
            transparent 52.4%,
            transparent 54%,
            color-mix(in srgb, white 22%, transparent) 54.3%,
            color-mix(in srgb, white 5%, transparent) 56.4%,
            transparent 56.7%) calc((100 - var(--px)) * 1%) 0 / 220% 100%;
}

/* 浮动翻卡按钮（保留在屏幕左右两侧供鼠标点击） */
.inspect-nav-btn {
    width: 44px;
    height: 44px;
    border-radius: 50%;
    border: 1px solid var(--ff-line);
    background: var(--ff-panel);
    color: var(--ff-text-1);
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    box-shadow: var(--ff-overlay-shadow);
    transition: transform 0.15s, background 0.15s;
    flex: none;

    &:hover {
        transform: scale(1.08);
        background: var(--ff-raised-hover);
    }

    svg {
        width: 20px;
        height: 20px;
    }
}

@media (prefers-reduced-motion: reduce) {

    /* 卡片的位移全部由逐帧循环写，`prefers-reduced-motion` 时循环把 dt 归零、
       直接落位（见 `useStage`），此处无需再声明任何过渡 */
    .scene,
    .slot {
        transition: none;
    }
}
</style>
