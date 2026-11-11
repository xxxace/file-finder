<template>
    <div
        ref="containerRef"
        class="tunnel-container"
        :class="{ 'is-fullscreen': isFullscreen, 'hide-cursor': isCursorHidden }"
        @mousemove="onCanvasActivity"
        @wheel="onCanvasActivity"
        @pointerdown="onCanvasActivity"
        @mouseleave="onContainerMouseLeave"
    >
        <!-- 3D WebGL 画布宿主容器 -->
        <div ref="stageRef" class="tunnel-stage"></div>

        <!-- 顶部 HUD 工具栏 -->
        <div class="hud-top">
            <div class="hud-left">
                <button v-if="showBack" type="button" class="hud-btn hud-btn-back" title="返回" @click="$emit('back')">
                    <svg viewBox="0 0 24 24" class="hud-icon">
                        <path fill="currentColor" d="M20 11H7.83l5.59-5.59L12 4l-8 8l8 8l1.41-1.41L7.83 13H20v-2z" />
                    </svg>
                    <span>返回</span>
                </button>
                <div class="hud-badge">
                    <span class="hud-dot"></span>
                    <span class="hud-title">3D 封面漫游</span>
                    <span class="hud-count">{{ items.length }} 张封面</span>
                </div>

                <select v-if="disks && disks.length > 1" class="hud-select" :value="selectedSerial" @change="$emit('change-serial', ($event.target as HTMLSelectElement).value)">
                    <option value="">全部磁盘</option>
                    <option v-for="d in disks" :key="d.serial" :value="d.serial">{{ d.name }}</option>
                </select>
            </div>

            <div class="hud-right">
                <button type="button" class="hud-btn" :class="{ 'is-active': isPaused }" :title="isPaused ? '继续自动穿行 (空格)' : '暂停漫游 (空格)'" @click="togglePause">
                    <svg viewBox="0 0 24 24" class="hud-icon">
                        <path v-if="isPaused" fill="currentColor" d="M8 5v14l11-7z" />
                        <path v-else fill="currentColor" d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
                    </svg>
                    <span>{{ isPaused ? '已暂停' : '自动漫游' }}</span>
                </button>

                <button type="button" class="hud-btn" :title="isFullscreen ? '退出全屏' : '全屏体验'" @click="toggleFullscreen">
                    <svg viewBox="0 0 24 24" class="hud-icon">
                        <path v-if="isFullscreen" fill="currentColor" d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z" />
                        <path v-else fill="currentColor" d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z" />
                    </svg>
                </button>

                <div class="hud-fps" title="实时渲染帧率">
                    {{ fps }} FPS
                </div>
            </div>
        </div>

        <!-- 居中操作指引气泡（入场后渐隐） -->
        <Transition name="fade">
            <div v-if="showHint" class="hud-hint">
                <span class="hint-tag">滚轮 / 拖拽</span> 穿梭隧道 · 
                <span class="hint-tag">鼠标悬停</span> 磁吸抬起 · 
                <span class="hint-tag">点击封面</span> 沿弧线居中对焦 · 
                <span class="hint-tag">方向键</span> 切换邻近 · 
                <span class="hint-tag">空格</span> 暂停
            </div>
        </Transition>

        <!-- 底部焦点封面详情操作面板（统一设计规范，按活动状态显隐） -->
        <Transition name="slide-up">
            <div
                v-if="activeCover && isHudActive"
                class="hud-bottom-card"
                @mouseenter="onCardMouseEnter"
                @mouseleave="onCardMouseLeave"
            >
                <div class="card-thumb-wrap">
                    <img v-if="activeCover.src" :src="activeCover.src" class="card-thumb-img" alt="" />
                    <div v-else class="card-thumb-fallback"></div>
                </div>
                <div class="card-info">
                    <div class="card-title" :title="activeCover.title">{{ activeCover.title }}</div>
                    <div class="card-meta">
                        <n-tag v-if="activeCover.raw?.serial" size="small" :bordered="false" type="info">
                            {{ activeCover.raw.serial }}
                        </n-tag>
                        <span v-if="activeCover.raw?.dir" class="meta-dir" :title="activeCover.raw.dir">
                            {{ activeCover.raw.dir }}
                        </span>
                        <n-tag v-if="activeCover.raw?.size" size="small" :bordered="false">
                            {{ formatSize(activeCover.raw.size) }}
                        </n-tag>
                    </div>
                </div>
                <div class="card-actions">
                    <n-button type="primary" size="small" secondary @click="handleSelect">
                        <template #icon>
                            <n-icon :component="PlayOutline" />
                        </template>
                        预览 / 播放
                    </n-button>
                    <n-button
                        v-if="activeCover.raw?.dir"
                        size="small"
                        secondary
                        title="在文件列表中定位"
                        @click="handleNavigateDir"
                    >
                        <template #icon>
                            <n-icon :component="FolderOpenOutline" />
                        </template>
                        定位目录
                    </n-button>
                </div>
            </div>
        </Transition>
    </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, onActivated, onDeactivated, watch } from 'vue';
