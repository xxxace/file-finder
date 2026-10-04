/**
 * 预览层：上一条 / 下一条 + 定位到网格 + 缩略图渐进升级。
 *
 * ## 为什么是composable 而不是子组件
 *
 * 子组件（`PreviewLayer.vue`）需要双向 props + 事件来回传（`previewKey` 改回去、
 * `fileList` 传进来、`imageBox` 传进来、`picking` 传进来……），而预览层**要读的是网格里
 * 真实 DOM**（`imageBox` 定位格子、`elementsFromPoint` 反查卡片）——
 * 那些 DOM 在父组件里，子组件拿不到，只能靠 ref 层层传，**props 链会比现在更长**。
 * composable 的边界正好落在"状态与计算"上，DOM 那一侧留一个 ref 进来即可。
 *
 * ## 契约：参数进、状态出，**不反向写参数**
 *
 * 入参全是 `Ref` / `ComputedRef`（只读用），返回的 `openPreview` 是唯一写入口。
 * 这一点是刻意的 —— 本项目一贯的「**唯一可写的那一个**」手法：
 * `previewKey` 是"正在看哪一条"的唯一真相，索引 / 是否打开 / 有没有升级成清晰版全部从它派生。
 * 列表一变（刷新 / 盘插拔 / 换目录 / 搜索），**不可能**留下"索引指向了别的条目"这种脱钩状态：
 * 条目没了 ⇒ 索引算出来是 -1 ⇒ 预览层自己关掉，**不需要任何同步代码**。
 *
 * 同族手法：`currentPath → crumbs`、`dataSource + searchText → fileList`。
 */
import { computed, h, ref, watch } from 'vue';
import { NIcon } from 'naive-ui';
import { LocateOutline } from '@vicons/ionicons5';
import type { ImgHTMLAttributes } from 'vue';
import type { WiredFileInfo } from '../../../electron/server/index';

/** 局部别名：只表达"可读 .value"，不为了两个类型 import 一堆 vue 类型 */
type RefLike<T> = { value: T };
type ComputedRefLike<T> = { readonly value: T };

