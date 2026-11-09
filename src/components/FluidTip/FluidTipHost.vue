<template>
    <!-- 纯视觉层。Teleport 到 body：功能页里 tooltip 要压过 naive 弹层与卡片，
         scoped 样式够不到 teleport 出去的 DOM（项目已知坑）⇒ 样式不带 scoped。 -->
    <Teleport to="body">
        <div ref="el" class="ftip" :class="{ 'is-on': tipState.visible, 'is-snap': tipState.snap }"
            :style="{ transform: `translate(${pos.x}px, ${pos.y}px)` }">
            <span class="ftip-text">{{ tipState.text }}</span>
            <kbd v-if="tipState.keys" class="ftip-kbd">{{ tipState.keys }}</kbd>
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
import { nextTick, reactive, ref, watch } from 'vue';
import { tipState } from './fluidTip';

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
</script>

<style lang="less">
.ftip {
    position: fixed;
    top: 0;
    left: 0;
    z-index: 4000;
    display: flex;
    align-items: center;
    gap: 8px;
    height: 32px;
    padding: 0 12px;
    box-sizing: border-box;
    border-radius: 8px;
    background: var(--ff-tooltip-bg);
    color: var(--ff-tooltip-text);
    font-size: 13px;
    font-weight: 500;
    white-space: nowrap;
    pointer-events: none;
    opacity: 0;
    will-change: transform, opacity;
    transition:
        transform 0.2s var(--ff-ease-move),
        opacity 0.15s ease-out;

    &.is-on {
        opacity: 1;
    }

    /* 首现/跳远：几何不补间，只淡入（RailTip 同款纪律） */
    &.is-snap {
        transition: opacity 0.15s ease-out;
    }
}

.ftip-kbd {
    min-width: 18px;
    padding: 1px 5px;
    box-sizing: border-box;
    border-radius: 5px;
    background: rgba(255, 255, 255, 0.16);
    color: var(--ff-tooltip-text);
    font-family: var(--ff-font);
    font-size: 11px;
    font-weight: 500;
    line-height: 1.4;
    text-align: center;
}
</style>
