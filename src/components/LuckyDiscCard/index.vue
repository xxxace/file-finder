<template>
    <article
        class="card"
        :class="[card.tier, { 'is-active': active }]"
        :style="paperStyle ? { '--frame': paperStyle.frame, '--edge': paperStyle.edge } : undefined"
        role="button"
        tabindex="0"
        :aria-label="card.title"
        @click="emit('select', card, index)"
        @dblclick="emit('open', card)"
        @focus="emit('focus', index)"
        @keydown.enter.prevent="emit('select', card, index)"
    >
        <span class="slab" aria-hidden="true" />
        <span class="slab" aria-hidden="true" />
        <span class="slab" aria-hidden="true" />

        <div class="face">
            <!-- 封面图窗：与参考站一致的版式与圆角，z-index: 4 独立层级保护，绝无全息杂色污染 -->
            <div class="win">
                <img
                    v-if="revealed && !broken && card.sig"
                    class="art"
                    :src="thumbUrl(`t-${card.sig}.enc`)"
                    alt=""
                    crossorigin="anonymous"
                    draggable="false"
                    @load="onArtLoaded"
                    @error="broken = true"
                >
                <div v-else class="art art--paper">{{ card.sig.slice(0, 6) || '无封面' }}</div>
            </div>

            <!-- 三层真实材质：全息箔 / 眩光 / 清漆 -->
            <i class="holo" aria-hidden="true" />
            <i class="glare" aria-hidden="true" />
            <i class="glaze" aria-hidden="true" />

            <!-- 卡面文字信息层：独立层级（z-index: 8），杜绝全息噪点穿透，保障离线标签锐利高对比 -->
            <div class="info-layer">
                <b class="name">{{ card.title }}</b>
                <span class="type" :class="{ 'type--off': !card.online }">
                    {{ card.online ? (card.letter ? `${card.letter} 盘` : '在线') : '离线' }}
                </span>
                <i class="rule" aria-hidden="true" />
                <span class="no">{{ position }}/{{ String(count).padStart(2, '0') }} · {{ card.sizeText || '—' }}</span>
                <span class="rar">{{ card.mark }} {{ card.label }}</span>
            </div>
        </div>
    </article>
</template>

<script setup lang="ts">
/**
 * 一张卡 —— 版式与材质整体对齐 `holo-reverse` 的 `.card`（源码 `cardHTML` + `styles.css`）：
 * 三层叠片 / 图窗 / 名字 / 类型胶囊 / 分隔线 / 编号 / 等级 / holo / glare / glaze。
 * 只把它的"角色插画 + 稀有度"换成真实数据（封面 + 容量档）。
 *
 * ## 三条纪律
 *
 * ① **本组件不碰 transform、不监听指针。** 位移/倾斜全由 `CardShow` 逐帧写在外层 `.slot` 上
 *    （卡内自算倾角会形成"转→包围盒变→角度又变"的正反馈，真机表现就是鼠标在上面抖）。
 * ② 卡面的 `--px / --py / --hyp` 也逐帧写（由卡自己的 `ry / rx` 反推），光永远贴在卡面上。
 * ③ `cqw` 只在 `.face` 里面用（它带 `container-type: inline-size`）；`.slab` 在外面，只能用 `--cw`。
 *
 * ## 等级（三档视觉 / 四个标签）
 *
 * | 档 | 卡纸 | 箔 | 标签 |
 * |---|---|---|---|
 * | `common` | 暖白 | 纯净纸面，无全息 | ● Common |
 * | `rare`   | 深蓝 | 卡框全息箔 + 闪点 | ◆ Rare / ◆◆ Holo rare |
 * | `ultra`  | 金箔 | 卡框放射光芒 + 全息彩虹 | ★ Ultra rare |
 *
 * ⚠️ 箔、眩光、清漆**永不铺到封面照片上**：图窗位于独立层级（z-index: 4），
 *    物理置于全息箔（z=2）、眩光（z=2）、清漆（z=3）之上，底色采用 var(--frame) 兜底，
 *    封面图片纯净真实呈现，无遮挡无染色，四周自然呈现圆角装裱。
 */
import { computed, ref, watch } from 'vue';
import { thumbUrl } from '@/utils/thumb';
import type { DrawCard } from '@/views/Lucky/drawModel';
import { extractDominantHue, generatePaperStyle } from '@/views/Lucky/extractColor';
import type { PaperStyle } from '@/views/Lucky/extractColor';

const props = withDefaults(defineProps<{
    card: DrawCard;
    index: number;
    count: number;
    revealed?: boolean;
    active?: boolean;
}>(), {
    revealed: true,
    active: false,
});

