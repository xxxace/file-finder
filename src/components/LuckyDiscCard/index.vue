<template>
    <article
        class="card"
        :class="{ 'is-offline': !card.online, 'is-active': active }"
        :data-foil="foil"
        role="button"
        tabindex="0"
        :aria-label="card.title"
        @pointermove="onMove"
        @pointerleave="onLeave"
        @dblclick="emit('open', card)"
        @focus="emit('focus', index)"
        @keydown.enter.prevent="emit('open', card)"
    >
        <span class="slab" aria-hidden="true" />
        <span class="slab" aria-hidden="true" />
        <span class="slab" aria-hidden="true" />

        <div class="face">
            <!-- 图窗：60% 高、圆角、内阴影 —— 与参考站的卡同一个版式 -->
            <div class="win">
                <img
                    v-if="!broken && card.sig"
                    class="art"
                    :src="thumbUrl(`t-${card.sig}.enc`)"
                    alt=""
                    draggable="false"
                    @error="broken = true"
                >
                <div v-else class="art art--paper">{{ card.sig.slice(0, 6) || '无封面' }}</div>
            </div>

            <b class="name">{{ card.title }}</b>
            <span class="type" :class="card.online ? 'type--online' : 'type--offline'">
                {{ card.online ? (card.letter ? `${card.letter} 盘` : '在线') : '离线' }}
            </span>
            <i class="rule" aria-hidden="true" />
            <span class="no">{{ position }} / {{ String(count).padStart(2, '0') }}</span>
            <span class="rar">{{ card.sizeText || '—' }}</span>

            <span class="glare" aria-hidden="true" />
            <span class="glaze" aria-hidden="true" />
        </div>
    </article>
</template>

<script setup lang="ts">
/**
 * 一张卡 —— 版式完全对齐参考站（卡纸 + 图窗 + 名字 + 类型胶囊 + 分隔线 + 编号/信息），
 * 只把它的"角色插画 / 稀有度"换成我们的真实数据（封面 / 盘符 / 容量）。
 *
 * ## 为什么上一版"不够好看"
 *
 * 上一版是"封面铺满 + 底部一条黑字幕条" —— 那是视频缩略图的排版，不是实体卡的排版。
 * 实体卡有**卡纸留白**：图窗只占 60%，四周是纸，下面是名字与编号。
 * 留白本身就在告诉人"这是一张印出来的东西"。这一版把留白补回来了。
 *
 * ## 质感仍是三层
 * ① 清漆 `glaze`：玻璃倒角 + 顶部亮线 + 随倾斜滑动的窗反射；
 * ② 眩光 `glare`：径向高光跟随指针，`overlay` 混合；
 * ③ 厚度 `slab`：三层 `translateZ`，颜色取 `--ff-canvas`（恰好比纸暗一档）。
 */
import { computed, ref } from 'vue';
import { thumbUrl } from '@/utils/thumb';
import type { DrawCard } from '@/views/Lucky/drawModel';
import { tiltOf } from '@/views/Lucky/discCase';

const props = withDefaults(defineProps<{
    card: DrawCard;
    index: number;
    count: number;
    active?: boolean;
    foil?: 'none' | 'all' | 'deco';
}>(), {
    active: false,
    foil: 'deco',
});

const emit = defineEmits<{
    open: [card: DrawCard];
    focus: [index: number];
}>();

const broken = ref(false);
const position = computed(() => String(props.index + 1).padStart(2, '0'));

function onMove(ev: PointerEvent) {
    const el = ev.currentTarget as HTMLElement;
    const rect = el.getBoundingClientRect();
    const nx = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
    const ny = ((ev.clientY - rect.top) / rect.height) * 2 - 1;
    const tilt = tiltOf(nx, ny);
    el.style.setProperty('--px', tilt.px.toFixed(2));
    el.style.setProperty('--py', tilt.py.toFixed(2));
    el.style.setProperty('--hyp', tilt.hyp.toFixed(4));
    el.style.setProperty('--rx', tilt.rx.toFixed(2) + 'deg');
    el.style.setProperty('--ry', tilt.ry.toFixed(2) + 'deg');
}

function onLeave(ev: PointerEvent) {
    const el = ev.currentTarget as HTMLElement;
    el.style.setProperty('--px', '50');
    el.style.setProperty('--py', '50');
    el.style.setProperty('--hyp', '0');
    el.style.setProperty('--rx', '0deg');
    el.style.setProperty('--ry', '0deg');
}
</script>

<style scoped lang="less">
.card {
    position: relative;
    width: 100%;
    height: 100%;
    cursor: pointer;
    outline: none;
    transform-style: preserve-3d;
    transform: rotateX(var(--rx, 0deg)) rotateY(var(--ry, 0deg));
    --px: 50;
    --py: 50;
    --hyp: 0;

    &:focus-visible .face {
        outline: 2px solid var(--ff-highlight);
        outline-offset: 3px;
    }
}

/**
 * 厚度：三层叠片。
 *
 * ⚠️ 圆角必须用 `calc(var(--cw) * .05)`，**不能用 cqw**。
 *    `cqw` 是"最近的容器"的 1%，而 `.slab` 不在 `.face` 里面 ⇒ 它一路找上去，
 *    最后落在**视口**上 —— 5cqw 变成 64px，卡片被削成圆饼（真机就是这么丑的）。
 */
