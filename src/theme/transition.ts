/**
 * 圆形扩散主题切换 —— View Transitions 编排。
 *
 * 做法：新旧快照各占一个分组（`theme-outgoing` / `theme-incoming`），新快照上盖一层
 * **圆形遮罩**，只动画 `mask-size` / `mask-position` 让圆长大 —— 快照本身一像素都不动。
 *
 * ⚠️ 为什么不是「圆框放大 + 内容反向缩小」（LeiBox 那版的写法）：
 *   image-pair 放大 `s`、new 反向缩 `1/s` 是**两条独立动画**，关键帧之间各自线性插值，
 *   乘积只在节点处 = 1、区间中点会鼓出来 ⇒ 净变换不恒等 ⇒ 整幅画面绕圆心做微小缩放。
 *   实测（探针 docs/probes/theme-transition/）动画中途红点位移 1.6px、结束时精确回位，
 *   视觉上正是「界面上下抖 + 右下漏 1~2px」。
 * ⚠️ 也不能退回 `clip-path`：它只有二值、没有羽化，观感是硬边（对比过，被否）。
 *   mask 全程不缩放，所以「羽化」和「零位移」能同时成立。
 *
 * ⚠️ 另两个坑：几何必须取整（亚像素在缩放/裁剪下会抖）；拆样式必须等 `transition.finished`，
 *   提前删会在最后一帧让伪元素跳回全屏。
 */

const DURATION = 650;
const EASING = 'cubic-bezier(0.65, 0, 0.35, 1)';
/** 羽化宽度（px）—— 圆的实心半径到边缘之间的渐隐带 */
const FEATHER = 250;
/** 半径余量：盖住视口最远角 + 羽化带，别在角落留一条没换色的缝 */
const RADIUS_PAD = 260;

const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)');

type Apply = () => void | Promise<void>;

/** 全局唯一在跑的那次过渡的中断入口 —— 连点时先收上一次，两层快照叠在同一个 html 上会互相打脸 */
let running: (() => void) | null = null;

export function runThemeTransition(apply: Apply, source?: HTMLElement | null): void {
    const root = document.documentElement;

    // 不支持 / 系统关了动效 / 窗口不可见 ⇒ 直接切，别留半截伪元素
    if (!document.startViewTransition || REDUCED_MOTION.matches || document.hidden) {
        void apply();
        return;
    }

    running?.();

    // 真实视口（小数精度）：html 的 border-box 就是视口；取 max 兜住内滚容器把 html 撑大的情况
    const viewport = root.getBoundingClientRect();
    const vw = Math.ceil(Math.max(viewport.width, window.innerWidth));
    const vh = Math.ceil(Math.max(viewport.height, window.innerHeight));

    const rect = source?.getBoundingClientRect();
    const x = Math.round(rect ? rect.left + rect.width / 2 : vw / 2);
    const y = Math.round(rect ? rect.top + rect.height / 2 : vh / 2);
    const radius =
        Math.ceil(Math.hypot(Math.max(x, vw - x), Math.max(y, vh - y))) + RADIUS_PAD;

    // 遮罩铺满整个视口，只靠 mask-size / mask-position 让圆长大；画面本身一像素都不动
    const geometry = document.createElement('style');
    geometry.textContent = `
:root::view-transition-image-pair(theme-incoming) {
  mask-image: radial-gradient(closest-side, #000 calc(100% - ${FEATHER}px), transparent 100%);
  mask-repeat: no-repeat;
  mask-size: 0px 0px;
  mask-position: ${x}px ${y}px;
}`;

    const previousName = root.style.viewTransitionName;
    let transition: ViewTransition | undefined;
    let settled = false;
    let cleaned = false;

    /** 主题必须落地：动画被打断时也得把最后一步补上，否则颜色卡在半路 */
    const settle = () => {
        if (settled) return;
        settled = true;
        void apply();
    };

    /** 拆样式 —— 只在过渡真正结束后调用 */
    const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        settle();
        geometry.remove();
        REDUCED_MOTION.removeEventListener('change', abort);
        document.removeEventListener('visibilitychange', onVisibilityChange);
        if (running === abort) {
            running = null;
            delete root.dataset.themeTransition;
            root.style.viewTransitionName = previousName;
        }
    };

    /** 中断：立刻结束过渡（随后仍走 cleanup，样式不提前拆） */
    const abort = () => {
        settle();
        transition?.skipTransition();
    };

    function onVisibilityChange() {
        if (document.hidden) abort();
    }

    running = abort;
    root.dataset.themeTransition = 'soft-focus';
    root.style.viewTransitionName = 'theme-outgoing';
    document.head.appendChild(geometry);
    REDUCED_MOTION.addEventListener('change', abort);
    document.addEventListener('visibilitychange', onVisibilityChange);

    transition = document.startViewTransition(async () => {
        if (settled) return;
        root.style.viewTransitionName = 'theme-incoming';
        await apply();
    });

    void transition.ready.then(
        () => {
            if (settled) return;
            // 两条属性都线性插值，且 `pos + size/2` 恒等于 (x, y) ⇒ 圆心严格不动
            const animation = root.animate(
                [
                    { maskSize: '0px 0px', maskPosition: `${x}px ${y}px` },
                    {
                        maskSize: `${radius * 2}px ${radius * 2}px`,
                        maskPosition: `${x - radius}px ${y - radius}px`,
                    },
                ],
                {
                    duration: DURATION,
                    easing: EASING,
                    fill: 'both',
                    pseudoElement: '::view-transition-image-pair(theme-incoming)',
                },
            );
            void animation.finished.then(abort, abort);
        },
        abort,
    );
    void transition.finished.then(cleanup, cleanup);
}
