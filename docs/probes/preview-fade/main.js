/**
 * 探针：预览层关闭时的淡出缺陷（`<img src=undefined>`）
 *
 * ## 要验的是什么
 *
 * 用户报的现象：打开预览图 → 关闭 → 淡出动画期间出现"图片图标 + 空白透明边框"。
 *
 * 根因（已定位，见 out.txt 证据）：关闭时把 `previewKey` 清掉 ⇒ `previewIndex` 变 -1
 * ⇒ `:current="-1"` ⇒ naive-ui `ImageGroup.mjs:78,83` 算出 `currentId/currentUrl=undefined`
 * ⇒ `ImagePreview.mjs:561` 的 `src` 变 undefined。而 `:564` 的 `vShow` 在淡出期间
 * 仍让这个 `<img>` 留在场（naive-ui 用 `displayed` 专门留了这段窗口，`:496`）。
 *
 * ## 为什么静态读代码不够
 *
 * 缺陷只存在于「`show` 已 false、DOM 仍在场」这个**动画窗口**内。要抓到它必须
 * 真的点关闭、然后在**同一个 tick 之后**去读那个 `<img>` 的 `src`。
 *
 * ## 判据
 *
 * 关闭后的若干帧内，`.n-image-preview` 的 `getAttribute('src')` 必须**始终非空**。
 * 修复前它是 `null`/`undefined`（或属性不存在），修复后是那条真实 URL。
 */
import { createApp, ref, computed, h } from 'vue';
import { NImage, NImageGroup } from 'naive-ui';

/** 一条假的图片条目：1×1 PNG，够用来让 `<img>` 有真实可加载的 src。 */
const PNG_1x1 =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=';

/** 三条，够测「上一条/下一条」与 `key` 变更。 */
const FILES = [
    { name: 'a.png', src: PNG_1x1 },
    { name: 'b.png', src: PNG_1x1 },
    { name: 'c.png', src: PNG_1x1 },
];

