<template>
    <!-- 纯视觉层：按钮自己已经带 aria-label，这里 aria-hidden 掉，
         也不挂 aria-describedby —— 那会让同一句话被读两遍。 -->
    <div class="rail-tip" :class="{ 'is-on': shown, 'is-snap': snap }" aria-hidden="true" :style="{
        '--rail-tip-h': `${TIP_HEIGHT}px`,
        '--rail-tip-pad': `${TIP_PAD}px`,
        transform: `translateY(${y}px)`,
        width: `${width}px`,
    }">
        <!-- 标签层反向位移 = 标签在世界坐标里不动，动的是上面那层裁切窗口 -->
        <div class="rail-tip-track" :style="{ transform: `translateY(${-y}px)` }">
            <span v-for="(label, i) in labels" :key="i" :ref="(el) => markRow(i, el)"
                class="rail-tip-row">{{ label }}</span>
        </div>
    </div>
</template>

<script setup lang="ts">
/**
 * 左轨的提示胶囊 —— 纯展示 + 样式。
 *
 * 几何（y / 宽度）由 `useRailTip` 算好，这里只负责画：
 * 上层窗口 `translateY(y)`，内层标签 `translateY(-y)`，两层互相抵消 ⇒ 文字不动、窗口在滑。
 *
 * 尺寸只在 `useRailTip.ts` 定义一次，这里 import 进来注入成 CSS 变量 ——
 * 高度对不上会直接让标签和窗口错位，不能靠"两处注释互相提醒"。
 *
 * 动画全在 CSS 里：GSAP 的 `expo.out` 用 `cubic-bezier(.16, 1, .3, 1)` 近似，
 * 时长 .43s；透明度 .15s ease-out（≈ `power2.out`）。
 */
import type { ComponentPublicInstance } from 'vue';
import { TIP_HEIGHT, TIP_PAD } from './useRailTip';

defineProps<{
    /** 每一行标签，行号即入口序号 */
    labels: string[];
    /** 胶囊窗口的目标顶部（相对左轨） */
    y: number;
    width: number;
    /** 是否可见（只驱动 opacity，不驱动位移） */
    shown: boolean;
    /** 首次出现：几何直接落位，别做滑动 */
    snap: boolean;
    /** 把标签行元素交给 useRailTip 量宽度 */
    markRow: (index: number, el: Element | ComponentPublicInstance | null) => void;
}>();
</script>

<style scoped lang="less">
.rail-tip {
    position: absolute;
    top: 0;
    /* **从侧边栏右缘再让 10px**（LeiBox 胶囊起点 = 栏右缘 + 20 @100 入口 ⇒ 等比 ≈9）。
       写 `calc(50% + 32px)` 时左缘正好落在 64px 的栏边界上，圆弧压着边界线、两块深色糊成一片。 */
    left: calc(100% + 8px);
    height: var(--rail-tip-h);
    overflow: hidden;
    border-radius: 999px;
    background: var(--ff-tip-bg);
    color: var(--ff-tip-text);
    box-shadow: var(--ff-tip-shadow);
    pointer-events: none;
    opacity: 0;
    will-change: transform, width, opacity;
    transition: transform 0.43s cubic-bezier(0.16, 1, 0.3, 1), width 0.43s cubic-bezier(0.16, 1, 0.3, 1),
        opacity 0.15s ease-out;

    &.is-on {
        opacity: 1;
    }

    /* 只有透明度还能补间，位移/宽度这一帧必须瞬间到位 */
    &.is-snap {
        transition: opacity 0.15s ease-out;

        .rail-tip-track {
            transition: none;
        }
    }
}

.rail-tip-track {
    position: absolute;
    top: 0;
    left: var(--rail-tip-pad);
    will-change: transform;
    transition: transform 0.43s cubic-bezier(0.16, 1, 0.3, 1);
}

.rail-tip-row {
    position: absolute;
    top: 0; /* 真实位置由 useRailTip.measure() 写进 style.top */
    left: 0;
    display: flex;
    align-items: center;
    height: var(--rail-tip-h);
    width: max-content;
    white-space: nowrap;
    /* 比例照 LeiBox 原样：字 38 / 胶囊 86 / 行高 46 ⇒ 字取 14px 时 32 / 16.9（见 useRailTip.ts） */
    font-size: 14px;
    font-weight: 600;
    line-height: 1.21;
}

@media (prefers-reduced-motion: reduce) {
    .rail-tip,
    .rail-tip-track {
        transition: none;
    }
}
</style>