export function usePreview(deps: {
    /** 当前这一屏的条目（过滤后的视图） */
    fileList: ComputedRefLike<WiredFileInfo[]>;
    /** 条目身份，序列与网格的 `:key`/`:data-key` 同源 */
    keyOf: (item: WiredFileInfo) => string;
    /**
     * 「立刻显示的那张图」—— 与网格里那张卡片**逐条同一规则**（"卡片的大图版"）：
     * 图片 / 视频 → 它的缩略图；目录 → 它的脸，没有脸就是文件夹图标。
     * 这些都是**本地已有**的图 ⇒ 打开是瞬时的、零读盘。
     */
    displaySrcOf: (item: WiredFileInfo) => string;
    /** 大图地址；空串 = 没有可升级的清晰版 */
    previewUrlOf: (item: WiredFileInfo) => string;
    /** 「换封面」模式进行中？那时单击格子是选中，不弹预览 */
    picking: RefLike<boolean>;
    /** 网格滚动容器，`locateInGrid` 要在里面找格子 */
    imageBox: RefLike<HTMLElement | null>;
}) {
    const { fileList, keyOf, displaySrcOf, previewUrlOf, picking, imageBox } = deps;

    // ── 状态：只有 previewKey 可写 ───────────────────────────────────────────
    /** 正在看哪一条（`keyOf` 的值）。空串 = 没在看 */
    const previewKey = ref('');
    /** 已经升级成清晰版的那一条。空串 = 没有 */
    const sharpKey = ref('');
    /** 「定位」之后被描边闪一下的那一条。空串 = 没有 */
    const locatedKey = ref('');

    /**
     * 预览层当前该显示哪张图：**停住之后能升级就升级**。
     *
     * ⚠️ 原来升级那一档是"直接读 `/raw` 原图"（每次打开都真读一次移动硬盘，而且 `/raw`
     * 连一个缓存头都没有 ⇒ 同一张图重复打开也照读）。现在改成**先探一次 `/preview`**：
     * 本地有大图就几乎瞬时换上；没有才由服务端读一次原图、生成并存下来
     * （**只此一次**，之后连请求都被浏览器缓存挡住）。离线因此也能看到清晰版（只要看过一次）。
     *
     * 它在**本模块内**定义而不是入参：`sharpKey` 是这里的私有状态，外部自己判会漏掉
     * 「换条目就清空」这条约定。
     */
    const previewSrcOf = (item: WiredFileInfo) => {
        if (keyOf(item) !== sharpKey.value) return displaySrcOf(item);
        return previewUrlOf(item) || displaySrcOf(item);
    };

    /**
     * 预览序列：与网格**同序**的每一条 + 它要显示的图。
     * **一个数组装一对**，不拆成两个平行数组 —— "长度必须相等"是没有任何类型约束的隐式不变量。
     *
     * 谁在序列里：网格里**有图可显示**的条目（图片/ 视频 / 目录）—— 序列必须与网格逐格一致，
     * 否则「定位」对不上（预览里第 12 条 ≠ 网格第 12 格）。
     * 非图片类文件不进序列：预览层能给的只有 `<img>`，而网格里那些用的是字体图标，塞不进 img；
     * 何况它们今天本来也没有"点开"的入口。
     * naive-ui 的上一张/下一张天然跳过空 url，所以它们只是不被翻到。
     */
    const previewEntries = computed(() =>
        fileList.value
            .map(file => ({ file, key: keyOf(file), src: previewSrcOf(file) }))
            .filter(e => !!e.src),
    );

    const previewSrcList = computed(() => previewEntries.value.map(e => e.src));
    /** 当前索引。算不出来（条目没了）= -1 ⇒ 预览层自动关 */
    const previewIndex = computed(() => previewEntries.value.findIndex(e => e.key === previewKey.value));
    /** 正在看的那一条（`{ file, key, src }`） */
    const previewEntry = computed(() => previewEntries.value[previewIndex.value]);
    /** 正在看的那条文件本体（模板与工具条读名字/类型都走它） */
    const previewFile = computed(() => previewEntry.value?.file);
    const previewOpen = computed(() => previewIndex.value >= 0);

    /** 关预览层。`previewOpen` 是派生的，所以"关"就是把 key 清掉 —— 只此一处 */
    const closePreview = () => { previewKey.value = ''; };

    /** naive-ui 的 ✕ / Esc / 点遮罩都会发这个事件 —— 统一落回 closePreview，不各写一遍 */
    const onPreviewShowChange = (v: boolean) => { if (!v) closePreview(); };

    /**
     * `← →` 键或工具条上那两颗箭头：naive-ui 算好新索引后发回来，这里把它**落回 key**。
     * 刻意不存索引 —— 存索引就等于把"列表不变"当成前提了。
     */
    const onPreviewCurrentChange = (i: number) => {
        const e = previewEntries.value[i];
        if (e) previewKey.value = e.key;
    };

    /** 点网格里那张图 = 打开预览层（卡片自己的预览已被 `preview-disabled` 挡住） */
    const openPreview = (item: WiredFileInfo) => {
        if (picking.value) return;
        const e = previewEntries.value.find(x => x.key === keyOf(item));
        if (e) previewKey.value = e.key;
    };

    /**
     * 「定位」：关预览 → 网格滚到那一格 → 描边闪一下。
     *
     * 找格子用 `:data-key` 比对，**不用 CSS 选择器拼字符串** —— 目录名里什么字符都可能有
     * （引号 / 方括号 / 空格），拼选择器迟早炸；dataset 比较不吃这一套。
     * ⚠️ 先关再滚：留着遮罩的话，滚动结果被盖住，等于没定位。
     */
    const locateInGrid = () => {
        const k = previewKey.value;
        const box = imageBox.value;
        if (!k || !box) return;
        const card = Array.from(box.querySelectorAll<HTMLElement>('.image-box-item'))
            .find(el => el.dataset.key === k);
        closePreview();
        if (!card) return;
        locatedKey.value = k;
        card.scrollIntoView({ block: 'center', behavior: 'smooth' });
        window.setTimeout(() => { if (locatedKey.value === k) locatedKey.value = ''; }, 1200);
    };

    /**
     * 「停住 0.3 秒才去换成清晰的那张」。
     *
     * 先 `new Image()` 把它拉进浏览器缓存，再让 `src-list` 换地址 —— 换 src 时 Vue 会重建
     * 那个 `<img>`（naive-ui 给它的 key 就是 src），没预载就会闪一瞬空白。
     * 预载成功才换 ⇒ 无空白的渐进清晰；预载失败就停在缩略图上，不报错、也不留坏状态。
     *
     * ⚠️ 这一档换的是 `/preview` 大图，**不是 `/raw` 原图**：那条路每次都真读一遍移动硬盘，
     * 而且它连一个缓存头都没有 ⇒ 同一张图重复打开也照读。
     */
    let sharpTimer: number | undefined;
    watch(previewKey, () => {
        window.clearTimeout(sharpTimer);
        sharpTimer = undefined;
        sharpKey.value = '';
        const file = previewFile.value;
        if (!file) return;
        // 有得升级才升级：视频 / 离线 / 服务端还没生成过的那种，探测只会拿到 404
        const big = previewUrlOf(file);
        if (!big) return;
        const k = previewKey.value;
        sharpTimer = window.setTimeout(() => {
            const im = new Image();
            im.onload = () => { if (previewKey.value === k) sharpKey.value = k; };
            im.src = big;
        }, 300);
    });

    /** 图标条目**不铺满视口** —— 放大一个文件夹图标没有任何信息增益，只会糊成一片色块 */
    const isIconEntry = computed(() => {
        const f = previewFile.value;
        return !!f && f.type === 'folder' && !f.avatar;
    });

    /**
     * 预览面板里的图按比例**填满视口** —— 打开就是大的，不用再去点工具栏的放大。
     *
     * 为什么需要：预览那张 img 的脚手架样式**只有 `max-width/max-height`、没有 `width/height`**
     * ⇒ 它按**自然尺寸**显示。图片走大图本来就比视口大，看不出问题；但视频的预览图是
     * 480px 宽的抽帧，在 1920 的窗口里就只有一个小方块。
     *
     * ⚠️ 它**必须由调用方 provide 进 `imageContextKey`**：预览层由 `n-image-group` 渲染，
     * 而 naive-ui 没给 group 留 `previewed-img-props` 这个 prop（父链
     * `ImagePreview ← ImageGroup ← 组件`）。不 provide 就会同时丢掉"铺满"和"双击穿透"。
     * 代价与实测数据见 `docs/DESIGN-PREVIEW-BAR-2026-10-04.md` §五、`docs/probes/preview-fill/`。
     */
    const previewedImgProps = computed<ImgHTMLAttributes>(() => ({
        style: isIconEntry.value
            // 图标：原尺寸居中，不放大
            ? { height: '128px', width: 'auto', objectFit: 'contain' as const }
            : { width: '100%', height: '100%', objectFit: 'contain' as const },

        onDblclick: (e: MouseEvent) => {
            // ⚠️ 这里**故意什么都不做**（2026-10-04 业主裁定「双击单击都没有行为」）。
            //
            // 它曾经是「关预览 + 把双击还给下面那张卡片」，为修「多部组成的封面弹不出文件列表」。
            // 但那个设计抢走了双击这个动作：双击预览图会**直接开视频 / 进文件夹**，
            // 而双击图片看细节是所有看图器的既有肌肉记忆（naive-ui 本来就实现了）——
            // **一个动作被两种意图抢，输的那个是用户**。
            //
            // 缩放改走两条不需要抢占的路径（见下面 `previewedImgProps` 外的 `installWheelZoom`）：
            // 工具条的放大/缩小按钮，以及**滚轮**。关预览走 Esc / ✕ / 点图外。
            e.preventDefault();
        },
    }));

    /**
     * 滚轮缩放。**复用 naive-ui 已有的机制，不新增任何缩放实现。**
     *
     * 为什么需要：业主裁定「双击、单击都没有行为」之后，缩放只剩工具条那两颗按钮 ——
     * 而看图时"随手滚一下放大细节"是极强的手势习惯，逼用户去够工具条是倒退。
     *
     * 为什么派发 `ArrowUp` / `ArrowDown` 键而不是自己改 scale：
     *   - 它的 `handleKeydown` 绑在 **document** 上（实测 `ImagePreview.mjs:112`），
     *     且 `ArrowUp→zoomIn` / `ArrowDown→zoomOut`（`:91` / `:95`）**已经接好了**；
     *   - 自己改 scale 就得重写它的 clamp（`0.5 ~ maxScale`）与 offset 回弹逻辑
     *     （`:279-297`）—— 那是它的内部实现细节，不该被复制。
     * ⇒ 派发键事件 =走**它自己的路**，缩放上限、下限、手势一致性全部天然一致。
     *
     * ⚠️ 撤的时候**必须真的摘掉监听**：不撤就是"看不见的全局监听"，
     *    组件没了（或预览关了）还会一直拦滚轮。
     */
    /** 撤销函数；`undefined` = 当前没挂（比一个布尔 flag 少一个能写错的组合） */
    let removeWheelZoom: (() => void) | undefined;
    const installWheelZoom = () => {
        if (removeWheelZoom) return;   // 幂等：重复挂会双倍缩放
        const onWheel = (e: WheelEvent) => {
            // naive-ui 只拦不缩；这里也只在**预览开着**时拦，否则会冻住整个页面的滚动
            if (!previewOpen.value) return;
            e.preventDefault();
            document.dispatchEvent(new KeyboardEvent('keydown', {
                key: e.deltaY < 0 ? 'ArrowUp' : 'ArrowDown',
                bubbles: true,
                cancelable: true,
            }));
        };
        document.addEventListener('wheel', onWheel, { passive: false });
        removeWheelZoom = () => {
            document.removeEventListener('wheel', onWheel);
            removeWheelZoom = undefined;
        };
    };

    /**
     * 滚轮缩放的挂/撤跟着 `previewOpen` 走 —— **一处管两头，不漏任何开关路径**。
     *
     * 为什么不用 `onPreviewShowChange`：那个回调只在**关闭**时被调（`v === false`），
     * 打开时不经过它 ⇒ 只在关的地方挂会漏掉"开"。
     * 为什么不在 `openPreview` 里挂：关有三条路（✕ / Esc / 点遮罩），挂在那儿撤不干净。
     * `watch` 的是**派生状态**，所以"条目没了、索引算成 -1 自动关闭"那条路也一并覆盖。
     *
     * ⚠️ 放在 `installWheelZoom` **定义之后**（TDZ）：`watch` 默认不立即执行，
     * 所以当前顺序即便反过来也"侥幸不炸" —— 但那份侥幸依赖"`installWheelZoom`
     * 在声明时已存在"这个隐含前提，哪天有人加 `immediate: true` 就当场 TDZ。
     * **顺序写成"先定义后使用"，不靠侥幸。**
     */
    watch(previewOpen, open => {
        if (open) installWheelZoom();
        else removeWheelZoom?.();
    });

    // ── 工具条 ────────────────────────────────────────────────────────────────
    // ⚠️ 这里的样式必须**内联**：这块 DOM 由 naive-ui 渲染并 teleport 到 body，
    // 调用方的 `<style scoped>` 够不到它。底板与 wrapper 的样式走组件里那个非 scoped 块。
    const NAME_STYLE = 'margin-right: 10px; max-width: min(46vw, 720px); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;';
    const COUNT_STYLE = 'font-size: 13px; opacity: .55; white-space: nowrap;';
    const GROUP_STYLE = 'display: flex; align-items: center;';
    /** 分左右只用 `margin-left:auto`，不改 naive-ui 的 `justify-content` */
    const GROUP_LEFT = `${GROUP_STYLE} min-width: 0;`;
    const GROUP_RIGHT = `${GROUP_STYLE} margin-left: auto;`;

    /**
     * 左信息（名称 + 计数） · 右操作（全部按钮）。
     *
     * 底板是**贴底通栏**（业主裁定「下方的空间尽可能利用，别浪费」：内容在 2048 宽下只占844px，
     * 两侧各空 602px —— 那是浪费掉的底板，不是留白）。
     * 顺序：定位/上一条/下一条排在按钮组**最左**（「在哪 / 看哪条」一组）与旋转缩放分隔
     * （「把这条图怎么变」另一组）；**✕ 保持最右**（「下载紧邻 ✕ 造成误触」的教训）。
     *
     * **没有把旋转/缩放收进「⋯」**：业主要"方便快捷"，而这个场景每颗都用得上。
     */
    const previewToolbar = ({ nodes }: { nodes: Record<string, any> }) => {
        const total = previewEntries.value.length;
        // 只有一条时"上一条/下一条"是空动作（naive-ui 首尾环绕 = 原地不动）⇒ 不显示，免得像坏了
        const hasNav = total > 1;
        // 定位：准星= "我在这儿"，tooltip 交给 title
        const locate = h(NIcon, {
            size: 28, component: LocateOutline, title: '定位到网格（回车）',
            style: 'padding: 0 8px; cursor: pointer;',
            onClick: locateInGrid,
        });
        return [
            h('span', { style: GROUP_LEFT }, [
                h('span', { style: NAME_STYLE, title: previewFile.value?.name ?? '' },
                    previewFile.value?.name ?? ''),
                ...(hasNav ? [h('span', { style: COUNT_STYLE },
                    `${previewIndex.value + 1} / ${total}`)] : []),
            ]),
            h('span', { style: GROUP_RIGHT }, [
                locate,
                ...(hasNav ? [nodes.prev, nodes.next] : []),
                nodes.rotateCounterclockwise, nodes.rotateClockwise, nodes.resizeToOriginalSize,
                nodes.zoomOut, nodes.zoomIn, nodes.close,
            ]),
        ];
    };

    /**
     * 卸载时收干净：挂起的清晰版计时器 + 滚轮监听。
     * `installWheelZoom` 返回它自己的撤销函数（对称于 `addEventListener`）——
     * **不返回就是"看不见的全局监听"**，组件没了还会一直拦滚轮。
     */
    const dispose = () => {
        window.clearTimeout(sharpTimer);
        removeWheelZoom?.();
    };

    return {
        // 写入口
        openPreview, closePreview, locateInGrid,
        // 状态（供模板与工具条读）
        previewKey, locatedKey,
        previewSrcList, previewIndex, previewOpen, previewFile,
        // naive-ui 事件
        onPreviewShowChange, onPreviewCurrentChange,
        // 工具条
        previewToolbar,
        // 要 provide 进 imageContextKey 的那个
        previewedImgProps,
        /** 挂滚轮缩放。**必须在预览开着时调**，否则滚轮会拦住整个页面 */
        installWheelZoom,
        dispose,
    };
}