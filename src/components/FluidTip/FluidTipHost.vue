<template>
    <!-- 纯视觉层。Teleport 到 body：功能页里 tooltip 要压过 naive 弹层与卡片，
         scoped 样式够不到 teleport 出去的 DOM（项目已知坑）⇒ 样式不带 scoped。 -->
    <Teleport to="body">
        <div ref="el" class="ftip" :class="{ 'is-on': tipState.visible, 'is-snap': tipState.snap, 'is-rich': !!tipState.body }"
            :style="{ transform: `translate(${pos.x}px, ${pos.y}px)`, minWidth: richMinWidth }">
            <!-- 富内容：调用方给的渲染函数直接当函数式组件挂（宿主不认识业务结构，只给材质与定位） -->
            <component :is="tipState.body" v-if="tipState.body" />
            <template v-else>
                <span class="ftip-text">{{ tipState.text }}</span>
                <!-- 组合键拆成**多颗键帽**（`Alt+→` ⇒ [Alt] + [→]）。
                     ⚠️ 别把 `Alt+→` 塞进一颗帽里：`+` 会贴住两边字形，读起来像"Alt 加号箭头"一个词
                     （2026-11-10 业主："+ 两边能不能有些空隙，都挤一起了"）。
                     `+` 只作分隔符，样式比键帽弱一档 —— 它是语法，不是要按的键。 -->
                <span v-if="keyCaps.length" class="ftip-keys">
                    <template v-for="(k, i) in keyCaps" :key="i">
                        <span v-if="i" class="ftip-plus" aria-hidden="true">+</span>
                        <kbd class="ftip-kbd">{{ k }}</kbd>
                    </template>
                </span>
            </template>
        </div>
    </Teleport>
</template>

<script setup lang="ts">
/**
 * Fluid Tip 宿主 —— 全局挂一颗（App.vue，与 OverlayHost 并排）。
 *
 * 几何：锚点 rect 存在 fluidTip.ts；这里量自己的宽高后算落点（优先锚点下方居中，
 * 放不下翻上方，左右 clamp 进视口 12px），再 nextTick 复量一次 —— 文案变了宽度会变。
 * 动画：transform 200ms `--ff-ease-move`（一拍），透明度 150ms；snap 时位移不补间。
 */
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue';
import { hideTip, tipState } from './fluidTip';

/** `'Alt+→'` → `['Alt', '→']`；单键（`S` / `F5` / `Backspace`）仍是一颗帽 */
const keyCaps = computed(() => (tipState.keys || '').split('+').map((s) => s.trim()).filter(Boolean));

/**
 * 富内容的最小宽度 = **锚点（卡片）自身的宽度 + 20**。
 *
 * 为什么不用一个固定值：卡片宽度是 `minmax(184px, 1fr)` 算出来的，窗口一变就拉伸。
 * 写死只会两头不讨好 —— 比卡片窄显得小气，比卡片宽又压住隔壁的卡。
 * 跟着锚点走，浮层永远和它的主人差一档。
 *
 * 宽度来源是 `tipState.anchor`（`showTip` 时存下的元素矩形），
 * 不往 `TipPayload` 加参数：这是全局浮层，不该让每个调用方各报一个宽度。
 */
const richMinWidth = computed(() => {
    if (!tipState.body || !tipState.anchor) return undefined;
    return `${Math.round(tipState.anchor.width + 20)}px`;
});

const el = ref<HTMLElement | null>(null);
const pos = reactive({ x: -1000, y: -1000 });

function place() {
    const node = el.value;
    const anchor = tipState.anchor;
    if (!node || !anchor) return;
    const w = node.offsetWidth;
    const h = node.offsetHeight;
    const cx = anchor.left + anchor.width / 2;
    let y = anchor.bottom + 8;
    if (y + h > window.innerHeight - 8) y = anchor.top - h - 8;
    const x = Math.min(Math.max(12, cx - w / 2), window.innerWidth - w - 12);
    pos.x = x;
    pos.y = Math.max(8, y);
}

watch(
    () => [tipState.anchor, tipState.text, tipState.keys, tipState.visible] as const,
    async () => {
        await nextTick();
        place();
    },
    { deep: false },
);

/**
 * 锚点活性自愈（Floating UI `autoUpdate` 的思路）：
 * 「进入」由事件驱动，但事件有管不到的死亡路径 —— 锚点被从 DOM 拆掉
 * （预览关层、列表重渲染、v-if 撤销）时 `pointerleave` 永远不会发。
 * 可见期间逐帧校验：锚点不在文档里 / 尺寸归零 ⇒ 立刻收；
 * 锚点只是**动了**（滚动 / 布局变化）⇒ 更新 anchor 让落位跟着走。
 * 只在可见时跑一帧一次 `getBoundingClientRect`，隐藏即停 —— 成本可忽略。
 */
