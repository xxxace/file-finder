<template>
    <canvas ref="canvasRef" class="galaxy-bar" aria-hidden="true" />
</template>

<script setup lang="ts">
/**
 * 顶部进度条的 galaxy 像素层（galaxy-effort-slider 的轨道，去掉大脑图标）。
 *
 * ⚠️ 它**不接管**进度条，只是它的"影子"：每帧读 `.n-loading-bar` 的实际宽度和容器不透明度，
 * 在同一位置画像素点 + 前缘光晕 + 放射粒子。这样 naive 仍是唯一的进度真相源
 * （4s 缓爬、收尾淡出、出错变红全部照旧），我们只补它做不到的那一层。
 * ⚠️ 颜色的唯一来源仍是 `tokens.css`：这里只读 `--ff-bar-*`，不写任何色值。
 *
 * ⚠️⚠️ naive 的 `init()` **不重置 `started`** ⇒ 第一次加载之后 `.n-loading-bar-container`
 * 会**永久留在 DOM 里**，只靠 `display:none` 藏起来。两个后果都得挡住（2026-11-08 踩过）：
 *   ① 判"还在不在"不能用元素存在性，否则循环永不退出；而且 `display:none` 下 `rect.width`
 *      是 0，辉光会被画在 x=0 上 ⇒ 那团紫光常驻在左上角。判据改成 **`rect.height > 0`**
 *      （藏起来时 height 也归零，而刚起步 width=0 时 height 还是 14，两者能分开）。
 *   ② 后续每次 `start()` 只是把 display 改回来、**不增删节点** ⇒ `MutationObserver(childList)`
 *      不再触发。所以叫醒用 **`ResizeObserver`**（display 切换与宽度动画都会让它报尺寸变化），
 *      childList 观察只负责"第一次出现时把 ResizeObserver 挂上去"。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { drawGalaxyBar } from './draw';

const BAR = '.n-loading-bar';
const BAR_ERROR = 'n-loading-bar--error';

const canvasRef = ref<HTMLCanvasElement | null>(null);

let ctx: CanvasRenderingContext2D | null = null;
let raf = 0;
let clock = 0;
let last = 0;
let barH = 14;
/** 画布比条高出来的部分：留给前缘光晕向外扩散（按条高算，条越厚光晕越大） */
let pad = 42;
let colors: string[] = [];
let glowCore = '';
let glowMid = '';
let glowSoft = '';
let mountObserver: MutationObserver | null = null;
let sizeObserver: ResizeObserver | null = null;
let watchedBar: HTMLElement | null = null;
let reduced: MediaQueryList | null = null;

const readVar = (name: string) => {
    const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    // 读不到就是 token 层漏了名字：开发期喊一声，别让整层静默不画（同 `naive-theme.ts` 的做法）
    if (!raw && import.meta.env.DEV) console.warn(`[galaxy-bar] token 缺失：${name}`);
    return raw;
};

