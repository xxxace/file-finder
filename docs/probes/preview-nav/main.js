/**
 * 预览层「上一条 / 下一条 + 定位」的机制探针 —— 被测的**就是** index.vue 里那套写法：
 *
 *   ① 空节点的 `n-image-group`（srcList + 受控 show/current）能不能当真显示预览
 *   ② `current` 变了，`src` 会不会跟着换成 srcList 里对应的那一张
 *   ③ ← → 键（naive-ui 自己监听的 keydown）会不会发 update:current、首尾会不会环绕
 *   ④ `renderToolbar({nodes}).nodes.prev / .next` 放进**我们自己排的数组**里还点得动吗
 *   ⑤ `provide(imageContextKey, {previewedImgPropsRef})` 在 group 之上，能不能真的喂到预览那张 img
 *   ⑥ 那个 onDblclick（双击穿透）—— **A/B 对照**：不加守卫会被调 2 次（既有缺陷），加守卫 1 次
 *   ⑦ srcList 里**同一位置换一张图**（缩略图 → 原图）时，索引不漂移、src 就地换掉
 *   ⑧ 图标条目（width:auto / height:128px）与照片条目（铺满）两套 style 分支
 *
 * 为什么必须真 Chromium：③ 是事件、④ 是命中、⑤ 是**注入链**、⑦⑧ 是样式/布局 ——
 * 静态读代码只能给出"应该"，这些只能在运行时落地。
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

const PHOTO_A = frame(1600, 900, '#26415e', 'photo A');   // 照片条目（铺满那一档）
const PHOTO_B = frame(1200, 1500, '#5e2640', 'photo B');  // 另一张，尺寸/方向都不同 —— 证"换了张"
const ICON = frame(76, 64, '#4a3b2a', 'folder');          // 目录图标条目（folder.png 就是 76×64）
const PHOTO_RAW = frame(2400, 1350, '#1d5a3a', 'RAW');    // "停住后换成的原图"

const app = createApp({
    setup() {
        // 与 index.vue 同构：srcList 是**派生**的（这里用一个开关模拟"停住后换原图"）
        const upgraded = ref(false);
        const list = ref([PHOTO_A, PHOTO_B, ICON]);
        const srcList = computed(() =>
            list.value.map((u, i) => (upgraded.value && i === 1 ? PHOTO_RAW : u)),
        );
        const current = ref(0);
        const show = ref(false);
        const paint = ref('photo'); // photo | icon —— 与 index.vue 的 isIconEntry 同一个分支
        const dblclickHits = ref(0);
        /** A/B 开关：false = 不加守卫（= 现状），true = 加"同一事件只处理一次"的守卫（= 本次修法） */
        const guarded = ref(false);
        let lastEv = null;

        provide(imageContextKey, {
            previewedImgPropsRef: computed(() => ({
                style: paint.value === 'icon'
                    ? { height: '128px', width: 'auto', objectFit: 'contain' }
                    : { width: '100%', height: '100%', objectFit: 'contain' },
                onDblclick: (e) => {
                    if (guarded.value) {
                        if (e === lastEv) return;
                        lastEv = e;
                    }
                    dblclickHits.value++;
                },
            })),
        });

        const renderToolbar = ({ nodes }) => [
            h('span', { id: 'probe-name', style: 'margin:0 4px 0 6px' }, `名称-${current.value}`),
            nodes.prev,
            nodes.next,
            h('span', { id: 'probe-count', style: 'margin-right:10px' }, `${current.value + 1} / ${srcList.value.length}`),
            nodes.rotateCounterclockwise, nodes.rotateClockwise, nodes.resizeToOriginalSize,
            nodes.zoomOut, nodes.zoomIn, nodes.close,
        ];

        // 让 probe 脚本能从外面驱动：这是"照抄 index.vue 的接线方式"，不是测试专用接口
        window.__ctl = {
            show, current, srcList, upgraded, paint, dblclickHits, guarded, list,
            /** 模拟"停住 0.3s 后换成原图" */
            upgrade: () => { upgraded.value = true; },
            /** 模拟 isIconEntry 为真（目录条目） */
            iconEntry: () => { paint.value = 'icon'; current.value = 2; show.value = true; },
            photoEntry: (i = 0) => { paint.value = 'photo'; current.value = i; show.value = true; },
            close: () => { show.value = false; },
        };

        return { srcList, current, show, renderToolbar, onCurrent: v => { current.value = v; }, onShow: v => { show.value = v; } };
    },
    render() {
        // ⚠️ 空节点：与 index.vue 里那个组节点逐字同构（哪怕多一个 n-image 子节点，
        // srcList 模式下就会 throwError，见 naive-ui Image.mjs:53-57）
        return h(NImageGroup, {
            'srcList': this.srcList,
            'current': this.current,
            'show': this.show,
            'renderToolbar': this.renderToolbar,
            'onUpdate:current': this.onCurrent,
            'onUpdate:show': this.onShow,
        });
    },
});

app.mount('#app');