const emit = defineEmits<{
    open: [card: DrawCard];
    select: [card: DrawCard, index: number];
    focus: [index: number];
}>();

const broken = ref(false);
const position = computed(() => String(props.index + 1).padStart(2, '0'));
const paperStyle = ref<PaperStyle | null>(null);

function onArtLoaded(ev: Event) {
    // 仅 Common 卡片根据封面色提取生成淡彩纸面；Rare 与 Ultra 保持原版定义
    if (props.card.tier !== 'common') return;
    const img = ev.target as HTMLImageElement;
    if (!img) return;
    const rgb = extractDominantHue(img);
    if (rgb) {
        paperStyle.value = generatePaperStyle(rgb);
    }
}

watch(() => props.card.sig, () => {
    broken.value = false;
    paperStyle.value = null;
});
</script>

<style scoped lang="less">
.card {
    position: relative;
    width: 100%;
    height: 100%;
    cursor: pointer;
    outline: none;
    transform-style: preserve-3d;
    touch-action: none;
    --px: 50;
    --py: 50;
    --hyp: 0;
    /* 三档卡面的形状语言：卡纸、字色、侧面。等级类只改这三个变量 */
    --frame: linear-gradient(165deg, var(--ff-card-paper-top), var(--ff-card-paper-bottom));
    --ink: var(--ff-card-ink);
    --edge: var(--ff-card-edge);

    &:focus-visible .face {
        outline: 2px solid var(--ff-highlight);
        outline-offset: 3px;
    }
}

.card.rare {
    --frame: linear-gradient(165deg, var(--ff-card-rare-top), var(--ff-card-rare-bottom));
    --ink: var(--ff-card-rare-ink);
    --edge: var(--ff-card-rare-edge);
}

.card.ultra {
    --frame: var(--ff-card-ultra-frame);
    --ink: var(--ff-card-ultra-ink);
    --edge: var(--ff-card-ultra-edge);
}

/**
 * 厚度：三层叠片（参考站 `.slab`，颜色是卡纸的侧面而不是界面底色）。
 *
 * ⚠️ 圆角必须用 `calc(var(--cw) * .05)`，**不能用 cqw** ——
 *    `.slab` 不在 `.face` 里面，`cqw` 会一路找到视口，5cqw 变成 64px 的圆饼。
 */
.slab {
    position: absolute;
    inset: 0;
    border-radius: calc(var(--cw) * 0.05);
    background: var(--edge);
    transition: background 0.35s ease-out;
    pointer-events: none;

    &:nth-child(1) { transform: translateZ(-1.5px); }
    &:nth-child(2) { transform: translateZ(-3px); }
    &:nth-child(3) {
        transform: translateZ(-4.5px);
        box-shadow: var(--ff-card-stage-shadow);
        transition: box-shadow 0.22s ease-out, background 0.35s ease-out;
    }
}

.card:hover .slab:nth-child(3),
.card.is-active .slab:nth-child(3) {
    box-shadow: var(--ff-card-stage-shadow-lift);
}

/* 卡面：`container-type` 让下面所有尺寸都按卡宽的百分比走 ——
   窄窗下 `fanSpot` 会把卡片缩小，字号与留白必须一起缩 */
.face {
    position: absolute;
    inset: 0;
    border-radius: calc(var(--cw) * 0.05);
    overflow: hidden;
    isolation: isolate;
    container-type: inline-size;
    background: var(--frame);
    color: var(--ink);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--ink) 12%, transparent);
    transition: background 0.35s ease-out;
}

/* 图窗：占 60% 高，四周留纸边 —— 独立层级（z-index: 4），物理遮挡底层材质，绝不叠加任何滤镜/眩光/清漆/全息，确保封面纯净无遮挡 */
.win {
    position: absolute;
    left: 6%;
    right: 6%;
    top: 4.3%;
    height: 60%;
    border-radius: calc(var(--cw) * 0.04);
    overflow: hidden;
    z-index: 4;
    background: var(--frame);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--ink) 12%, transparent);
}

.art {
    width: 100%;
    height: 100%;
    object-fit: cover;
    user-select: none;
    display: block;
    border-radius: inherit;
}

.art--paper {
    display: grid;
    place-items: center;
    font: 500 9cqw/1 var(--ff-font);
    letter-spacing: 0.06em;
    color: color-mix(in srgb, var(--ink) 55%, transparent);
    border-radius: inherit;
    background: var(--frame);
}

/* 稀有 / 金卡：图窗外框 1px 细线（纯净精确，绝不叠加内阴影污损封面） */
.rare .win,
.ultra .win {
    box-shadow: inset 0 0 0 1px color-mix(in srgb, white 30%, transparent);
}

