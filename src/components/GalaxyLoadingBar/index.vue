<template>
    <canvas ref="canvasRef" class="galaxy-bar" aria-hidden="true" />
</template>

<script setup lang="ts">
/**
 * galaxy 进度像素层 —— **铺满自己所在的那个盒子**（2026-11-08 第二轮）。
 *
 * 上一版它是一条贴在窗口顶部的 14px 轨道；主人要求"把效果用到地址栏的盒子里、占满整个盒子"，
 * 于是几何从"窗口宽 × `--ff-bar-h`"改成"父盒子的实际尺寸 × 100%"，其余一个常数都没动
 * （逐格相位、左疏右密、三层辉光、放射粒子仍全在 `draw.ts`，那是唯一实现）。
 *
 * ⚠️ 它**仍然不接管进度**：每帧读 `.n-loading-bar` 的宽度 ÷ 容器的宽度 = 进度比例，
 * 再乘本盒子的宽度。naive 依旧是唯一真相源（4s 缓爬、收尾淡出、出错变红全部照旧）。
 * ⚠️ 顶部那条现在只是 `visibility: hidden`（App.vue 的 container-style）——
 * **不能用 `display:none` / `height:0`**：那会让 `rect.height` 归零，本层就判成"加载结束"了。
 *
 * ⚠️⚠️ naive 的 `init()` **不重置 `started`** ⇒ 第一次加载之后 `.n-loading-bar-container`
 * 会**永久留在 DOM 里**，只靠 `display:none` 藏起来。两个后果都得挡住：
 *   ① 判"还在不在"不能用元素存在性，否则循环永不退出；而且 `display:none` 下 `rect.width`
 *      是 0，辉光会被画在 x=0 上 ⇒ 那团紫光常驻在左边缘。判据改成 **`rect.height > 0`**。
 *   ② 后续每次 `start()` 只是把 display 改回来、**不增删节点** ⇒ `MutationObserver(childList)`
 *      不再触发。所以叫醒用 **`ResizeObserver`**（display 切换与宽度动画都会让它报尺寸变化），
 *      childList 观察只负责"第一次出现时把 ResizeObserver 挂上去"。
 */
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useTheme } from '@/hooks/useTheme';
import { drawGalaxyBar } from './draw';

const BAR = '.n-loading-bar';
const BAR_ERROR = 'n-loading-bar--error';

const canvasRef = ref<HTMLCanvasElement | null>(null);

let ctx: CanvasRenderingContext2D | null = null;
let raf = 0;
let clock = 0;
let last = 0;
/** 本盒子的 CSS 尺寸（画布的坐标系就是它） */
let boxW = 0;
let boxH = 0;
let colors: string[] = [];
let glowCore = '';
let glowMid = '';
let glowSoft = '';
/** 底色渐变色标，来自 `--ff-bar-base-stops`（Canvas 不吃 CSS 变量，得拆成 位置 + 颜色串） */
let stops: { pos: number; color: string }[] = [];
/** 出错态的底色：naive 原来是把整条 bar 变红，本层必须接住这个信号（否则出错=效果凭空消失） */
let errorColor = '';
let mountObserver: MutationObserver | null = null;
let sizeObserver: ResizeObserver | null = null;
let boxObserver: ResizeObserver | null = null;
let watchedBar: HTMLElement | null = null;
let reduced: MediaQueryList | null = null;

const readVar = (name: string) => {
    const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    // 读不到就是 token 层漏了名字：开发期喊一声，别让整层静默不画（同 `naive-theme.ts` 的做法）
    if (!raw && import.meta.env.DEV) console.warn(`[galaxy-bar] token 缺失：${name}`);
    return raw;
};

/**
 * ⚠️ 色板是**两套**（浅 / 深），所以这些值必须能重读，不能在 onMounted 里抓一次就锁死。
 *    Canvas 不吃 CSS 变量 —— 它只认已解析的颜色串，这是它与 DOM 元素最本质的差别。
 *    ⇒ 切主题时若不重读，画布会一直停在挂载那一刻的配色（2026-11-08 浅色偏暗的一半原因）。
 */
/** `--ff-bar-base-stops: #hex 0%, #hex 12%, …` → Canvas 的 `addColorStop(0..1, color)` */
function parseStops(raw: string): { pos: number; color: string }[] {
    return raw.split(',')
        .map(part => /^(\S+)\s+([\d.]+)%$/.exec(part.trim()))
        .filter((m): m is RegExpExecArray => !!m)
        .map(m => ({ color: m[1], pos: Number(m[2]) / 100 }));
}

function readTokens() {
    glowCore = readVar('--ff-bar-glow-core');
    glowMid = readVar('--ff-bar-glow');
    glowSoft = readVar('--ff-bar-glow-soft');
    stops = parseStops(readVar('--ff-bar-base-stops'));
    errorColor = readVar('--ff-danger-badge');
    colors = [1, 2, 3, 4, 5, 6].map(i => readVar(`--ff-bar-px-${i}`)).filter(Boolean);
}

