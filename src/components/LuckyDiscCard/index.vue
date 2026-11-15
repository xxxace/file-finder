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
        <!-- 厚度：三层叠片 = 斜看时的纸侧剖面。不是 box-shadow 能糊弄过去的 -->
        <span class="slab" aria-hidden="true" />
        <span class="slab" aria-hidden="true" />
        <span class="slab" aria-hidden="true" />

        <div class="face">
            <img
                v-if="!broken && card.sig"
                class="art"
                :src="thumbUrl(`t-${card.sig}.enc`)"
                alt=""
                draggable="false"
                @error="broken = true"
            >
            <!-- 封面取不到（bin 被清 / sig 假）时不许留白洞：给纸色 + 指纹前 6 位 -->
            <div v-else class="art art--paper">{{ card.sig.slice(0, 6) || '无封面' }}</div>

            <span class="spine" aria-hidden="true" />

            <span class="tag" :class="card.online ? 'tag--online' : 'tag--offline'">
                {{ card.online ? (card.letter ? `${card.letter}盘` : '在线') : '离线' }}
            </span>

            <div class="bar">
                <div class="bar__title">{{ card.title }}</div>
                <div class="bar__meta">
                    {{ position }} / {{ String(count).padStart(2, '0') }}<template v-if="card.sizeText"> · {{ card.sizeText }}</template>
                </div>
            </div>

            <!-- 三层的顺序就是叠放顺序：全身箔在最下，眩光与清漆压在它上面 -->
            <span v-if="foil === 'all'" class="holo" aria-hidden="true" />
            <span class="glare" aria-hidden="true" />
            <span class="glaze" aria-hidden="true" />
        </div>
    </article>
</template>

<script setup lang="ts">
/**
 * 一张「专辑内页」卡 —— 3:4 竖版，封面不裁切。
 *
 * ## 质感怎么来的（这是本组件存在的全部理由）
 *
 * 参考站（holo-reverse）的卡之所以像实体，靠四层叠加。我们只搬得动其中三层，
 * 第四层必须换地方：
 *   ① **清漆 `glaze`** —— 玻璃倒角内高光 + 顶部亮线 + 两条随倾斜滑动的"影棚窗"反射。
 *      它描述的是**光**，与底下画的是什么无关 ⇒ 照搬，压在真实封面上是"覆膜感"。
 *   ② **眩光 `glare`** —— 径向高光跟随指针，`overlay` 混合 ⇒ 照搬。
 *   ③ **厚度 `slab`** —— 三层 `translateZ`，颜色取 `--ff-canvas`（恰好比纸暗一档，
 *      两套主题都成立）⇒ 照搬。
 *   ④ **全息箔 `holo`** —— 参考站铺满整卡，因为底下是它自己画的高饱和插画。
 *      **我们的封面是真实照片，铺上去会把脸染成彩色** ⇒ 只许落在装饰件
 *      （信息条 / 贴纸 / 书脊），见 `foil="deco"`。
 *
 * `foil` 三档对应质感标定 spike 的三个配方（`docs/probes/lucky-texture/spike.html`）：
 * `none` 只光照 / `all` 薄箔全身 / `deco` 箔只在装饰件。默认值由页面按标定结果传。
 *
 * ## 为什么用 `cqw`
 * 卡片宽度由父级的扇形排布决定（会随窗口变）。字号跟着容器走，`clamp()` 会因为
 * 断点跳变，`cqw` 是连续缩放 —— 与参考站同一做法。
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

/** 指针位置 → 倾斜与反光。写 CSS 变量而不是拼 `style.transform` 字符串：
 *  浏览器只需重算合成层，不必重新解析 transform；渲染层的其它样式也不受影响。 */
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

