<template>
    <Teleport to="body">
        <!-- toast：右下角。⚠️ 不放右上 —— 顶栏 44px + 地址槽占了那一整条，
             提示压上去就是在盖住"我正在操作的地方"。 -->
        <div class="ffo-toasts" aria-live="polite">
            <TransitionGroup name="ffo-toast">
                <div
                    v-for="t in overlayState.toasts"
                    :key="t.id"
                    class="ffo-toast"
                    @mouseenter="hold(t.id)"
                    @mouseleave="release(t.id)"
                >
                    <span class="ffo-toast__icon" :class="`is-${t.kind}`">
                        <component :is="iconOf(t.kind)" />
                    </span>
                    <div class="ffo-toast__text">
                        <div v-if="t.title" class="ffo-toast__title">{{ t.title }}</div>
                        <div v-if="t.body" class="ffo-toast__body">{{ t.body }}</div>
                    </div>
                    <div v-if="t.action" class="ffo-toast__side">
                        <span class="ffo-toast__countdown" :title="`剩余 ${secondsLeft(t)} 秒`">
                            <svg class="ffo-toast__pie" viewBox="0 0 18 18" aria-hidden="true">
                                <circle class="ffo-toast__pie-track" cx="9" cy="9" r="7.5" />
                                <circle
                                    class="ffo-toast__pie-fill"
                                    cx="9"
                                    cy="9"
                                    r="4.5"
                                    :style="{ animationDuration: `${t.duration ?? TOAST_MS}ms` }"
                                />
                            </svg>
                            <span class="ffo-toast__sec">{{ secondsLeft(t) }}s</span>
                        </span>
                        <button
                            type="button"
                            class="ffo-toast__action"
                            :disabled="actingId === t.id"
                            @click="runAction(t)"
                        >
                            {{ t.action.label }}
                        </button>
                    </div>
                </div>
            </TransitionGroup>
        </div>

        <!-- confirm：一次只渲染队列头部，保证串行 -->
        <Transition name="ffo-confirm">
            <div v-if="current" class="ffo-confirm">
                <div class="ffo-mask" @click="onMask" />
                <div
                    ref="panelRef"
                    class="ffo-card"
                    role="dialog"
                    aria-modal="true"
                    :aria-label="current.title"
                >
                    <h2 class="ffo-card__title">{{ current.title }}</h2>
                    <p v-if="current.content" class="ffo-card__content">{{ current.content }}</p>
                    <div class="ffo-card__actions">
                        <button
                            v-if="current.negativeText"
                            ref="cancelRef"
                            type="button"
                            class="ffo-btn ffo-btn--ghost"
                            :disabled="pending"
                            @click="cancel"
                        >
                            {{ current.negativeText }}
                        </button>
                        <button
                            ref="okRef"
                            type="button"
                            class="ffo-btn ffo-btn--primary"
                            :class="{ 'is-busy': pending }"
                            :disabled="pending"
                            :aria-busy="pending"
                            @click="ok"
                        >
                            {{ current.positiveText || '好' }}
                        </button>
                    </div>
                </div>
            </div>
        </Transition>
    </Teleport>
</template>

<script setup lang="ts">
/**
 * 浮层宿主：挂在 App.vue，全应用唯一一个。
 *
 * ⚠️ 这里**不引 naive**：遮罩、焦点陷阱、Esc、层级全在这一处自管，
 *   换主题/换前缀都不会动到它；两个 assistant 全屏工作区仍用 n-modal（它们只是页面级容器）。
 * ⚠️ 滚动锁不用写：浮层 teleport 到 body，页面的滚动容器在遮罩**下面但不是 DOM 祖先**，
 *   滚轮事件到了 body 就没了 —— 这是结构给的保证，不是漏了。
 */
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue';
import { CheckmarkCircleOutline, InformationCircleOutline, WarningOutline, CloseCircleOutline } from '@vicons/ionicons5';
import { overlayState, popConfirm, removeToast } from './store';
import type { OverlayKind, ToastItem } from './store';
import './overlay.css';

const TOAST_MS = 2500;

const current = computed(() => overlayState.confirms[0] ?? null);
const pending = ref(false);
const panelRef = ref<HTMLElement | null>(null);
const cancelRef = ref<HTMLButtonElement | null>(null);
const okRef = ref<HTMLButtonElement | null>(null);

const ICONS: Record<OverlayKind, unknown> = {
    success: CheckmarkCircleOutline,
    info: InformationCircleOutline,
    warning: WarningOutline,
    error: CloseCircleOutline,
};

function iconOf(kind: OverlayKind) {
    return ICONS[kind] ?? InformationCircleOutline;
}

/* ════ toast 计时：悬停暂停，移开后按剩余时间继续 ════ */

