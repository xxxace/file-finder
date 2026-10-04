/**
 * 探针：预览层「点图外关闭、图内不关、工具条不关」
 *
 * ## 要验的是什么
 *
 * 用户报：点图片外的区域关不掉预览（缩小了也关不掉）。
 * 已定位根因：`usePreview.ts` 曾把图覆盖成 `width/height:100%` ⇒ 图元素铺满视口
 * ⇒ `pointer-events:all` 的图把唯一关闭入口（overlay 的 onClick）完全盖死。
 *
 * ## 三条判据（缺一条都不算修好）
 *
 *   ① 图**没有**铺满视口：四周留出可点空白
 *   ② 点空白处命中的是 **overlay**（⇒ 会关闭），点图上命中的是 `.n-image-preview`
 *   ③ 底部工具条那一条命中**工具条**（⇒ 不会误关）
 *
 * 另加：缩小到最小（naive-ui 下限 0.5）后 ① 依然成立 —— 否则「缩小也关不掉」没修好。
 */
import { createApp, ref, h, computed, provide } from 'vue';
import { NImage, NImageGroup, NImageGroup as _G } from 'naive-ui';
import { imageContextKey } from 'naive-ui/es/image/src/interface.mjs';

const results = [];
const check = (name, pass, detail) => {
    results.push({ name, pass });
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

/** 一张**竖构图**（100×260）：竖图放进横窗口时左右必有留白，最能暴露"铺满"问题。 */
const PORTRAIT = (() => {
    const c = document.createElement('canvas'); c.width = 100; c.height = 260;
    const g = c.getContext('2d'); g.fillStyle = '#5e2640'; g.fillRect(0, 0, 100, 260);
    g.fillStyle = '#fff'; g.font = 'bold 20px sans-serif'; g.fillText('V', 42, 140);
    return c.toDataURL('image/jpeg', 0.9);
})();

/** 横构图（400×120）：宽>高 ⇒ 必须靠**宽度**贴边，否则公式有漏洞。 */
const LANDSCAPE = (() => {
    const c = document.createElement('canvas'); c.width = 400; c.height = 120;
    const g = c.getContext('2d'); g.fillStyle = '#26415e'; g.fillRect(0, 0, 400, 120);
    g.fillStyle = '#fff'; g.font = 'bold 22px sans-serif'; g.fillText('L', 20, 70);
    return c.toDataURL('image/jpeg', 0.9);
})();

const App = {
    setup() {
        const show = ref(false);
        const current = ref(0);
        const srcList = ref([PORTRAIT, LANDSCAPE]);
        // 与 usePreview.ts 现在的写法**逐字同构**：按contain 规则算「可视区内能占的最大尺寸」
        // 并写成 width/height（naive-ui 的 transform 叠在上面，不打架）。
        const previewImgNatural = ref(null);
        const readViewportBox = () => {
            const el = document.querySelector('.n-image-preview-wrapper');
            if (!el) return { w: 0, h: 0 };
            const cs = getComputedStyle(el);
            const px = v => parseFloat(v) || 0;
            return {
                w: el.clientWidth - px(cs.paddingLeft) - px(cs.paddingRight),
                h: el.clientHeight - px(cs.paddingTop) - px(cs.paddingBottom),
            };
        };
        const fitToViewport = (natW, natH) => {
            if (!(natW > 0 && natH > 0)) return null;
            const { w: boxW, h: boxH } = readViewportBox();
            if (!(boxW > 0 && boxH > 0)) return null;
            const k = Math.min(boxW / natW, boxH / natH);
            return { w: Math.round(natW * k), h: Math.round(natH * k) };
        };
        const previewedImgProps = computed(() => {
            const nat = previewImgNatural.value;
            const fitted = nat ? fitToViewport(nat.w, nat.h) : null;
            return {
                style: fitted
                    ? { width: fitted.w + 'px', height: fitted.h + 'px', objectFit: 'contain' }
                    : { maxWidth: '100%', maxHeight: '100%', width: 'auto', height: 'auto', objectFit: 'contain' },
                onDblclick: (e) => e.preventDefault(),
            };
        });
        const watchPreviewImgLoad = () => {
            const el = document.querySelector('.n-image-preview');
            if (!el) { previewImgNatural.value = null; return; }
            const feed = () => { previewImgNatural.value = el.naturalWidth ? { w: el.naturalWidth, h: el.naturalHeight } : null; };
            feed();
            if (!el.complete) el.addEventListener('load', feed, { once: true });
        };
        provide(imageContextKey, { previewedImgPropsRef: previewedImgProps });
        return { show, current, srcList, previewedImgProps, watchPreviewImgLoad };
    },
    mounted() { ctl = this; },
    render() {
        return h('div', [
            h(NImage, {
                src: PORTRAIT, width: 80, previewDisabled: true,
                imgProps: { onClick: () => { this.show = true; this.current = 0; } },
            }),
            h(NImage, {
                src: LANDSCAPE, width: 80, previewDisabled: true,
                imgProps: { onClick: () => { this.show = true; this.current = 1; } },
            }),
            h(NImageGroup, {
                srcList: this.srcList, current: this.current, show: this.show,
                // ⚠️ 必须绑：naive-ui 的关闭只发`update:show`，不绑回去 show 永远不会变false。
                // 主界面绑的是 `onPreviewShowChange`（usePreview.ts:161）。少了这条，
                // 「点遮罩能关」这条判据测的是探针自己的 bug。
                'onUpdate:show': v => { this.show = v; },
            }),
        ]);
    },
};

const app = createApp(App);
// 与主界面同一条重量路径；run() 在 src 变化后调它。
// 用 ref 拿实例而不是 `app._instance`（Options API 下它为空）。
let ctl = null;
app.mount('#app');
window.__watchLoad = () => ctl && ctl.watchPreviewImgLoad();

const nextFrames = (n) => new Promise(res => { let i = 0; const s = () => (++i >= n ? res() : requestAnimationFrame(s)); requestAnimationFrame(s); });

/** 命中测试：这个坐标上最顶层的元素是谁 */
const hit = (x, y) => { const e = document.elementFromPoint(x, y); return e ? e.className || e.tagName : 'null'; };
const isOverlay = (x, y) => { const e = document.elementFromPoint(x, y); return !!(e && String(e.className).includes('image-preview-overlay')); };
const isImg = (x, y) => { const e = document.elementFromPoint(x, y); return !!(e && String(e.className).includes('n-image-preview')); };

const run = async () => {
    await nextFrames(3);
    document.querySelector('.n-image img').click();
    // 与主界面同构：src 变 ⇒ 下一帧重量 naturalWidth（主界面由 img 的 load 事件喂，
    // 探针这里直接调同一个函数——同一条路径，不是另写一套）
    await nextFrames(4);
    window.__watchLoad && window.__watchLoad();
    await nextFrames(12);

    const imgEl = document.querySelector('.n-image-preview');
    const box = imgEl.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    console.log(`---视口 ${vw}×${vh} / 图 ${Math.round(box.width)}×${Math.round(box.height)} @ ${Math.round(box.left)},${Math.round(box.top)} ---`);

    // ① 没有铺满
    const fillsH = box.height >= vh - 2, fillsW = box.width >= vw - 2;
    check('① 图未铺满视口（四周有留白）', !(fillsH || fillsW),
        `图占 ${Math.round(box.width)}×${Math.round(box.height)}，视口 ${vw}×${vh}`);

    // ★ 新增判据：图必须**撑满可视区**（至少一边贴边），且**不超出**可视区。
    //   可视区 = wrapper 内容盒（已扣掉 padding:16px16px64px 那 64px 的工具条）
    const wr = document.querySelector('.n-image-preview-wrapper');
    const cs = getComputedStyle(wr);
    const px = v => parseFloat(v) || 0;
    const vpx = {   // 内容盒 = 外框 − padding（与实现同一个口径）
        w: wr.clientWidth - px(cs.paddingLeft) - px(cs.paddingRight),
        h: wr.clientHeight - px(cs.paddingTop) - px(cs.paddingBottom),
    };
    console.log(`--- wrapper外框 ${wr.clientWidth}×${wr.clientHeight} / padding ${cs.paddingTop} ${cs.paddingRight} ${cs.paddingBottom} ${cs.paddingLeft} ⇒ 内容盒 ${vpx.w}×${vpx.h} ---`);
    const touches = Math.abs(box.height - vpx.h) <= 2 || Math.abs(box.width - vpx.w) <= 2;
    const within = box.width <= vpx.w + 2 && box.height <= vpx.h + 2;
    check('★a 图撑满可视区（至少一边贴边）', touches,
        `图 ${Math.round(box.width)}×${Math.round(box.height)} vs 可视区 ${vpx.w}×${vpx.h}`);
    check('★b 图不超出可视区', within,
        `图 ${Math.round(box.width)}×${Math.round(box.height)} ≤ 可视区 ${vpx.w}×${vpx.h}`);
    // 比例必须保持（contain 的本质），容差 2px 是四舍五入
    const imgEl0 = document.querySelector('.n-image-preview');
    const natRatio = imgEl0.naturalWidth / imgEl0.naturalHeight;
    const boxRatio = box.width / box.height;
    check('★c 保持原图比例（未拉伸变形）', Math.abs(natRatio - boxRatio) / natRatio < 0.02,
        `原图 ${natRatio.toFixed(3)} vs 显示 ${boxRatio.toFixed(3)}`);

    // ②a 图上 ⇒ 命中图（点了不关）
    const cx = Math.round(box.left + box.width / 2), cy = Math.round(box.top + box.height / 2);
    check('②a 点图上命中的是图（不关闭）', isImg(cx, cy), `(${cx},${cy}) → ${hit(cx, cy).slice(0, 40)}`);

    // ②b 图外留白 ⇒ 命中 overlay（⇒ 会关闭）
    const outX = Math.round(box.left + box.width + (vw - (box.left + box.width)) / 2); // 图右侧留白中点
    check('②b 点图外留白命中 overlay（关闭）', isOverlay(outX, cy), `(${outX},${cy}) → ${hit(outX, cy).slice(0, 40)}`);

    // ②c 上方留白（竖图时上下也有留白）
    const outY = Math.max(2, Math.round(box.top / 2));
    check('②c 点上方留白命中 overlay（关闭）', isOverlay(cx, outY), `(${cx},${outY}) → ${hit(cx, outY).slice(0, 40)}`);

    // ③ 底部工具条那条：命中工具条而不是 overlay
    const tb = document.querySelector('.n-image-preview-toolbar');
    if (tb) {
        const t = tb.getBoundingClientRect();
        const tx = Math.round(t.left + t.width / 2), ty = Math.round(t.top + t.height / 2);
        const e = document.elementFromPoint(tx, ty);
        const onToolbar = !!(e && String(e.className).includes('image-preview-toolbar'));
        check('③ 底部工具条命中工具条（不误关）', onToolbar, `(${tx},${ty}) → ${hit(tx, ty).slice(0, 40)}`);
    } else check('③ 底部工具条存在', false, '没找到 .n-image-preview-toolbar');

    // ④ 缩小到最小（naive-ui 下限 0.5）后仍要有留白 —— 否则「缩小也关不掉」没修好
    for (let i = 0; i < 4; i++) {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
        await nextFrames(3);
    }
    const b2 = document.querySelector('.n-image-preview').getBoundingClientRect();
    const stillFills = b2.height >= vh - 2|| b2.width >= vw - 2;
    check('④ 缩到最小后仍有图外留白', !stillFills,
        `缩小后 ${Math.round(b2.width)}×${Math.round(b2.height)}`);
    // 缩小后点留白仍应命中 overlay
    const cx2 = Math.round(b2.left + b2.width + (vw - (b2.left + b2.width)) / 2);
    const cy2 = Math.round(b2.top + b2.height / 2);
    check('④b 缩小后点图外仍命中 overlay', isOverlay(cx2, cy2), `(${cx2},${cy2}) → ${hit(cx2, cy2).slice(0, 40)}`);

    // ⑤ 真点一次遮罩，确认能关
    const before = !!document.querySelector('.n-image-preview');
    const ov = document.querySelector('.n-image-preview-overlay');
    if (ov) ov.click();
    await nextFrames(30);
    const after = !!document.querySelector('.n-image-preview');
    check('⑤ 点遮罩真的能关闭', before && !after, `点击前在场=${before}，30 帧后在场=${after}`);

    // ── 第二轮：换**横图**（宽>高）⇒ 必须靠宽度贴边（与竖图那轮是不同分支）──
    document.querySelectorAll('.n-image img')[1].click();
    await nextFrames(4);
    window.__watchLoad && window.__watchLoad();
    await nextFrames(12);
    const lb = document.querySelector('.n-image-preview').getBoundingClientRect();
    const touchW = Math.abs(lb.width - vpx.w) <= 2, touchH = Math.abs(lb.height - vpx.h) <= 2;
    check('⑥ 横图靠宽度贴边（宽>高的分支）', touchW,
        `图 ${Math.round(lb.width)}×${Math.round(lb.height)} vs 可视区 ${vpx.w}×${vpx.h}（贴宽=${touchW} 贴高=${touchH}）`);
    check('⑥b 横图也不超出', lb.width <= vpx.w + 2 && lb.height <= vpx.h + 2,
        `${Math.round(lb.width)}×${Math.round(lb.height)} ≤ ${vpx.w}×${vpx.h}`);

    const failed = results.filter(r => !r.pass).length;
    console.log(`== ${results.length - failed} PASS / ${failed} FAIL ==`);
};
setTimeout(() => { run().catch(e => console.error('probe error:', e.message)); }, 300);
