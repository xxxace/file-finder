/**
 * 预览层「双击无行为 + 滚轮缩放」的行为探针。
 *
 * 被测的两条与 `src/views/FileFinder/usePreview.ts` **同构**：
 *   ① `previewedImgProps.onDblclick` **不派发任何事件**（业主裁定「双击单击都没有行为」）
 *   ② 滚轮 → 派发 `ArrowUp`/`ArrowDown` → naive-ui 真的缩放了
 *      （它的 keydown 绑在 **document** 上，`ArrowUp→zoomIn` / `ArrowDown→zoomOut`）
 *
 * ③ 另有一条**关窗检查**：预览关掉后滚轮监听必须撤掉（否则是"看不见的全局监听"，
 *    关了预览还会一直拦页面滚动）。
 *
 * 为什么必须真 Chromium：① 要验"**没有**发生什么"（派发计数必须 0）；
 * ② 要量 transform 的实际数值；③ 要抓真实的监听状态。静态读代码只能给出"应该"。
 */
import { createApp, h, provide, ref, computed, watch } from 'vue';
import { NImageGroup } from 'naive-ui/es/image/index.mjs';
import { imageContextKey } from 'naive-ui/es/image/src/interface.mjs';

function frame(w, h, color, label) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    g.fillStyle = color; g.fillRect(0, 0, w, h);
    g.fillStyle = '#fff';
    g.font = `bold ${Math.round(w / 14)}px sans-serif`;
    g.fillText(label, w / 8, h / 2);
    return c.toDataURL('image/jpeg', 0.85);
}

const PHOTO = frame(1600, 900, '#26415e', 'photo');

const app = createApp({
    setup() {
        // ⚠️ 必须**初始为 false** 再打开：naive-ui 是在 `watch(mergedShowRef)` 里挂 keydown
        //   监听的（ImagePreview.mjs:112），初始就true ⇒ watch 从不触发 ⇒ 键盘/缩放全都失灵。
        //   生产里预览总是「关 → 开」，所以那边没问题；探针必须复现这条路径。
        const show = ref(false);
        window.__setShow = v => { show.value = v; };
        window.__open = () => { show.value = true; };
        const current = ref(0);
        // 「预览开着」= show 为真。⚠️ 生产里这个派生自 `previewIndex >= 0`（条目没了就自动关），
        // 探针里没有列表，直接用 show 即可 —— 要测的是"开关��变 ⇒ 滚轮跟着挂/撤"。
        const previewOpen = computed(() => show.value && current.value >= 0);

        // ── 观测点：全部挂在 window 上，跑.cjs 的 executeJavaScript 直接读 ──
        const hits = { cardDblclick: 0, overlayClick: 0, wheel: 0, dblclickFired: 0, cardFound: false, stackLen: 0 };
        window.__hits = hits;
        /** A/B 开关：true = 本次修法（双击什么都不做）；false = 旧实现（对照） */
        const noop = ref(true);
        window.__setNoop = v => { noop.value = v; };

        /** 滚轮缩放：与生产同款（派发 ↑↓ 键，走 naive-ui 自己的 zoomIn/zoomOut） */
        let removeWheel;
        const installWheelZoom = () => {
            if (removeWheel) return;                 // 幂等
            const onWheel = (e) => {
                if (!previewOpen.value) return;     // 预览没开就不拦页面滚动
                e.preventDefault();
                hits.wheel++;
                document.dispatchEvent(new KeyboardEvent('keydown', {
                    key: e.deltaY < 0 ? 'ArrowUp' : 'ArrowDown',
                    bubbles: true, cancelable: true,
                }));
            };
            document.addEventListener('wheel', onWheel, { passive: false });
            removeWheel = () => { document.removeEventListener('wheel', onWheel); removeWheel = undefined; };
        };
        watch(previewOpen, open => { if (open) installWheelZoom(); else removeWheel?.(); });
        window.__wheelListenerAttached = () => removeWheel !== undefined;

        provide(imageContextKey, {
            previewedImgPropsRef: computed(() => ({
                style: { width: '100%', height: '100%', objectFit: 'contain' },
                onDblclick: (e) => {
                    // 本次修法：什么都不做，只吃掉浏览器默认
                    if (noop.value) { e.preventDefault(); return; }
                    // 旧实现（留作 A/B 对照）：关预览 + 把双击还给下面那张卡片
                    hits.dblclickFired++;
                    document.querySelector('.n-image-preview-overlay')?.click();
                    const stack = document.elementsFromPoint(e.clientX, e.clientY);
                    const card = stack.find(el => el.classList && el.classList.contains('image-box-item'));
                    hits.cardFound = !!card;
                    hits.stackLen = stack.length;
                    card?.dispatchEvent(new MouseEvent('dblclick', {
                        bubbles: true, cancelable: true, clientX: e.clientX, clientY: e.clientY,
                    }));
                },
            })),
        });

        return () => h('div', [
            h('div', {
                class: 'image-box-item',
                onDblclick: () => { hits.cardDblclick++; },
            }, 'card'),
            h(NImageGroup, {
                srcList: [PHOTO],
                current: current.value,
                show: show.value,
                renderToolbar: () => [h('span', { onClick: () => { show.value = false; } }, 'close')],
                'onUpdate:show': v => { show.value = v; },
                'onUpdate:current': v => { current.value = v; },
            }),
        ]);
    },
});
app.mount('#app');
// 初始关 → 打开，复现生产的路径（挂上 naive-ui 的 keydown 监听）
window.__open();

/** 重开预览（A/B 对照那步会把它关掉）—— 探针要靠它恢复到可测状态 */
window.__reopen = () => { window.__open(); };

/** 读预览 img 当前的 transform —— naive-ui 把 scale 写在这里 */
window.__tf = () => {
    const el = document.querySelector('.n-image-preview');
    return el ? (el.style.transform || getComputedStyle(el).transform) : null;
};
