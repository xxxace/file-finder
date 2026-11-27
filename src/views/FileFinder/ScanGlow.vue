<template>
    <DistortionWaveOverlay
        :running="running"
        :capture-target="captureTarget"
        type="vertical"
        :min-duration-ms="2000"
        :swept-lead-ms="350"
        @swept="emit('swept')"
        @closed="emit('closed')"
    >
        <template #default="{ elapsed }">
            <div class="scan-glow__panel">
                <div class="scan-glow__title">{{ title }}</div>
                <div class="scan-glow__status">
                    <Transition name="scan-glow-announce">
                        <span :key="lineFor(elapsed)">{{ lineFor(elapsed) }}</span>
                    </Transition>
                </div>
                <div v-if="running && pending" class="scan-glow__count">
                    已扫 <b>{{ done ?? 0 }}</b> / 待扫 <b>{{ pending }}</b>
                </div>
                <!-- 判定完成后按钮退场：位子**留着**（wrapper 定高），只淡出按钮本身 -->
                <div class="scan-glow__actions">
                    <Transition name="scan-glow-action">
                        <button
                            v-if="running"
                            type="button"
                            class="scan-glow__stop"
                            :disabled="cancelling"
                            @click="emit('cancel')"
                        >
                            {{ cancelling ? '正在取消…' : '终止' }}
                        </button>
                    </Transition>
                </div>
            </div>
        </template>
    </DistortionWaveOverlay>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { DistortionWaveOverlay } from '@/components/DistortionWaves';

/**
 * 扫描/补全的「波浪确认」—— 基于模块化 `DistortionWaves`（WebGL 2 折射波浪 + 边缘发丝高光 + 粒子）。
 *
 * 保持与 `useScanFlow` / `index.vue` 的低耦合契约：
 *   - `running === true` 期间在底边蓄力呼吸并展示进度与「终止」按钮；
 *   - `running` 置 `false` 且满足最短 2s 后，打出完整竖向波浪扫过网格，触发 `swept`（完成音）与 `closed`。
 */
const props = defineProps<{
    kind: 'fill' | 'rescan';
    /** 任务还在不在跑。false ⇒ 播完退场就把自己关掉 */
    running: boolean;
    /** 已点终止、正在等目录边界：按钮变「正在取消…」并置灰 */
    cancelling?: boolean;
    /** 已扫目录数 */
    done?: number;
    /** 还没扫的目录数 */
    pending?: number;
    /** 底层网格容器，供 WebGL 透镜采样 */
    captureTarget?: HTMLElement | null;
}>();

const emit = defineEmits<{ cancel: []; closed: []; swept: [] }>();

const title = computed(() => (props.kind === 'fill' ? '补全这一片' : '重读这一片'));

const lineFor = (elapsed: number) => {
    if (props.cancelling) return '正在取消，等当前目录扫完…';
    if (!props.running) return '完成';
    if (elapsed < 2.6) return props.kind === 'fill' ? '正在补齐缓存…' : '正在重读这一片…';
    return props.kind === 'fill' ? '正在核对目录…' : '正在比对缓存…';
};
</script>

<style scoped>
.scan-glow__panel {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
}

.scan-glow__title {
    font-size: var(--ff-fs-title);
    font-weight: 500;
    letter-spacing: 0.02em;
    color: var(--ff-text-1);
}

.scan-glow__status {
    position: relative;
    display: grid;
    align-items: center;
    height: 20px;
    font-size: var(--ff-fs-meta);
    color: var(--ff-text-2);
}

.scan-glow__status > span {
    grid-area: 1 / 1;
    text-align: center;
}

.scan-glow__count {
    font-size: var(--ff-fs-eyebrow);
    color: var(--ff-text-2);
    font-variant-numeric: tabular-nums;
}

.scan-glow__count b {
    font-weight: 500;
    color: var(--ff-text-1);
}

.scan-glow__actions {
    display: grid;
    place-items: center;
    height: calc(var(--ff-h-ctl) + 6px);
}

.scan-glow__stop {
    height: var(--ff-h-ctl);
    padding: 0 14px;
    border: 1px solid var(--ff-line-strong);
    border-radius: var(--ff-r-ctl);
    background: var(--ff-raised);
    color: var(--ff-text-1);
    font-size: var(--ff-fs-meta);
    font-weight: 500;
    cursor: pointer;
    transition: background-color var(--ff-dur-hover) ease, opacity var(--ff-dur-hover) ease;
}

.scan-glow__stop:hover {
    background: var(--ff-raised-hover);
}

.scan-glow__stop:disabled {
    opacity: 0.5;
    pointer-events: none;
}

.scan-glow__stop:focus-visible {
    outline: 2px solid var(--ff-highlight);
    outline-offset: 2px;
}

.scan-glow-action-leave-active {
    transition: opacity var(--ff-dur-exit) linear;
}

.scan-glow-action-leave-to {
    opacity: 0;
}

.scan-glow-announce-enter-from {
    opacity: 0;
    transform: translateY(6px);
}

.scan-glow-announce-enter-active {
    transition:
        opacity var(--ff-fade-in) var(--ff-fade-in-delay),
        transform var(--ff-dur-move) var(--ff-ease-move);
}

.scan-glow-announce-leave-to {
    opacity: 0;
    transform: translateY(-6px);
}

.scan-glow-announce-leave-active {
    transition:
        opacity var(--ff-dur-exit) linear,
        transform var(--ff-dur-exit) var(--ff-ease-exit);
}
</style>
