<template>
    <canvas ref="canvasEl" class="dot-field" :class="{ 'is-active': active }" />
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { createDotField } from './dotField';
import type { DotFieldHandle } from './dotField';

const props = defineProps<{ active: boolean }>();

const canvasEl = ref<HTMLCanvasElement | null>(null);
let handle: DotFieldHandle | null = null;

onMounted(() => {
    if (!canvasEl.value) return;
    handle = createDotField(canvasEl.value);
    if (props.active) handle.start();
});

watch(
    () => props.active,
    (on) => (on ? handle?.start() : handle?.stop()),
);

onBeforeUnmount(() => handle?.destroy());
</script>

<style scoped>
/* 铺满父容器（父容器负责 overflow:hidden 与圆角），自身只负责淡入淡出 */
.dot-field {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    opacity: 0;
    pointer-events: none;
    transition: opacity var(--ff-dur-move) var(--ff-ease-exit);
}

.dot-field.is-active {
    opacity: 1;
}
</style>