import { NButton, NTag, NIcon } from 'naive-ui';
import { PlayOutline, FolderOpenOutline } from '@vicons/ionicons5';
import { createAlbumCoverTunnel } from './engine';
import type { TunnelCover, TunnelController } from './types';
import { formatBytes } from '@/utils';
import { playSfx } from '@/utils/sfx';

const props = withDefaults(
    defineProps<{
        items: TunnelCover[];
        theme?: 'dark' | 'light';
        showBack?: boolean;
        disks?: Array<{ serial: string; name: string }>;
        selectedSerial?: string;
    }>(),
    {
        theme: 'dark',
        showBack: true,
        disks: () => [],
        selectedSerial: '',
    },
);

const emit = defineEmits<{
    (e: 'select', item: TunnelCover): void;
    (e: 'navigate-dir', item: TunnelCover): void;
    (e: 'change-serial', serial: string): void;
    (e: 'back'): void;
}>();

const containerRef = ref<HTMLDivElement | null>(null);
const stageRef = ref<HTMLDivElement | null>(null);
let controller: TunnelController | null = null;

const activeCover = ref<TunnelCover | null>(null);
const hoveredCover = ref<TunnelCover | null>(null);
const fps = ref(60);
const isPaused = ref(false);
const isFullscreen = ref(false);
const showHint = ref(true);

const isHudActive = ref(false);
let hudTimer: ReturnType<typeof setTimeout> | null = null;
let isHoveringCard = false;

const isCursorHidden = ref(false);
let cursorTimer: ReturnType<typeof setTimeout> | null = null;

function resetCursorTimer() {
    isCursorHidden.value = false;
    if (cursorTimer) {
        clearTimeout(cursorTimer);
        cursorTimer = null;
    }
    cursorTimer = setTimeout(() => {
        isCursorHidden.value = true;
    }, 3000);
}

function pingHudActivity() {
    isHudActive.value = true;
    if (hudTimer) {
        clearTimeout(hudTimer);
        hudTimer = null;
    }
    if (!isHoveringCard) {
        hudTimer = setTimeout(() => {
            isHudActive.value = false;
        }, 2800);
    }
}

function onCanvasActivity(e: MouseEvent | WheelEvent) {
    if (!containerRef.value) return;
    const rect = containerRef.value.getBoundingClientRect();
    // 严格限制：只有鼠标指针确实在画布的可视矩形区域内部移动才算活动
    if (
        e.clientX < rect.left ||
        e.clientX > rect.right ||
        e.clientY < rect.top ||
        e.clientY > rect.bottom
    ) {
        return;
    }
    pingHudActivity();
    resetCursorTimer();
}

function onContainerMouseLeave() {
    isCursorHidden.value = false;
    if (cursorTimer) {
        clearTimeout(cursorTimer);
        cursorTimer = null;
    }
    if (!isHoveringCard) {
        if (hudTimer) {
            clearTimeout(hudTimer);
            hudTimer = null;
        }
        isHudActive.value = false;
    }
}