const resize = () => {
    const canvas = canvasRef.value;
    if (!canvas || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.style.height = `${barH + pad}px`;
    canvas.width = Math.ceil(window.innerWidth * dpr);
    canvas.height = Math.ceil((barH + pad) * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
};

/** 一次布局读取同时回答两件事：条在不在（height>0）、画多宽 */
const measure = (): { bar: HTMLElement; width: number; height: number; alpha: number } | null => {
    const bar = document.querySelector<HTMLElement>(BAR);
    if (!bar) return null;
    const rect = bar.getBoundingClientRect();
    if (rect.height <= 0) return null;
    const host = bar.parentElement;
    const alpha = host ? Number(getComputedStyle(host).opacity) || 0 : 1;
    return { bar, width: rect.width, height: rect.height, alpha };
};

const frame = (now: number) => {
    const canvas = canvasRef.value;
    if (!canvas || !ctx) { raf = 0; return; }

    const m = measure();
    if (!m) {
        // 条已藏起来 ⇒ 清屏收工。不留下最后一帧，否则那团光晕就常驻了
        ctx.clearRect(0, 0, window.innerWidth, barH + pad);
        raf = 0;
        return;
    }

    ctx.clearRect(0, 0, window.innerWidth, barH + pad);

    // width<1 是刚挂上来的头一两帧（max-width 还是 0%）：什么都别画，否则光晕会在左边缘闪一下
    if (m.width >= 1 && !m.bar.classList.contains(BAR_ERROR) && colors.length && glowMid) {
        const dt = last ? Math.min(0.05, (now - last) / 1000) : 0;
        last = now;
        // 减动效下冻结时间 ⇒ 点阵是静帧，但宽度照跟
        if (!reduced?.matches) clock += dt;
        drawGalaxyBar(ctx, {
            width: m.width,
            height: m.height,
            time: clock,
            alpha: m.alpha,
            colors,
            glowCore,
            glowMid,
            glowSoft,
            pad,
        });
    }

    raf = requestAnimationFrame(frame);
};

/** 只要元素在 DOM 里就把 ResizeObserver 挂上 —— 哪怕它此刻还是 display:none */
const attach = (): boolean => {
    const bar = document.querySelector<HTMLElement>(BAR);
    if (!bar) return false;
    if (watchedBar !== bar) {
        sizeObserver?.disconnect();
        watchedBar = bar;
        sizeObserver = new ResizeObserver(() => kick());
        sizeObserver.observe(bar);
    }
    return true;
};

function kick() {
    if (raf) return;
    if (!attach()) return;
    // ⚠️ 挂观察器**绝不能等"看得见"**：naive 的 `start()` 是先插一个 `display:none` 的容器、
    // 下一拍（`await nextTick()` 之后）才把它显示出来。第一拍就 return 的话 ResizeObserver
    // 永远挂不上，此后每次加载既不增删节点、也没人观察 ⇒ 只能靠别处碰巧往 body 插节点时被唤醒。
    // 症状就是"切好几次目录，像素层才出现"（2026-11-08 主人抓到的正是这个）。
    if (!measure()) return;
    // 新一轮可见期 ⇒ 时间轴归零。`burst = exp(-time*6)` 是"开头一次爆发"，
    // time 一路累加不归零的话，第一次加载之后这个爆发就永远死掉了。
    clock = 0;
    last = 0;
    raf = requestAnimationFrame(frame);
}

onMounted(() => {
    const canvas = canvasRef.value;
    if (!canvas) return;
    ctx = canvas.getContext('2d');
    reduced = window.matchMedia('(prefers-reduced-motion: reduce)');

    barH = Number.parseFloat(readVar('--ff-bar-h')) || 14;
    // 光晕是圆形向外扩散的 ⇒ 画布必须比条高出一截，否则会被下边界切平
    pad = Math.round(barH * 3);
    glowCore = readVar('--ff-bar-glow-core');
    glowMid = readVar('--ff-bar-glow');
    glowSoft = readVar('--ff-bar-glow-soft');
    colors = [1, 2, 3, 4, 5, 6].map(i => readVar(`--ff-bar-px-${i}`)).filter(Boolean);

    resize();
    window.addEventListener('resize', resize);

    // 进度条容器是 teleport 到 body 的：childList 只负责抓它第一次出现
    mountObserver = new MutationObserver(() => kick());
    mountObserver.observe(document.body, { childList: true });
    kick();
});

onBeforeUnmount(() => {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    mountObserver?.disconnect();
    mountObserver = null;
    sizeObserver?.disconnect();
    sizeObserver = null;
    window.removeEventListener('resize', resize);
});
</script>

<style scoped>
.galaxy-bar {
    position: fixed;
    top: 0;
    left: 0;
    width: 100vw;
    /* 高度由 JS 按 `--ff-bar-h + pad` 写 inline（一处真相源） */
    pointer-events: none;
    /* naive 的进度条容器是 5999，且它是后 teleport 进 body 的 ⇒ 这里必须压过它 */
    z-index: 6000;
}
</style>
