/**
 * 预览层「底部通栏工具条」的**几何**探针。
 *
 * 被测的三条 CSS 规则在 `index.html` 里，与 `src/views/FileFinder/index.vue`
 * 末尾那个非 scoped `<style>` 块**逐字相同**（不是手抄的近似值 —— 抄错了测出来的数就没意义）。
 * 被测的 `renderToolbar` 也是同构的：**左信息（名称+计数） · 右操作（全部按钮）**。
 *
 * 为什么必须真 Chromium：这里问的全是**布局与命中**
 * （工具条有没有真贴底 / 图有没有被压 / 点图外能不能关 / translateX 有没有真去掉）——
 * 静态读 CSS 只能给出"应该"，`translateX(-50%)` 残留这类问题只有真排版才现形。
 */
import { createApp, h, provide, ref, computed } from 'vue';
import { NImageGroup } from 'naive-ui/es/image/index.mjs';
import { imageContextKey } from 'naive-ui/es/image/src/interface.mjs';

function frame(w, h, color, label) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const g = c.getContext('2d');
    g.fillStyle = color;
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#fff';
    g.font = `bold ${Math.round(w / 14)}px sans-serif`;
    g.fillText(label, w / 8, h / 2);
    return c.toDataURL('image/jpeg', 0.85);
}

const PHOTO_WIDE = frame(1600, 900, '#26415e', 'wide');   // 宽银幕：宽 > 高
const PHOTO_TALL = frame(1200, 1500, '#5e2640', 'tall');  // 竖图：高 > 宽 —— 两种方向都要试

// ── 与 index.vue 同款样式常量 ────────────────────────────────────────────────
const PREVIEW_NAME_STYLE = 'margin-right: 10px; max-width: min(46vw, 720px); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;';
const PREVIEW_COUNT_STYLE = 'font-size: 13px; opacity: .55; white-space: nowrap;';
const PREVIEW_GROUP_STYLE = 'display: flex; align-items: center;';
const PREVIEW_GROUP_LEFT_STYLE = `${PREVIEW_GROUP_STYLE} min-width: 0;`;
const PREVIEW_GROUP_RIGHT_STYLE = `${PREVIEW_GROUP_STYLE} margin-left: auto;`;

const app = createApp({
    setup() {
        const list = ref([PHOTO_WIDE, PHOTO_TALL]);
        const srcList = computed(() => list.value);
        const current = ref(0);
        const show = ref(true);
        /** 探针控制面：切图 / 改名 / 关 */
        window.__probe = {
            setCurrent: i => { current.value = i; },
            setName: s => { name.value = s; },
            close: () => { show.value = false; },
            open: () => { show.value = false; requestAnimationFrame(() => { show.value = true; }); },
        };
        const name = ref('示例作品标题-01');

        provide(imageContextKey, {
            previewedImgPropsRef: computed(() => ({
                style: { width: '100%', height: '100%', objectFit: 'contain' },
            })),
        });

        const toolbar = ({ nodes }) => {
            const total = srcList.value.length;
            const hasNav = total > 1;
            // 生产里是一颗 LocateOutline 图标；探针用同尺寸的方块占位，几何结论一致
            const locate = h('span', {
                title: '定位到网格（回车）',
                style: 'display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0 8px;cursor:pointer;',
                onClick: () => { window.__locateHits = (window.__locateHits || 0) + 1; },
            }, '⌖');
            return [
                h('span', { style: PREVIEW_GROUP_LEFT_STYLE }, [
                    h('span', { style: PREVIEW_NAME_STYLE, title: name.value }, name.value),
                    ...(hasNav ? [h('span', { style: PREVIEW_COUNT_STYLE },
                        `${current.value + 1} / ${total}`)] : []),
                ]),
                h('span', { style: PREVIEW_GROUP_RIGHT_STYLE }, [
                    locate,
                    ...(hasNav ? [nodes.prev, nodes.next] : []),
                    nodes.rotateCounterclockwise, nodes.rotateClockwise, nodes.resizeToOriginalSize,
                    nodes.zoomOut, nodes.zoomIn, nodes.close,
                ]),
            ];
        };

        return () => h(NImageGroup, {
            srcList: srcList.value,
            current: current.value,
            show: show.value,
            renderToolbar: toolbar,
            'onUpdate:show': v => { show.value = v; },
            'onUpdate:current': v => { current.value = v; },
        });
    },
});
app.mount('#app');