interface TimerRec {
    handle: ReturnType<typeof setTimeout> | null;
    left: number;
    at: number;
}

const timers = new Map<number, TimerRec>();
const leftSec = reactive<Record<number, number>>({});
const actingId = ref<number | null>(null);
let tickHandle: ReturnType<typeof setInterval> | null = null;

function syncTick() {
    const hasActionToast = overlayState.toasts.some(t => t.action);
    if (hasActionToast && !tickHandle) {
        tickHandle = setInterval(() => {
            const now = Date.now();
            for (const t of overlayState.toasts) {
                if (!t.action) continue;
                const rec = timers.get(t.id);
                if (!rec) continue;
                const rem = rec.handle ? Math.max(0, rec.left - (now - rec.at)) : rec.left;
                leftSec[t.id] = Math.max(1, Math.ceil(rem / 1000));
            }
        }, 200);
    } else if (!hasActionToast && tickHandle) {
        clearInterval(tickHandle);
        tickHandle = null;
    }
}

function secondsLeft(t: ToastItem): number {
    return leftSec[t.id] ?? Math.max(1, Math.ceil((t.duration ?? TOAST_MS) / 1000));
}

async function runAction(t: ToastItem) {
    if (!t.action || actingId.value === t.id) return;
    actingId.value = t.id;
    try {
        await t.action.onClick();
    } finally {
        if (actingId.value === t.id) actingId.value = null;
        removeToast(t.id);
    }
}

function arm(id: number, ms: number) {
    const handle = setTimeout(() => {
        timers.delete(id);
        delete leftSec[id];
        removeToast(id);
    }, ms);
    timers.set(id, { handle, left: ms, at: Date.now() });
    leftSec[id] = Math.max(1, Math.ceil(ms / 1000));
}

function hold(id: number) {
    const rec = timers.get(id);
    if (!rec || !rec.handle) return;
    clearTimeout(rec.handle);
    rec.left = Math.max(0, rec.left - (Date.now() - rec.at));
    rec.handle = null;
}

function release(id: number) {
    const rec = timers.get(id);
    if (!rec || rec.handle) return;
    arm(id, rec.left);
}

watch(
    () => overlayState.toasts.map(t => t.id),
    (ids) => {
        const live = new Set(ids);
        for (const [id, rec] of timers) {
            if (live.has(id)) continue;
            if (rec.handle) clearTimeout(rec.handle);
            timers.delete(id);
            delete leftSec[id];
        }
        for (const t of overlayState.toasts) {
            if (!timers.has(t.id)) arm(t.id, t.duration ?? TOAST_MS);
        }
        syncTick();
    },
);

/* ════ confirm：焦点陷阱 + Esc + 焦点归还 ════ */

let restoreTo: HTMLElement | null = null;

function onKeydown(e: KeyboardEvent) {
    if (!current.value) return;

    if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (!pending.value) cancel();
        return;
    }

    if (e.key !== 'Tab') return;
    const panel = panelRef.value;
    if (!panel) return;
    const items = Array.from(panel.querySelectorAll<HTMLElement>('.ffo-btn:not(:disabled)'));
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
    }
}

watch(
    current,
    async (c) => {
        if (c) {
            restoreTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
            window.addEventListener('keydown', onKeydown, true);
            await nextTick();
            // 破坏性操作的默认落点放在**取消**上：误按回车的代价太大
            (cancelRef.value ?? okRef.value)?.focus();
        } else {
            window.removeEventListener('keydown', onKeydown, true);
            restoreTo?.focus?.();
            restoreTo = null;
            pending.value = false;
        }
    },
    { flush: 'post' },
);

function cancel() {
    if (pending.value) return;
    const c = current.value;
    popConfirm();
    c?.onNegativeClick?.();
}

function onMask() {
    if (pending.value) return;
    // 只有显式写了 false 才拦；没写就跟随 naive 的老行为（点遮罩即取消）
    if (current.value?.maskClosable === false) return;
    cancel();
}

async function ok() {
    const c = current.value;
    if (!c || pending.value) return;

    if (c.onPositiveClick) {
        try {
            pending.value = true;
            await c.onPositiveClick();
        } catch {
            // 失败**不关**：调用方已经 notify 过了，留着让用户重试比静默收摊好
            pending.value = false;
            return;
        }
        pending.value = false;
    }
    popConfirm();
}

onBeforeUnmount(() => {
    window.removeEventListener('keydown', onKeydown, true);
    if (tickHandle) {
        clearInterval(tickHandle);
        tickHandle = null;
    }
    for (const rec of timers.values()) {
        if (rec.handle) clearTimeout(rec.handle);
    }
    timers.clear();
});
</script>
