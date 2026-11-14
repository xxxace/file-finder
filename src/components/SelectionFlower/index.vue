<template>
    <!-- 挂到 body 而不是留在 AppShell 里：祖先上任何 transform / filter 都会把 `fixed` 变成
         相对祖先定位，全屏层就塌了。Teleport 出去与样式、清理都无关。 -->
    <Teleport to="body">
        <canvas v-if="ENABLED && bloomPrefs.on" ref="canvasRef" class="sf-layer" aria-hidden="true" />
    </Teleport>
</template>

<script setup lang="ts">
/**
 * 选区开花彩蛋的**宿主**（2026-11-14）。
 *
 * 这个文件只管三件事：一块画布、一张监听表、设置开关的去留。
 * "花怎么长、什么时候种、什么时候收"全在 `bloom.ts`；
 * 选区怎么读在 `geometry.ts`；形状与绘制在 `draw.ts`。
 *
 * ⚠️ 为什么是"一个全屏层"而不是"每个页面各挂一份"：`selectionchange` 本来就是 document 级事件，
 *    一处监听覆盖全文档；放进各组件反而会把同一件事实现很多遍。
 * ⚠️ 松手收回、选区消失也收回 —— 两条路都走 `release()`，**但只有松手才关 active**：
 *    pointerdown 本身会让浏览器清掉旧选区并派发一次 collapsed 的 selectionchange，
 *    那一刻如果顺手关了 active，接下来整段拖选就一个花都不种了。
 * ⚠️ 关开关要**真的清干净**：`stop()` 撤监听、停帧、断引用（含模块级 Range 吊着的文本节点）。
 *    只停监听会留一层空画布压在页面上，只清花会留监听在 document 上——两边都是泄漏。
 */
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { createBloom } from './bloom';
import { bloomPrefs } from './pref';

/** 总闸：一行关掉整个彩蛋（不动设置、不动别处代码） */
const ENABLED = true;

const canvasRef = ref<HTMLCanvasElement | null>(null);
const bloom = createBloom();

let media: MediaQueryList | null = null;

/**
 * 监听登记表，停用时按**注册时那一组参数**原样拆掉。
 * ⚠️ add/remove 成对手写最容易漏 capture —— 漏了就是关掉之后监听还在（拖一次冒一屏幽灵花）。
 */
type Bound = [EventTarget, string, EventListener, AddEventListenerOptions | undefined];
let unbind: (() => void) | null = null;

const onResize = () => bloom.resize();
const onSelection = () => bloom.sync();
const onDown = () => bloom.setActive(true);
const onUp = () => bloom.release();
const onVisibility = () => bloom.setPaused(document.hidden);
const onMotionChange = () => bloom.setReduced(!!media?.matches);
const onKey: EventListener = (e) => {
    const event = e as KeyboardEvent;
    // 键盘也能扩选区（Shift+方向 / Ctrl+A / Home / End），这条路没有 pointerdown 开头
    const selectAll = (event.ctrlKey || event.metaKey) && (event.key === 'a' || event.key === 'A');
    if (selectAll || event.shiftKey || event.key === 'Home' || event.key === 'End') bloom.setActive(true);
};

function start() {
    // 幂等：重复进来会把上一组监听覆盖掉 ⇒ 那组永远没人拆，成了幽灵
    if (unbind) return;
    const canvas = canvasRef.value;
    if (!canvas) return;
    bloom.start(canvas);
    bloom.setReduced(!!media?.matches);

    const bound: Bound[] = [];
    const on = (target: EventTarget, type: string, listener: EventListener, options?: AddEventListenerOptions) => {
        target.addEventListener(type, listener, options);
        bound.push([target, type, listener, options]);
    };
    on(window, 'resize', onResize);
    on(document, 'selectionchange', onSelection);
    // capture + passive：应用里有些手势会 stopPropagation，先一步拿到才算"这一轮开始了"
    on(document, 'pointerdown', onDown, { capture: true, passive: true });
    on(window, 'pointerup', onUp, { capture: true, passive: true });
    on(window, 'pointercancel', onUp, { capture: true, passive: true });
    on(window, 'blur', onUp);
    on(document, 'keydown', onKey, { capture: true });
    on(document, 'visibilitychange', onVisibility);
    if (media) on(media, 'change', onMotionChange);
    unbind = () => {
        bound.forEach(([t, type, fn, options]) => t.removeEventListener(type, fn, options));
        bound.length = 0;
    };
}

function stop() {
    unbind?.();
    unbind = null;
    bloom.stop();
}

onMounted(() => {
    if (!ENABLED) return;
    media = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (bloomPrefs.on) start();
});

onBeforeUnmount(() => {
    stop();
    media = null;
});

// 关掉 = 连画布一起撤走（v-if），不只是停监听
watch(
    () => bloomPrefs.on,
    (on) => {
        if (!ENABLED) return;
        if (!on) {
            stop();
            return;
        }
        // `v-if` 换上的 canvas 要等一拍才进 DOM，那时才拿得到 ctx
        nextTick(start);
    },
);
</script>

<style scoped>
.sf-layer {
    position: fixed;
    inset: 0;
    width: 100%;
    height: 100%;
    z-index: var(--ff-flower-z);
    /* 纯装饰：既不吃点击，也不参与文本选择（否则它自己会变成选区的一部分） */
    pointer-events: none;
    user-select: none;
    /* 无花时藏起来（由 bloom 的 paint() 开关） */
    visibility: hidden;
    /* ⚠️ 别用 `mix-blend-mode` 解决"花盖字"：darken / lighten 都试过，落在字上的花的像素
       会被字形整个吃掉 ⇒ 字是清楚了，花反而被"挖"成碎片。
       正确解法是**位置避让**：出生点在字边缘、只朝字外长（见 geometry.ts 的 top/bottom）。 */
}
</style>