function onWindowBlur() {
    isHoveringCard = false;
    isCursorHidden.value = false;
    if (cursorTimer) {
        clearTimeout(cursorTimer);
        cursorTimer = null;
    }
    if (hudTimer) {
        clearTimeout(hudTimer);
        hudTimer = null;
    }
    isHudActive.value = false;
}

function onCardMouseEnter() {
    isHoveringCard = true;
    isHudActive.value = true;
    if (hudTimer) {
        clearTimeout(hudTimer);
        hudTimer = null;
    }
}

function onCardMouseLeave() {
    isHoveringCard = false;
    pingHudActivity();
}

function formatSize(bytes?: number) {
    return formatBytes(bytes);
}

function togglePause() {
    if (controller) {
        isPaused.value = controller.togglePause();
    }
}

function toggleFullscreen() {
    if (!containerRef.value) return;
    if (!document.fullscreenElement) {
        containerRef.value.requestFullscreen().then(() => {
            isFullscreen.value = true;
        }).catch(() => {});
    } else {
        document.exitFullscreen().then(() => {
            isFullscreen.value = false;
        }).catch(() => {});
    }
}

function handleSelect() {
    if (activeCover.value) {
        emit('select', activeCover.value);
    }
}

function handleNavigateDir() {
    if (activeCover.value) {
        emit('navigate-dir', activeCover.value);
    }
}

onActivated(() => {
    controller?.setActive(true);
});

onDeactivated(() => {
    controller?.setActive(false);
});

function dedupeCoversBySig(items: TunnelCover[]): TunnelCover[] {
    const seen = new Set<string>();
    return items.filter((it) => {
        const sig = it.sig || it.raw?.sig;
        if (!sig) return true;
        if (seen.has(sig)) return false;
        seen.add(sig);
        return true;
    });
}

onMounted(() => {
    if (!stageRef.value) return;

    window.addEventListener('blur', onWindowBlur);

    controller = createAlbumCoverTunnel(stageRef.value, {
        theme: props.theme,
        autoTravel: true,
        onSelect: (item) => {
            activeCover.value = item;
            // 静默更新焦点封面数据，不在每次自动穿梭时误唤醒底栏
        },
        onHover: (item) => {
            if (item && item.id !== hoveredCover.value?.id) {
                playSfx('hover');
            }
            hoveredCover.value = item;
        },
        onFps: (val) => {
            fps.value = val;
        },
    });

    if (props.items.length) {
        void controller.setCovers(dedupeCoversBySig(props.items));
    }

    setTimeout(() => {
        showHint.value = false;
    }, 7000);
});

watch(
    () => props.items,
    (next) => {
        if (controller) {
            void controller.setCovers(dedupeCoversBySig(next));
        }
    },
    { deep: false },
);

onBeforeUnmount(() => {
    window.removeEventListener('blur', onWindowBlur);
    if (hudTimer) {
        clearTimeout(hudTimer);
        hudTimer = null;
    }
    if (cursorTimer) {
        clearTimeout(cursorTimer);
        cursorTimer = null;
    }
    if (controller) {
        controller.destroy();
        controller = null;
    }
});
</script>

<style scoped>
.tunnel-container {
    position: relative;
    width: 100%;
    height: 100%;
    overflow: hidden;
    background: #05060f;
    user-select: none;
    font-family: var(--ff-font-family, system-ui, sans-serif);
}

.tunnel-container.hide-cursor,
.tunnel-container.hide-cursor * {
    cursor: none !important;
}

.tunnel-stage {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
}

/* 顶部 HUD */
.hud-top {
    position: absolute;
    top: 16px;
    left: 20px;
    right: 20px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    pointer-events: none;
    z-index: 10;
}

.hud-left,
.hud-right {
    display: flex;
    align-items: center;
    gap: 12px;
    pointer-events: auto;
}

.hud-badge {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 6px 14px;
    background: rgba(18, 20, 36, 0.7);
    backdrop-filter: blur(16px);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 999px;
    color: #e2e8f0;
    font-size: 13px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
}