let tickRaf = 0;
const tick = () => {
    tickRaf = 0;
    const el = tipState.anchorEl;
    if (!tipState.visible || !el) return;
    if (!el.isConnected) { hideTip(); return; }
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) { hideTip(); return; }
    const a = tipState.anchor;
    if (!a || r.left !== a.left || r.top !== a.top || r.width !== a.width || r.height !== a.height) {
        tipState.anchor = r;
    }
    tickRaf = requestAnimationFrame(tick);
};

watch(() => tipState.visible, (v) => {
    if (v && !tickRaf) tickRaf = requestAnimationFrame(tick);
    else if (!v && tickRaf) { cancelAnimationFrame(tickRaf); tickRaf = 0; }
});

onBeforeUnmount(() => {
    if (tickRaf) cancelAnimationFrame(tickRaf);
});
</script>

<style lang="less">
/* 视觉数值逐字对齐 react-bits WarmTooltip 官方源码（2026-11-09 取样），
   色值换成我们的反色 token（--ff-tooltip-*）。键帽的下缘暗线是"像键盘键"的关键。 */
.ftip {
    position: fixed;
    top: 0;
    left: 0;
    z-index: 4000;
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 6px 10px;
    box-sizing: border-box;
    border-radius: 8px;
    background: var(--ff-tooltip-bg);
    color: var(--ff-tooltip-text);
    backdrop-filter: var(--ff-tooltip-backdrop);
    font-size: 12.5px;
    font-weight: 500;
    line-height: 1.2;
    letter-spacing: -0.01em;
    white-space: nowrap;
    pointer-events: none;
    opacity: 0;
    will-change: transform, opacity;
    transition:
        transform 0.2s var(--ff-ease-move),
        opacity 0.15s ease-out;
    box-shadow: var(--ff-tooltip-shadow);

    &.is-on {
        opacity: 1;
    }

    /* 首现/跳远：几何不补间，只淡入（RailTip 同款纪律） */
    &.is-snap {
        transition: opacity 0.15s ease-out;
    }

    /* 富内容（盘片那种标题 + 多行键值表）：单行胶囊的 nowrap 必须放开，
       宽度也要有个上限，否则一块盘的长路径会把提示拉成一条横线。 */
    &.is-rich {
        display: block;
        padding: 8px 10px;
        /**
         * 宽度策略：**最小 = 锚点宽度 + 20（模板里按 rect 算），上限 300**。
         *
         * 这里这两行只是**兜底**（没有锚点 rect 时，比如将来程序化调用）：
         *  · 不写死最小宽度：富内容是 k/v 两列表格，表格最怕宽度随内容变；
         *  · 也不写死成 300：视口窄时会顶出屏幕，只有两行的短内容又会留一大片空。
         */
        min-width: 280px;
        max-width: 300px;
        white-space: normal;
        /**
         * 富内容 = **一块小面板**（标题 + 多行键值），不是"一行字 + 箭头"的气泡。
         *
         * 所以它走**跟随主题的磨砂面板**（`--ff-tip-*`），和助手面板的头/底栏同一块材质；
         * 单行气泡继续用反色深片（`--ff-tooltip-*`）—— 那种白底小气泡在界面里没有边界可依，
         * 反色是刻意的。富内容有 300px 见方的面积，再用反色深片就成了一块乌黑的板子压在
         * 封面上（2026-11-14 主人：「卡片的 tooltip 为什么还是乌漆嘛黑」）。
         */
        background: var(--ff-tip-bg);
        color: var(--ff-tip-text);
        backdrop-filter: var(--ff-tip-backdrop);
        box-shadow: var(--ff-tip-shadow);
    }
}

/* 组合键的一组键帽。gap 4px：比 `.ftip` 的 7px 紧一档 —— 它们属于同一个"按键"，
   但两颗帽之间必须能看出缝，否则又变回"挤在一起"。 */
.ftip-keys {
    display: inline-flex;
    align-items: center;
    gap: 4px;
}

/* `+` 是语法不是键：不加底、不加沿，只保留一点点墨色 */
.ftip-plus {
    color: var(--ff-tooltip-kbd-text);
    font-size: 0.8em;
    font-weight: 400;
    opacity: 0.55;
}

.ftip-kbd {
    display: inline-flex;
    align-items: center;
    height: 1.55em;
    padding: 0 0.45em;
    box-sizing: border-box;
    border-radius: 0.4em;
    background: var(--ff-tooltip-kbd-bg);
    /* 键帽的下沿：一条 1px 暗线读作"键盘键的侧面"，没有它就只是一块圆角芯片 */
    box-shadow: inset 0 -1px 0 var(--ff-tooltip-kbd-line);
    color: var(--ff-tooltip-kbd-text);
    font-family: var(--ff-font);
    font-size: 0.86em;
    font-weight: 500;
    letter-spacing: 0.02em;
    font-variant-numeric: tabular-nums;
}
</style>
