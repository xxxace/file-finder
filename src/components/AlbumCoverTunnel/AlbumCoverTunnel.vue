<template>
    <div ref="containerRef" class="tunnel-container" :class="{ 'is-fullscreen': isFullscreen }">
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

        <!-- 底部焦点封面详情操作面板 -->
        <Transition name="slide-up">
            <div v-if="activeCover" class="hud-bottom-card">
                <div class="card-thumb" :style="{ backgroundImage: activeCover.src ? `url(${activeCover.src})` : 'none' }"></div>
                <div class="card-info">
                    <div class="card-title" :title="activeCover.title">{{ activeCover.title }}</div>
                    <div class="card-meta">
                        <span v-if="activeCover.raw?.serial" class="meta-tag">{{ activeCover.raw.serial }}</span>
                        <span v-if="activeCover.raw?.dir" class="meta-dir" :title="activeCover.raw.dir">{{ activeCover.raw.dir }}</span>
                        <span v-if="activeCover.raw?.size" class="meta-size">{{ formatSize(activeCover.raw.size) }}</span>
                    </div>
                </div>
                <div class="card-actions">
                    <button type="button" class="btn-primary" @click="handleSelect">
                        <svg viewBox="0 0 24 24" class="btn-icon">
                            <path fill="currentColor" d="M8 5v14l11-7z" />
                        </svg>
                        <span>预览 / 播放</span>
                    </button>
                    <button v-if="activeCover.raw?.dir" type="button" class="btn-secondary" title="在文件列表中定位" @click="handleNavigateDir">
                        <svg viewBox="0 0 24 24" class="btn-icon">
                            <path fill="currentColor" d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z" />
                        </svg>
                        <span>定位目录</span>
                    </button>
                </div>
            </div>
        </Transition>
    </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, onActivated, onDeactivated, watch } from 'vue';
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

onMounted(() => {
    if (!stageRef.value) return;

    controller = createAlbumCoverTunnel(stageRef.value, {
        theme: props.theme,
        autoTravel: true,
        onSelect: (item) => {
            activeCover.value = item;
            playSfx('menu-click');
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
        void controller.setCovers(props.items);
    }

    setTimeout(() => {
        showHint.value = false;
    }, 7000);
});

watch(
    () => props.items,
    (next) => {
        if (controller) {
            void controller.setCovers(next);
        }
    },
    { deep: false },
);

onBeforeUnmount(() => {
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

/* 底部对焦卡片浮层 */
.hud-bottom-card {
    position: absolute;
    bottom: 24px;
    left: 50%;
    transform: translateX(-50%);
    width: min(720px, calc(100% - 40px));
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 12px 18px;
    background: rgba(16, 18, 32, 0.88);
    backdrop-filter: blur(24px);
    border: 1px solid rgba(255, 255, 255, 0.15);
    border-radius: 16px;
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(168, 85, 247, 0.15);
    z-index: 15;
}

.card-thumb {
    width: 52px;
    height: 52px;
    border-radius: 8px;
    background-size: cover;
    background-position: center;
    background-color: #1e1e2f;
    flex-shrink: 0;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
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

.meta-tag {
    padding: 1px 6px;
    background: rgba(168, 85, 247, 0.2);
    border: 1px solid rgba(168, 85, 247, 0.4);
    border-radius: 4px;
    color: #d8b4fe;
    font-size: 10px;
}

.meta-dir {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 280px;
}

.meta-size {
    color: rgba(255, 255, 255, 0.4);
}

.card-actions {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-shrink: 0;
}

.btn-primary,
.btn-secondary {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 8px 16px;
    border-radius: 8px;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s cubic-bezier(0.2, 0, 0, 1);
}

.btn-primary {
    background: linear-gradient(135deg, #9333ea, #6366f1);
    border: 1px solid rgba(255, 255, 255, 0.2);
    color: #ffffff;
    box-shadow: 0 4px 16px rgba(147, 51, 234, 0.4);
}

.btn-primary:hover {
    filter: brightness(1.15);
    transform: translateY(-1px);
}

.btn-secondary {
    background: rgba(255, 255, 255, 0.08);
    border: 1px solid rgba(255, 255, 255, 0.12);
    color: #e2e8f0;
}

.btn-secondary:hover {
    background: rgba(255, 255, 255, 0.15);
    border-color: rgba(255, 255, 255, 0.25);
}

.btn-icon {
    width: 14px;
    height: 14px;
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
    transition: all 0.35s cubic-bezier(0.2, 0, 0, 1);
}

.slide-up-enter-from,
.slide-up-leave-to {
    opacity: 0;
    transform: translate(-50%, 20px);
}
</style>