/** 移出即回正 —— 变量留着不动会让卡片斜着停在那儿，看起来像坏了 */
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
    aspect-ratio: 3 / 4;
    cursor: pointer;
    outline: none;
    transform-style: preserve-3d;
    transform: rotateX(var(--rx, 0deg)) rotateY(var(--ry, 0deg));
    translate: 0 var(--lift, 0px);
    transition: translate 260ms cubic-bezier(0.19, 1, 0.22, 1), box-shadow 260ms ease;
    /* 鼠标位置与倾斜量：由 onMove 写入，三个质感层都读它们 */
    --px: 50;
    --py: 50;
    --hyp: 0;

    &:hover {
        --lift: -10px;
        z-index: 2;
    }

    &:focus-visible .face {
        outline: 2px solid var(--ff-highlight);
        outline-offset: 3px;
    }
}

/* ── 厚度 ───────────────────────────────────────────────────────────────────
   ⚠️ 底色必须是"两套主题下都比纸张暗一档"的那个：`--ff-canvas` 恰好成立
      （浅 #f1f2f3 < 纸白；深 #0e0e0e < 纸 #242424）。用 `--ff-raised` 会在深色下
      比纸更亮 —— 厚度层亮过正面，读起来是"发光边"而不是"侧面"。 */
.slab {
    position: absolute;
    inset: 0;
    border-radius: var(--ff-r-card);
    background: var(--ff-canvas);
    pointer-events: none;

    &:nth-child(1) { transform: translateZ(-1.5px); }
    &:nth-child(2) { transform: translateZ(-3px); }
    &:nth-child(3) {
        transform: translateZ(-4.5px);
        box-shadow: 0 26px 40px -18px var(--ff-jewel-shadow);
    }
}

.face {
    position: absolute;
    inset: 0;
    border-radius: var(--ff-r-card);
    overflow: hidden;
    isolation: isolate;
    container-type: inline-size;
    background: var(--ff-inner-paper);
    color: var(--ff-on-paper);
    /* 纸张自身的边缘：一圈极细的亮边 + 内侧淡淡的暗，靠它脱开后面的厚度层 */
    box-shadow: inset 0 0 0 1px var(--ff-line), 0 1px 0 var(--ff-jewel-edge);
}

/* 封面：**不裁切**（主人裁决）。多出来的部分留纸边 —— 读起来像照片压在卡纸中央，
   而不是"被容器切掉一截"。留边靠纸色，不靠半透明遮罩。 */
.art {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: contain;
    user-select: none;
}

.art--paper {
    display: grid;
    place-items: center;
    font: 500 10cqw/1 var(--ff-font);
    letter-spacing: 0.08em;
    color: var(--ff-text-2);
    background: var(--ff-raised);
}

/* 书脊：左侧一条 7cqw 的竖条，箔的落点之一 */
.spine {
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    width: 4cqw;
    background: var(--ff-foil-b);
    overflow: hidden;
    pointer-events: none;
}

/* 右上贴纸：在线给盘符，离线给红 */
.tag {
    position: absolute;
    top: 4cqw;
    right: 4cqw;
    min-width: 11cqw;
    height: 11cqw;
    padding: 0 1.6cqw;
    border-radius: 11cqw;
    display: grid;
    place-items: center;
    overflow: hidden;
    font: 500 3.6cqw/1 var(--ff-font);
    letter-spacing: 0.02em;
    pointer-events: none;
}

.tag--online {
    background: var(--ff-foil-b);
    color: var(--ff-inner-band);
}

.tag--offline {
    background: var(--ff-danger-badge);
    color: var(--ff-on-danger);
}

/* 底部信息条 */
.bar {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    padding: 2.6cqw 3.4cqw 3cqw;
    background: var(--ff-inner-band);
    color: var(--ff-on-band);
    overflow: hidden;
    pointer-events: none;
}

