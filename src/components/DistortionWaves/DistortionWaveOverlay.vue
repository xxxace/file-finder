<template>
    <div ref="rootEl" class="dw-overlay" :style="overlayStyle" role="status" aria-live="polite">
        <div class="dw-overlay__veil" aria-hidden="true" />
        <canvas ref="waitingCanvasEl" class="dw-overlay__waiting" data-dw-skip="" aria-hidden="true" />
        <canvas ref="canvasEl" class="dw-overlay__canvas" data-dw-skip="" aria-hidden="true" />
        <div class="dw-overlay__content" data-dw-skip="">
            <slot :elapsed="elapsedSec" :sweeping="isSweeping" />
        </div>
    </div>
</template>

<script setup lang="ts">
import { computed, ref, toRef } from 'vue';
import type { WaveType } from './model';
import { useWaveOverlay } from './useWaveOverlay';

const props = withDefaults(
    defineProps<{
        /** Whether the underlying async task is still running. */
        running: boolean;
        /** Optional target element behind the overlay to capture for WebGL lens refraction. */
        captureTarget?: HTMLElement | null;
        type?: WaveType;
        minDurationMs?: number;
        sweptLeadMs?: number;
    }>(),
    {
        captureTarget: null,
        type: 'vertical',
        minDurationMs: 2000,
        sweptLeadMs: 350,
    },
);

const emit = defineEmits<{
    swept: [];
    closed: [];
}>();

const rootEl = ref<HTMLElement | null>(null);
const canvasEl = ref<HTMLCanvasElement | null>(null);
const waitingCanvasEl = ref<HTMLCanvasElement | null>(null);

const { veilOpacity, lightsOpacity, waitingOpacity, elapsedSec, isSweeping } = useWaveOverlay({
    rootEl,
    canvasEl,
    waitingCanvasEl,
    captureTarget: toRef(props, 'captureTarget'),
    running: toRef(props, 'running'),
    type: props.type,
    minDurationMs: props.minDurationMs,
    sweptLeadMs: props.sweptLeadMs,
    onSwept: () => emit('swept'),
    onClosed: () => emit('closed'),
});

const overlayStyle = computed(() => ({
    '--dw-veil': veilOpacity.value.toFixed(3),
    '--dw-lights': lightsOpacity.value.toFixed(3),
    '--dw-waiting': waitingOpacity.value.toFixed(3),
}));
</script>

<style scoped>
.dw-overlay {
    position: absolute;
    inset: 0;
    z-index: 3;
    display: grid;
    place-items: center;
    overflow: hidden;
    pointer-events: none;
}

.dw-overlay__veil {
    position: absolute;
    inset: 0;
    background: var(--ff-canvas);
    opacity: var(--dw-veil, 0);
    transition: none;
}

@media (prefers-reduced-motion: reduce) {
    .dw-overlay__veil {
        transition: opacity var(--ff-dur-exit) linear;
    }
}

.dw-overlay__waiting,
.dw-overlay__canvas {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
}

.dw-overlay__waiting {
    opacity: var(--dw-waiting, 0);
}

.dw-overlay__canvas {
    opacity: var(--dw-lights, 0);
}

.dw-overlay__content {
    position: relative;
    z-index: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    pointer-events: auto;
}
</style>