const { theme } = useTheme();
watch(theme, async () => {
    // `data-theme` 由 useTheme 的模块级 watch 写入；等一拍确保 computed style 已经是新主题
    await nextTick();
    readTokens();
});

/**
 * 尺寸跟着**父盒子**走，不跟窗口 —— 搜索展开/收起会把地址槽收窄，
 * 那时 backing store 必须重建，否则点阵会被 CSS 拉伸成一片糊。
 */
const resize = () => {
    const canvas = canvasRef.value;
    if (!canvas || !ctx) return;
    const host = canvas.parentElement;
    if (!host) return;
    const rect = host.getBoundingClientRect();
    boxW = rect.width;
    boxH = rect.height;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.ceil(boxW * dpr));
    canvas.height = Math.max(1, Math.ceil(boxH * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
};

/** 一次布局读取同时回答三件事：还在不在、进度多少、整体透明度 */
const measure = (): { ratio: number; alpha: number; error: boolean } | null => {
    const bar = document.querySelector<HTMLElement>(BAR);
    if (!bar) return null;
    const rect = bar.getBoundingClientRect();
    if (rect.height <= 0) return null;
    const host = bar.parentElement;
    const hostW = host ? host.getBoundingClientRect().width : 0;
    const alpha = host ? Number(getComputedStyle(host).opacity) || 0 : 1;
    // hostW 为 0 时别除 —— 那时还没有可画的宽度，交给下面 `ratio >= 0` 的判据
    return {
        ratio: hostW > 0 ? rect.width / hostW : 0,
        alpha,
        error: bar.classList.contains(BAR_ERROR),
    };
};

const frame = (now: number) => {
    const canvas = canvasRef.value;
    if (!canvas || !ctx) { raf = 0; return; }

    const m = measure();
    if (!m) {
        // 加载结束 ⇒ 清屏收工。不留下最后一帧，否则那团光晕就常驻了
        ctx.clearRect(0, 0, boxW, boxH);
        raf = 0;
        return;
    }

    ctx.clearRect(0, 0, boxW, boxH);

    /* ⚠️ 判据是 `ratio > 0`，**没有任何最小阈值**（2026-11-08 主人：
       "阈值不需要等到 30%，0% 或 10% 就开启"）。之前的死区是自然的：底色没人画、
       星点又"左疏"，于是在进度爬过某个宽度之前，盒子里看着什么都没有。
       现在底色从 0 就跟着画 ⇒ 一有进度就有一条紫，不会有一段"看不出在加载"的空窗。 */
    if (m.ratio > 0 && boxW > 0 && boxH > 0) {
        const dt = last ? Math.min(0.05, (now - last) / 1000) : 0;
        last = now;
        // 减动效下冻结时间 ⇒ 点阵是静帧，但宽度照跟
        if (!reduced?.matches) clock += dt;
        /* ⚠️ 出错态**也要画**：顶部那条被藏起来后，naive 的"变红"就没人接了，
           直接跳过 = 出错时进度效果凭空消失（比显示一条红更怪）。
           做法是复用同一份 `drawGalaxyBar`，只把输入换掉：色标换成一条纯红、
           点阵与光晕传空 ⇒ 只剩一条红底，星云安静地停住。 */
        drawGalaxyBar(ctx, {
            width: Math.min(boxW, m.ratio * boxW),
            height: boxH,
            time: clock,
            alpha: m.alpha,
            colors: m.error ? [] : colors,
            glowCore: m.error ? '' : glowCore,
            glowMid: m.error ? '' : glowMid,
            glowSoft: m.error ? '' : glowSoft,
            // 盒子外面是别人的地盘（会被 `overflow: hidden` 裁掉），所以不留扩散余量
            pad: 0,
            // 出错态 = 一条纯红：两端同色，星云安静停住
            stops: m.error
                ? [{ pos: 0, color: errorColor }, { pos: 1, color: errorColor }]
                : stops,
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
    // 下一拍才把它显示出来。第一拍就 return 的话 ResizeObserver 永远挂不上。
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

    readTokens();

    resize();
    window.addEventListener('resize', resize);

    // 父盒子自己的尺寸变化（搜索展开、窗口缩放、密度切换）都要重建 backing store
    const host = canvas.parentElement;
    if (host) {
        boxObserver = new ResizeObserver(() => resize());
        boxObserver.observe(host);
    }

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
    boxObserver?.disconnect();
    boxObserver = null;
    window.removeEventListener('resize', resize);
});
</script>

<style scoped>
.galaxy-bar {
    /* 铺满父盒子（地址槽）。`inset: 0` 让它不吃任何布局 —— 槽里的面包屑照旧排布 */
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    /* 跟着槽的圆角走，否则星点会从圆角外面漏出一小块 */
    border-radius: inherit;
    pointer-events: none;
    /* 0 = 槽的面之上、面包屑之下（`.crumbs` 是 z-index 1） */
    z-index: 0;
}
</style>