.slab {
    position: absolute;
    inset: 0;
    border-radius: calc(var(--cw) * 0.05);
    background: var(--ff-canvas);
    pointer-events: none;

    &:nth-child(1) { transform: translateZ(-1.5px); }
    &:nth-child(2) { transform: translateZ(-3px); }
    &:nth-child(3) {
        transform: translateZ(-4.5px);
        box-shadow: 0 26px 40px -18px var(--ff-jewel-shadow);
    }
}

/**
 * 卡面：卡纸。
 *
 * `container-type: inline-size` 让下面全部尺寸都用 `cqw`（= 卡宽的 1%）——
 * 窄屏下 `fanSpot` 会把卡片缩到 0.6 倍，字号、圆角、图窗留白必须一起缩，
 * 否则缩完就是"字占满整张卡"。
 */
.face {
    position: absolute;
    inset: 0;
    /* 同上：`container-type` 的元素**不能查询自己** ⇒ 这里的 cqw 也会落到视口。
       5% 卡宽 = 一张实体卡的标准圆角。 */
    border-radius: calc(var(--cw) * 0.05);
    overflow: hidden;
    isolation: isolate;
    container-type: inline-size;
    background: linear-gradient(165deg, var(--ff-card-paper-top), var(--ff-card-paper-bottom));
    color: var(--ff-card-ink);
    box-shadow: inset 0 0 0 1px var(--ff-line);
}

/* 图窗：占 60% 高，四周留纸边 —— 留白是"这是印刷品"的主要信号 */
.win {
    position: absolute;
    left: 6%;
    right: 6%;
    top: 4.3%;
    height: 60%;
    border-radius: calc(var(--cw) * 0.04);
    overflow: hidden;
    background: var(--ff-card-paper-bottom);
    box-shadow:
        inset 0 2px 5px color-mix(in srgb, var(--ff-card-ink) 28%, transparent),
        inset 0 0 0 1px color-mix(in srgb, var(--ff-card-ink) 12%, transparent);
}

.art {
    width: 100%;
    height: 100%;
    object-fit: cover;
    user-select: none;
}

.art--paper {
    display: grid;
    place-items: center;
    font: 500 calc(var(--cw) * .09)/1 var(--ff-font);
    letter-spacing: 0.06em;
    color: color-mix(in srgb, var(--ff-card-ink) 55%, transparent);
}

/* 图窗四周那一圈"闪面"：箔只在这条 1px 的边上，不碰封面内容 */
.card[data-foil='deco'] .win::after,
.card[data-foil='all'] .win::after {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: inherit;
    pointer-events: none;
    box-shadow: inset 0 0 0 1px var(--ff-foil-b);
    opacity: calc(0.3 + var(--hyp) * 0.45);
}

.name {
    position: absolute;
    left: 7%;
    /* 右侧要给类型胶囊让位（它固定在 right:7%）。作品名常常很长，
       不留空间就会顶到胶囊上 —— 参考站的名字短（"Cubit"）所以没这个问题。 */
    right: 34%;
    top: 68.5%;
    font: 500 calc(var(--cw) * .076)/1.15 var(--ff-font);
    letter-spacing: -0.01em;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.type {
    position: absolute;
    right: 7%;
    top: 69.6%;
    padding: calc(var(--cw) * .014) calc(var(--cw) * .022);
    border-radius: calc(var(--cw) * .09);
    font: 500 calc(var(--cw) * .038)/1 var(--ff-font);
    letter-spacing: 0.05em;
    white-space: nowrap;
}

.type--online {
    background: color-mix(in srgb, var(--ff-foil-b) 46%, transparent);
    color: var(--ff-card-ink);
}

.type--offline {
    background: color-mix(in srgb, var(--ff-danger-badge) 22%, transparent);
    color: var(--ff-danger-badge);
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
    font: 400 calc(var(--cw) * .034)/1 var(--ff-font);
    font-variant-numeric: tabular-nums;
    color: color-mix(in srgb, var(--ff-card-ink) 58%, transparent);
}

.no { left: 7%; }
.rar { right: 7%; }

/* ── 光照层 ──────────────────────────────────────────────────────────────── */

.glare,
.glaze {
    position: absolute;
    inset: 0;
    border-radius: inherit;
    pointer-events: none;
}

.glare {
    z-index: 2;
    background: radial-gradient(farthest-corner circle at calc(var(--px) * 1%) calc(var(--py) * 1%),
        var(--ff-jewel-edge), transparent 38%, var(--ff-jewel-shadow));
    mix-blend-mode: overlay;
    opacity: calc(0.2 + var(--hyp) * 0.5);
}

.glaze {
    z-index: 3;
    box-shadow:
        inset 0 0 0 1px var(--ff-jewel-edge),
        inset 0 2px 1.5px var(--ff-jewel-edge),
        inset 0 -2px 4px var(--ff-jewel-shadow);
    background:
        radial-gradient(42% 26% at calc(var(--px) * 1%) calc(var(--py) * 1%),
            var(--ff-jewel-edge), transparent),
        linear-gradient(var(--ff-jewel-edge), transparent 16%);
    opacity: 0.5;
}

/* 两条"影棚窗"反射：随倾斜反向滑动 */
.glaze::before {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: inherit;
    mask: linear-gradient(black 30%, transparent 88%);
    background: linear-gradient(112deg,
        transparent 44%, var(--ff-jewel-edge) 44.4%, transparent 52%,
        transparent 54%, var(--ff-jewel-edge) 54.3%, transparent 56.7%)
        calc((100 - var(--px)) * 1%) 0 / 220% 100%;
    opacity: 0.38;
}

.is-active .face {
    outline: 2px solid var(--ff-highlight);
    outline-offset: 3px;
}
</style>
