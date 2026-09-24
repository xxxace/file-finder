/**
 * 布局对照：把三份**真实**工具条分别挂到 #a / #b / #c，交给真浏览器量。
 *
 * 为什么要真浏览器：结构探针（happy-dom）没有布局引擎 ——
 * 它能证明"渲染了几个节点"，证明不了"工具条有几行高"。用户报的正是后者。
 */
import { createApp, defineComponent, h, ref, computed } from 'vue';
import * as naive from 'naive-ui';
import { render as layoutA } from './LayoutA.js';
import { render as layoutB } from './LayoutB.js';
import { render as layoutC } from './LayoutC.js';

const IconStub = defineComponent({ name: 'IconStub', render: () => h('i') });

function ctx() {
    return {
        scanning: ref(false),
        scanDone: ref(0),
        scanPending: ref(0),
        openStack: ref([{ name: 'videos', path: 'H:/videos', mode: 'cover' }]),
        readOnlyLevel: computed(() => false),
        fileList: ref([{ name: 'a' }]),
        searchText: ref(''),
        searchInput: ref(null),
        dir: ref('H:/videos'),
        startScan: () => { }, onScanCancel: () => { }, showHistory: () => { }, onRefresh: () => { },
        Search: IconStub, Refresh: IconStub, FootstepsOutline: IconStub
    };
}

function mountInto(mountId, render) {
    const c = ctx();
    const app = createApp({
        render: () => h(naive.NConfigProvider, null, { default: () => h(defineComponent({ setup: () => c, render })) })
    });
    for (const [k, v] of Object.entries(naive)) {
        if (/^N[A-Z]/.test(k)) app.component(k.replace(/^N/, 'n-').replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase(), v);
    }
    app.component('IconStub', IconStub);
    app.mount(document.getElementById(mountId));
}

mountInto('a', layoutA);
mountInto('b', layoutB);
mountInto('c', layoutC);

/** 量一个变体：头高、行数、搜索框宽度、右侧组的矩形 */
function measure(sel) {
    const box = document.querySelector(sel);
    const bar = box.querySelector('.header-bar');
    const search = box.querySelector('.header-bar .n-input');
    const group = Array.from(bar.children).find(el => el !== bar.querySelector('.hstack'));
    // 视觉行数：把子元素的纵向区间按重叠合并成"带"，带的个数才是真的行数。
    // （不能按 top 去重 —— 图标按钮和输入框高度不同，同一行也会有不同的 top。）
    const rects = Array.from(group.children).map(el => el.getBoundingClientRect())
        .sort((p, q) => p.top - q.top);
    let bands = 0, bottom = -Infinity;
    for (const r of rects) {
        if (r.top >= bottom - 1) { bands++; bottom = r.bottom; }
        else bottom = Math.max(bottom, r.bottom);
    }
    const tops = Array.from({ length: bands }, (_, i) => i);
    const br = bar.getBoundingClientRect();
    return {
        headerHeight: Math.round(br.height),
        rows: tops.length,
        groupWidth: Math.round(group.getBoundingClientRect().width),
        searchWidth: search ? Math.round(search.getBoundingClientRect().width) : 0,
        groupFlexWrap: getComputedStyle(group).flexWrap,
        items: Array.from(group.children).map(el => (el.textContent || '').trim().slice(0, 8) || el.className.split(' ')[0])
    };
}

window.__measure = () => ({
    viewport: { w: window.innerWidth, h: window.innerHeight },
    a: measure('#a'),
    b: measure('#b'),
    c: measure('#c')
});
