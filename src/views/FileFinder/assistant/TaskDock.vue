<template>
    <footer
        class="ffw-dock"
        :class="{ 'is-live': phase !== 'idle', 'is-celebrate': celebrate }"
        :data-phase="phase"
    >
        <div class="ffw-dock__rail"><i :style="{ transform: `scaleX(${ratio})` }" /></div>
        <div class="ffw-dock__glow" />

        <div class="ffw-dock__line">
            <!-- 总控勾选（可选）。放在「已选 n / m」**前面**：它管的就是后面那个数，
                 两个东西挨着才是一句话（放右端按钮区会被读成"又一个动作"）。 -->
            <slot name="lead" />
            <!-- 阶段变化才换结构：数字在同阶段里原地更新，不重播动画 -->
            <div class="ffw-dock__stack">
                <Transition name="ffw-announce">
                    <div :key="phase">
                        <i v-if="phase === 'run' || phase === 'done'" class="ffw-dock__pulse" />
                        <span class="ffw-dock__status">{{ status }}</span>
                        <span class="ffw-dock__detail">{{ detail }}</span>
                    </div>
                </Transition>
            </div>
        </div>

        <div class="ffw-dock__actions">
            <slot name="actions" />
        </div>
    </footer>
</template>

<script setup lang="ts">
/**
 * 底栏 = 任务条。空闲 / 运行 / 暂停 / 完成四态都在**同一个节点**里形变，
 * 而不是各画一条。进度线画在底栏上边缘（0 布局占用，两个阶段共用同一条）。
 *
 * 刻意做成纯展示组件：它不认识 job，也不知道"暂停"要调哪个接口 ——
 * 那些是面板的事。这样两个面板能共用同一份视觉，而不会共用出一堆 if。
 */
defineProps<{
    phase: 'idle' | 'run' | 'pause' | 'done';
    /** 0~1，进度线长度 */
    ratio: number;
    status: string;
    detail: string;
    celebrate?: boolean;
}>();
</script>