.hud-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #a855f7;
    box-shadow: 0 0 10px #a855f7;
    animation: pulse 2.5s infinite;
}

@keyframes pulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.5; transform: scale(0.85); }
}

.hud-title {
    font-weight: 600;
    letter-spacing: 0.02em;
}

.hud-count {
    color: rgba(255, 255, 255, 0.5);
    font-size: 12px;
}

.hud-select {
    padding: 6px 12px;
    background: rgba(18, 20, 36, 0.75);
    backdrop-filter: blur(16px);
    border: 1px solid rgba(255, 255, 255, 0.15);
    border-radius: 999px;
    color: #e2e8f0;
    font-size: 13px;
    outline: none;
    cursor: pointer;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
}

.hud-select option {
    background: #121424;
    color: #e2e8f0;
}

.hud-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 14px;
    background: rgba(18, 20, 36, 0.75);
    backdrop-filter: blur(16px);
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 999px;
    color: #e2e8f0;
    font-size: 13px;
    cursor: pointer;
    transition: all 0.2s cubic-bezier(0.2, 0, 0, 1);
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
}

.hud-btn:hover {
    background: rgba(45, 48, 80, 0.85);
    border-color: rgba(255, 255, 255, 0.25);
    transform: translateY(-1px);
}

.hud-btn.is-active {
    background: rgba(168, 85, 247, 0.25);
    border-color: rgba(168, 85, 247, 0.6);
    color: #d8b4fe;
}

.hud-icon {
    width: 16px;
    height: 16px;
}

.hud-fps {
    padding: 4px 10px;
    background: rgba(0, 0, 0, 0.4);
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: 6px;
    color: rgba(255, 255, 255, 0.45);
    font-size: 11px;
    font-family: monospace;
}

/* 居中指引 */
.hud-hint {
    position: absolute;
    bottom: 110px;
    left: 50%;
    transform: translateX(-50%);
    padding: 8px 18px;
    background: rgba(15, 17, 30, 0.85);
    backdrop-filter: blur(16px);
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 999px;
    color: rgba(255, 255, 255, 0.7);
    font-size: 12px;
    letter-spacing: 0.02em;
    pointer-events: none;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
    z-index: 10;
}

.hint-tag {
    color: #c084fc;
    font-weight: 600;
}

/* 底部对焦卡片浮层（规范统一、距离底部 16px、支持鼠标活动激活/静止收起） */
.hud-bottom-card {
    position: absolute;
    bottom: 16px;
    left: 50%;
    transform: translateX(-50%);
    width: min(680px, calc(100% - 32px));
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 10px 16px;
    background: rgba(16, 18, 32, 0.9);
    backdrop-filter: blur(24px);
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 14px;
    box-shadow: 0 16px 40px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(168, 85, 247, 0.12);
    z-index: 15;
}

.card-thumb-wrap {
    width: 52px;
    height: 52px;
    border-radius: 8px;
    background-color: #1e1e2f;
    flex-shrink: 0;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    border: 1px solid rgba(255, 255, 255, 0.08);
}

.card-thumb-img {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
    display: block;
}

.card-thumb-fallback {
    width: 100%;
    height: 100%;
    background: #2a2d4a;
}

.card-info {
    flex: 1 1 auto;
    min-width: 0;
}

.card-title {
    font-size: 14px;
    font-weight: 600;
    color: #f1f5f9;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    margin-bottom: 4px;
}

.card-meta {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    color: rgba(255, 255, 255, 0.55);
}

.meta-dir {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 260px;
}

.card-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
}

/* 动画过渡 */
.fade-enter-active,
.fade-leave-active {
    transition: opacity 0.5s ease;
}

.fade-enter-from,
.fade-leave-to {
    opacity: 0;
}

.slide-up-enter-active,
.slide-up-leave-active {
    transition: all 0.35s cubic-bezier(0.16, 1, 0.3, 1);
}

.slide-up-enter-from,
.slide-up-leave-to {
    opacity: 0;
    transform: translate(-50%, 20px) scale(0.97);
    pointer-events: none;
}
</style>