/* ── 文字信息层（顶层独立隔离，绝不被全息噪点渗透，离线标签锐利无发虚） ────────────── */
.info-layer {
    position: absolute;
    inset: 0;
    z-index: 8;
    pointer-events: none;
    isolation: isolate;
}

/* 名字：参考站是 9.5cqw，我们的作品名长得多（中文 + 番号），
   降到 7.4cqw 才装得下两个整字前缀而不至于被省略号吃掉大半 */
.name {
    position: absolute;
    left: 7%;
    right: 30%;
    top: 68.5%;
    font: 700 7.4cqw/1.06 var(--ff-font);
    letter-spacing: -0.02em;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.type {
    position: absolute;
    right: 7%;
    top: 69.5%;
    padding: 2.4cqw 4cqw;
    border-radius: 999px;
    background: color-mix(in srgb, currentColor 16%, transparent);
    font: 700 max(13px, 5.2cqw)/1 var(--ff-font);
    letter-spacing: 0.08em;
    white-space: nowrap;
    backface-visibility: hidden;
    transform: translateZ(0);
    -webkit-font-smoothing: antialiased;
    text-rendering: geometricPrecision;
}

.type--off {
    color: var(--ff-on-danger);
    background: var(--ff-danger-badge);
    border: 1px solid color-mix(in srgb, white 25%, transparent);
    box-shadow: 0 1px 4px color-mix(in srgb, black 40%, transparent);
}

.rule {
    position: absolute;
    left: 7%;
    right: 7%;
    top: 83%;
    height: 1px;
    background: currentColor;
    opacity: 0.15;
}

.no,
.rar {
    position: absolute;
    bottom: 5.5%;
    font: 500 3.8cqw/1 var(--ff-font);
    font-variant-numeric: tabular-nums;
}

.no {
    left: 7%;
    right: 40%;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    opacity: 0.6;
}
.rar { right: 7%; font-weight: 600; opacity: 0.8; }

/* ── 三层材质 ─────────────────────────────────────────────────────────────
   ① `holo`  全息箔（z=2，位于图窗之下，仅在卡框展现，绝不污染封面图片颜色）；
   ② `glare` 眩光（z=2，位于图窗之下，透明反光层，随光照移动）；
   ③ `glaze` 清漆（z=3，位于图窗之下，倒角高光与影棚窗反光，全体卡片包括普卡均有通透保护光泽）。 */
.holo,
.glare {
    position: absolute;
    inset: 0;
    z-index: 2;
    border-radius: inherit;
    pointer-events: none;
}

.holo {
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

/* 普通档：卡纸实体无全息箔（符合 TCG 普卡实体规范，全包无闪点污损封面；glare 与 glaze 材质与全卡共享） */
.common .holo {
    display: none;
}

/* 金卡（Ultra rare）：1:1 复刻原版 overlay 混合与放射星芒，细密闪点璀璨闪烁 */
.ultra .holo {
    mix-blend-mode: overlay;
    opacity: calc(0.5 + var(--hyp) * 0.5);
    background:
        repeating-conic-gradient(from calc(var(--px) * 1deg) at 50% 40%,
            transparent 0 3deg,
            color-mix(in srgb, white 45%, transparent) 4deg 5deg,
            transparent 6deg 10deg),
        var(--ff-card-foil) calc(var(--px) * 1%) calc(var(--py) * 1%) / 400% 400%;
}

.glare {
    background: radial-gradient(farthest-corner circle at calc(var(--px) * 1%) calc(var(--py) * 1%),
        color-mix(in srgb, white 80%, transparent),
        color-mix(in srgb, white 12%, transparent) 38%,
        color-mix(in srgb, black 30%, transparent));
    mix-blend-mode: overlay;
    opacity: calc(0.25 + var(--hyp) * 0.55);
}

.glaze {
    position: absolute;
    inset: 0;
    z-index: 3;
    border-radius: inherit;
    pointer-events: none;
    box-shadow:
        inset 0 0 0 1px color-mix(in srgb, white 28%, transparent),
        inset 0 2px 1.5px color-mix(in srgb, white 80%, transparent),
        inset 0 -2px 4px color-mix(in srgb, black 18%, transparent);
    /* 清漆上的高光点：亮度随倾角涨（越斜越亮），与参考站同一式 */
    background:
        radial-gradient(42% 26% at calc(var(--px) * 1%) calc(var(--py) * 1%),
            color-mix(in srgb, white calc((0.1 + var(--hyp) * 0.5) * 100%), transparent), transparent),
        linear-gradient(color-mix(in srgb, white 24%, transparent), transparent 16%);
}

/* 两扇"影棚窗"的反射：随倾斜**反向**滑过卡面（卡往右转，窗往左滑） */
.glaze::before {
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
</style>