.bar__title {
    font: 500 4.2cqw/1.35 var(--ff-font);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.bar__meta {
    margin-top: 0.6cqw;
    font: 400 3.4cqw/1.3 var(--ff-font);
    font-variant-numeric: tabular-nums;
    color: var(--ff-on-band);
    opacity: 0.62;
}

/* ── 光照层（两档：眩光 + 清漆） ────────────────────────────────────────── */

.glare,
.glaze,
.holo {
    position: absolute;
    inset: 0;
    border-radius: inherit;
    pointer-events: none;
}

/* 眩光：径向高光跟着指针走。`overlay` 让亮部更亮、暗部更暗，是"光打上去"而不是"盖一层白" */
.glare {
    z-index: 2;
    background: radial-gradient(farthest-corner circle at calc(var(--px) * 1%) calc(var(--py) * 1%),
        var(--ff-jewel-edge), transparent 38%, var(--ff-jewel-shadow));
    mix-blend-mode: overlay;
    opacity: calc(0.25 + var(--hyp) * 0.5);
}

/* 清漆：玻璃倒角内高光 + 顶亮线 + 跟随的热点。质感的主载体，与封面内容无关 */
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
    opacity: 0.72;
}

/* 两条"影棚窗"反射：随倾斜反向滑动（越往右看，反射越往左走） */
.glaze::before {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: inherit;
    mask: linear-gradient(#000 30%, transparent 88%);
    background: linear-gradient(112deg,
        transparent 44%, var(--ff-jewel-edge) 44.4%, transparent 52%,
        transparent 54%, var(--ff-jewel-edge) 54.3%, transparent 56.7%)
        calc((100 - var(--px)) * 1%) 0 / 220% 100%;
    opacity: 0.5;
}

/* ── 彩虹箔 ────────────────────────────────────────────────────────────────
   ⚠️ 三色的选取顺序与 `--ff-foil-*` 一致；这里只写**一段**重复渐变，
      位置随指针移动（`color-dodge` 才有"箔在翻"的动态）。 */
.foil-layer() {
    background: repeating-linear-gradient(110deg,
        var(--ff-foil-a) 0%, var(--ff-foil-b) 5%, var(--ff-foil-c) 10%,
        var(--ff-foil-a) 15%, var(--ff-foil-b) 20%, var(--ff-foil-a) 25%)
        calc(var(--px) * 1%) calc(var(--py) * 1%) / 400% 400%;
    mix-blend-mode: color-dodge;
    filter: brightness(0.8) contrast(1.35) saturate(1.25);
}

/* 全身箔（配方 B）：强度上限压在 0.28 —— 再高真实照片就毁了 */
.card[data-foil='all'] .holo {
    .foil-layer();
    z-index: 1;
    opacity: calc(0.1 + var(--hyp) * 0.18);
}

/**
 * 装饰件箔（配方 C）：同样的彩虹，只框在**贴纸与书脊**里。
 *
 * ⚠️ 信息条不参与：它是 `--ff-inner-band` 的近黑底，`color-dodge` 叠上去会把
 *    一条黑带染成脏红紫（真机截图确认），而它上面是要读的文字。
 */
.card[data-foil='deco'] {
    .tag::after,
    .spine::after {
        content: '';
        position: absolute;
        inset: 0;
        .foil-layer();
        opacity: calc(0.22 + var(--hyp) * 0.38);
    }
}

/* ── 离线态 ─────────────────────────────────────────────────────────────────
   ⚠️ 2026-11-15 纠错：首版给整张脸 `opacity .42 + grayscale(.6)`，业主真机第一句话
      就是"怎么一片灰暗、没色彩"。那个处理错在**判据用错了对象**：
      "盘没插"是"这张暂时播不了"，不是"这东西坏了"。而封面正是他挑片的唯一依据，
      把它弄灰等于把唯一有用的信息毁掉。
      现在离线只体现为**右上贴纸变成红色"离线"**，封面一个字都不动。 */
.is-offline .tag--offline {
    box-shadow: 0 0 0 1px var(--ff-inner-band) inset;
}

.is-active .face {
    outline: 2px solid var(--ff-highlight);
    outline-offset: 3px;
}

/* 卡片悬停时给合成层提示；不悬停时撤掉，避免 5 张卡常驻两层显存 */
.card:hover {
    will-change: transform;
}

@media (prefers-reduced-motion: reduce) {
    .card {
        transition: none;
    }

    .card:hover {
        --lift: 0px;
    }
}
</style>