const results = [];
const check = (name, pass, detail) => {
    results.push({ name, pass, detail });
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

const App = {
    setup() {
        // ── 与 usePreview.ts 同构的三件状态（判据相同，才能测同一个缺陷）──
        const fileList = ref(FILES);
        const keyOf = (f) => f.name;
        const previewKey = ref('');
        // ▼▼▼ A/B 开关：默认测**修复前**的行为（`DERIVED_MODE=true`），
        // 用来证明这条断言真能抓到缺陷；把`DERIVED_MODE=false` 切到修复后。
        const DERIVED_MODE = new URLSearchParams(location.search).get('mode') !== 'fixed';
        const previewOpenState = ref(false);
        const previewEntries = computed(() => fileList.value.map(f => ({ file: f, key: keyOf(f), src: f.src })));
        const previewIndex = computed(() => previewEntries.value.findIndex(e => e.key === previewKey.value));
        const previewSrcList = computed(() => previewEntries.value.map(e => e.src));
        // 修复前：`open` 完全从 key 派生，关= 清 key ⇒ current 变 -1 ⇒ src 空
        // 修复后：开关独立，关只翻开关，key 留着 ⇒ current 有效 ⇒ src 一直在
        const previewOpen = computed(() => DERIVED_MODE
            ? previewIndex.value >= 0
            : (previewOpenState.value && previewIndex.value >= 0));

        const openPreview = (f) => { previewKey.value = keyOf(f); previewOpenState.value = true; };
        // 修复前的关法：清 key。修复后的关法：只翻开关。
        const closePreview = () => {
            previewOpenState.value = false;
            if (DERIVED_MODE) previewKey.value = '';
        };
        const onShowChange = (v) => { if (v) previewOpenState.value = true; else closePreview(); };

        return { fileList, keyOf, previewEntries, previewIndex, previewSrcList, previewOpen, openPreview, closePreview, onShowChange };
    },
    render() {
        // ⚠️ 结构必须与主界面**逐字同构**：`n-image-group` 是个**空节点**（只有 src-list /
        // current / show 三个 prop），网格里的 `n-image` 是它的**兄弟**而不是孩子。
        // 把 n-image 放进 default slot 会触发 naive-ui 的
        // 「can't be placed inside n-image-group when src-list is set」警告 —— 那说明探针
        // 抄错了结构，判据就不足以代表真实界面。
        return h('div', { style: 'display:flex;gap:8px;padding:8px;' }, [
            // 网格：与 group 平级
            ...this.fileList.map(f =>
                h(NImage, {
                    key: f.name,
                    src: f.src,
                    width: 80,
                    // 与主界面同构：`preview-disabled` 挡住 n-image 自己的弹窗，
                    // 改由 `img-props.onClick` 走我们自己的 openPreview（Image.mjs:99-102 会先
                    // 调 showPreview，被 disabled 挡住，再把 onClick 转出去）。
                    previewDisabled: true,
                    imgProps: { onClick: () => this.openPreview(f) },
                })),
            // 预览层：**空节点**
            h(NImageGroup, {
                srcList: this.previewSrcList,
                current: this.previewIndex,
                show: this.previewOpen,
                'onUpdate:show': this.onShowChange,
            }),
        ]);
    },
};

/** 读预览层那张 `<img>` 的 src 属性。null = 属性不存在（即 `src=undefined`）。 */
const readPreviewSrc = () => {
    const img = document.querySelector('.n-image-preview');
    if (!img) return { exists: false, src: null };
    return { exists: true, src: img.getAttribute('src'), display: getComputedStyle(img).display };
};

const nextFrames = (n) => new Promise(res => {
    let i = 0;
    const step = () => (++i >= n ? res() : requestAnimationFrame(step));
    requestAnimationFrame(step);
});

const app = createApp(App);
app.mount('#app');

const run = async () => {
    const DERIVED = new URLSearchParams(location.search).get('mode') !== 'fixed';
    console.log(`--- A/B 模式：${DERIVED ? '修复前（open 派生自 key）' : '修复后（开关独立）'} ---`);
    await nextFrames(3);
    // 打开第 2 条（点的是 n-image 内部那张真 img —— n-image 的 onImgClick 挂在它上面）
    const img2 = document.querySelectorAll('.n-image img')[1];
    check('网格里有 3 张卡', !!img2, img2 ? '找到第 2 张' : '没找到');
    img2.click();
    await nextFrames(5);
    const opened = readPreviewSrc();
    check('打开后 preview 层在场且 src 非空', opened.exists && !!opened.src, JSON.stringify(opened));
    if (!opened.exists) { console.log('== 0 PASS / 1 FAIL（预览层没打开，后面的断言无意义）=='); return; }

    // 关闭（走真实事件：点遮罩 = naive-ui 自己的 close 路径）
    document.querySelector('.n-image-preview-overlay').click();

    // ⚠️ 关键：关闭后的**前几帧**就是缺陷窗口 —— 此刻 DOM 在场（displayed）但 src 可能已空
    const frames = [];
    for (let i = 0; i < 6; i++) {
        await nextFrames(1);
        frames.push(readPreviewSrc());
    }
    const emptyFrames = frames.filter(f => f.exists && !f.src);
    check(
        '淡出期间 src 始终非空',
        emptyFrames.length === 0,
        emptyFrames.length === 0
            ? `6 帧全有 src（首个 = ${String(frames[0].src).slice(0, 24)}…）`
            : `✗ 有 ${emptyFrames.length}/6 帧 src 为空（属性不存在）`,
    );
    // 动画走完之后 DOM 应当被回收（displayed=false ⇒ 整层卸载）
    await nextFrames(40);
    check('动画结束后预览层已卸载', !readPreviewSrc().exists, 'DOM 已移除');

    // ── 顺带验「重新打开同一条」还能再开 ──
    // 修复前 key 被清空，重开走"从空到有值"；修复后 key 一直在，
    // 所以这条断言同时守着"别把重开弄丢了"这个副作用。
    document.querySelectorAll('.n-image img')[1].click();
    await nextFrames(5);
    const reopened = readPreviewSrc();
    check('重新打开同一条仍能打开', reopened.exists && !!reopened.src, JSON.stringify(reopened));

    const failed = results.filter(r => !r.pass).length;
    console.log(`== ${results.length - failed} PASS / ${failed} FAIL ==`);
    // ⚠️ 页面里没有 `process`（那是 Node 的东西）⇒ 退出码交给 run.cjs 按 PASS/FAIL 统计
};

setTimeout(() => { run().catch(e => { console.error('probe error:', e.message); }); }, 300);
