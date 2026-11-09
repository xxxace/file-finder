/**
 * 左轨的「流体提示」—— 全局**只有一个**胶囊在入口之间滑动，不是每项各弹一个气泡。
 *
 * 机制（移植自 LeiBox `src/lib/motion-core/fluid-tooltip.mjs`）：
 * 胶囊是个**固定高度的裁切窗口**，内部每条标签各自停在自己那一行的位置；胶囊 `translateY`
 * 到目标行、标签层反向 `translateY` 同样的距离 ⇒ 标签在世界坐标里原地不动，是窗口在文字上
 * 滑过：上一条从上沿移出、下一条从下沿移入。**不是**淡入淡出。
 *
 * 这里用 CSS transition 代替 LeiBox 的 GSAP 补间：两者都是"从当前值向新目标补"，
 * 快速跨项时同样从中间值接续、不跳回旧目标 —— 省掉 600KB 的 engine 包与 gsap 依赖。
 * 缓动参数照抄：位移/宽度 `.43s expo.out`，透明度 `.15s power2.out`（见 RailTip.vue）。
 */
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import type { ComponentPublicInstance, Ref } from 'vue';
import { playSfx } from '@/utils/sfx';

/**
 * 胶囊高度 / 左右内边距。CSS 里**不重复写死** —— RailTip.vue 直接 `import` 这两个值注入 CSS 变量。
 *
 * 比例**照抄 LeiBox**（字 38 / 胶囊 86 / 行高 46 / 左右 32 / 入口 100）：
 *   高度 = 字 × 2.26、行高 = 字 × 1.21、左右 = 字 × 0.84
 * 字号由**本项目**的界面密度定在 14px ⇒ 32 / 16.9 / 12。
 * ⚠️ 先定字号，再乘出其余三个值；反过来（先定高度再塞字）比例一定崩 —— 上一版就是这么翻车的。
 */
export const TIP_HEIGHT = 32;
export const TIP_PAD = 12;
/** 指针穿过两个入口之间那 6px 缝隙时的缓冲，滤掉闪烁（LeiBox 用 75ms） */
const LEAVE_DELAY = 75;

const asElement = (el: Element | ComponentPublicInstance | null) =>
    el instanceof HTMLElement ? el : null;

export function useRailTip(railRef: Ref<HTMLElement | null>) {
    const tipY = ref(0);
    const tipWidth = ref(0);
    const tipOn = ref(false);
    /** 从隐藏态重新出现：几何直接落位、只做淡入，别从上一处滑过来 */
    const tipSnap = ref(false);

    const buttons: HTMLElement[] = [];
    const rows: HTMLElement[] = [];
    const centers: number[] = [];
    /** 上一次响过 hover 音的入口（-1 = 无）；见 show() 里的「只跟入口变化走」注释 */
    let lastIndex = -1;
    let leaveTimer = 0;
    let snapFrames: number[] = [];

    const register = (list: HTMLElement[]) => (index: number, el: Element | ComponentPublicInstance | null) => {
        const node = asElement(el);
        if (node) list[index] = node;
    };
    const setButton = register(buttons);
    const setRow = register(rows);

    /**
     * 只量「按钮中心」并把每行摆到对应高度；**宽度留到 show 时现量** ——
     * 主题按钮的文案会随深浅色变长变短（切到浅色 / 切到深色），预量就会是旧值。
     */
    function measure() {
        // 先读完再写：读写交替的话，每次写 style 都会让下一次 offsetTop 触发一次强制重排
        buttons.forEach((button, index) => {
            if (button && rows[index]) centers[index] = button.offsetTop + button.offsetHeight / 2;
        });
        centers.forEach((center, index) => {
            const row = rows[index];
            if (row) row.style.top = `${center - TIP_HEIGHT / 2}px`;
        });
    }

    function paint(index: number) {
        const row = rows[index];
        if (!row) return;
        tipY.value = centers[index] - TIP_HEIGHT / 2;
        tipWidth.value = Math.ceil(row.offsetWidth + TIP_PAD * 2);
    }

    function clearSnapFrames() {
        snapFrames.forEach((id) => cancelAnimationFrame(id));
        snapFrames = [];
    }

    function show(index: number) {
        if (index < 0 || !buttons[index]) return;
        window.clearTimeout(leaveTimer);
        leaveTimer = 0;

        // hover 音只跟「入口变化」走（Switch/PS5 焦点 tick 的模型）：
        // 同一颗按钮无论 pointerenter / focus / 动画后重算 hover 来几次 show，都不许响第二声。
        // 指针真正离开（hide 清零）后再回来，才算一次新的到达。
        if (index !== lastIndex) playSfx('hover');
        lastIndex = index;

        if (tipOn.value) {
            // 已经在显示：正常滑动过去（CSS 会从当前值接续，不跳回旧目标）
            paint(index);
            return;
        }

        // 首次出现 / 已淡出后重现 —— LeiBox 同款：几何一步到位，只让透明度淡进来
        tipSnap.value = true;
        paint(index);
        tipOn.value = true;
        clearSnapFrames();
        snapFrames.push(
            requestAnimationFrame(() => {
                snapFrames.push(
                    requestAnimationFrame(() => {
                        snapFrames = [];
                        tipSnap.value = false;
                    }),
                );
            }),
        );
    }

    function hide() {
        tipOn.value = false;
        lastIndex = -1;
    }

    /** 指针离开：等一拍再收 —— 立刻收会在入口之间的缝隙里疯狂闪 */
    function leave() {
        window.clearTimeout(leaveTimer);
        leaveTimer = window.setTimeout(() => {
            leaveTimer = 0;
            // 键盘焦点还停在本组件某个入口上就留着，否则 Tab 过来只看到提示闪一下
            const focused = buttons.indexOf(document.activeElement as HTMLElement);
            if (focused >= 0) show(focused);
            else hide();
        }, LEAVE_DELAY);
    }

    let observer: ResizeObserver | undefined;
    onMounted(async () => {
        await nextTick();
        measure();
        const rail = railRef.value;
        if (!rail || typeof ResizeObserver === 'undefined') return;
        // 下组用 `space-between` 压在底部 ⇒ 窗口一改高，那两颗按钮的中心就变了
        observer = new ResizeObserver(measure);
        observer.observe(rail);
    });
    onBeforeUnmount(() => {
        observer?.disconnect();
        window.clearTimeout(leaveTimer);
        clearSnapFrames();
    });

    return { tipY, tipWidth, tipOn, tipSnap, setButton, setRow, show, leave };
}
