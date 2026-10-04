/**
 * 预览层：上一条 / 下一条 + 定位到网格 + 缩略图渐进升级。
 *
 * ## 为什么是composable 而不是子组件
 *
 * 子组件（`PreviewLayer.vue`）需要双向 props + 事件来回传（`previewKey` 改回去、
 * `fileList` 传进来、`picking` 传进来……），而预览层要读网格里的真实 DOM
 * （`document.querySelector('.n-image-preview')` 量图、`'.n-image-preview-wrapper'`
 * 量可视区）—— 那些 DOM 由 naive-ui teleport 到 body、在父组件的模板之外，
 * 子组件拿不到，只能靠 ref 层层传，**props 链会比现在更长**。
 * composable 的边界正好落在"状态与计算"上，DOM 那一侧留少量查询进来即可。
 *
 * ## 契约：参数进、状态出，**不反向写参数**
 *
 * 入参全是 `Ref` / `ComputedRef`（只读用）与两个**回调**（`onLocate` / `syncCursor`），
 * 返回的 `openPreview` / `closePreview` / `locateInGrid` 是全部写入口。
 *
 * `previewKey`（"正在看哪一条"）是唯一真相，索引 / 显示哪张图 / 有没有升级成清晰版
 * 全部从它派生。列表一变（刷新 / 盘插拔 / 换目录 / 搜索），**不可能**留下"索引指向了
 * 别的条目"这种脱钩状态：条目没了 ⇒ 索引算出来是 -1 ⇒ 预览层自己关掉，**不需要任何同步代码**。
 *
 * ⚠️ **唯一的例外是"开不开"**：它不能从 `previewKey` 派生，必须是独立状态 ——
 * 关闭时 `previewKey` 是**故意留着**的，否则淡出动画期间 naive-ui 会拿到
 * `src=undefined`，屏幕上出现一个没有 src 的 `<img>`。见 `previewOpenState` 的完整注释。
 *
 * ## 与网格选择器的关系（2026-10-04）
 *
 * 网格选择器住在 `useGridCursor` 那边，本模块**不持有**它，只在三个口子上
 * **单向**同步过去（见 `syncCursor` / `onLocate` 的注释）。刻意不共用同一个状态：
 * `watch(previewKey)` 挂着"停住就升级清晰版"，那会去读移动硬盘上的原图 ——
 * 方向键每按一次就改一次 `previewKey` 的话，每按一次排一次读盘（第一约束）。
 *
 * 同族手法：`currentPath → crumbs`、`dataSource + searchText → fileList`、
 * `cursorKey → 行结构`（`useGridCursor`）。
 */
import { computed, h, nextTick, onMounted, ref, watch } from 'vue';
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
    /**
     * 「定位」时把网格选择器落到某一条。由 `useGridCursor.focusCursor` 提供。
     *
     * ## 为什么是注入而不是本模块自己改
     *
     * 选择器状态住在 `useGridCursor` 那边（它还管方向键移动）。若本模块直接写
     * `cursorKey`，就出现**两个状态、两个写入口** —— 那正是"预览和网格高亮对不上"的来源。
     * 只留一个写入口（`focusCursor`）之后，两条路（定位 / 方向键）天然一致。
     */
    onLocate: (key: string) => void;
    /**
     * 把 `previewKey` 同步给网格选择器。**只同步，不滚动、不闪烁。**
     * 由 `useGridCursor` 提供（它持有 `cursorKey`）。
     *
     * 调用的三个口子（也就是 `previewKey → cursorKey` 单向同步的**全部**出口）：
     * ① `openPreview` —— 打开预览
     * ② `onPreviewCurrentChange` —— 预览里 `← →` 翻页
     * ③ （定位那条走`onLocate`，因为它还要滚动 + 闪烁）
     *
     * ⚠️ 键盘 `Enter` 打开预览时**没有鼠标事件** ⇒ 单击图片那条"卡片 `@click`
     * 顺带移了选择器"的自动生效路径（`Image.mjs:99-101` 不阻止冒泡）在键盘下不存在
     * ⇒ 必须在这里显式同步，否则"打开预览后按 ←"会从错误的位置开始翻。
     */
    syncCursor: (key: string) => void;
}) {
    const { fileList, keyOf, displaySrcOf, previewUrlOf, picking, onLocate, syncCursor } = deps;

    // ── 状态 ────────────────────────────────────────────────────────────────
    /** 正在看哪一条（`keyOf` 的值）。空串 = 没在看。**唯一真相**：索引、图、清晰版全从它派生。 */
    const previewKey = ref('');
    /** 已经升级成清晰版的那一条。空串 = 没有 */
    const sharpKey = ref('');
    // ⚠️ `locatedKey` 已移走：定位高亮与它的闪烁现在归`useGridCursor` 管。
    // 两个模块各留一份"哪一格在闪"就是两个写入口 ⇒ 高亮迟早对不上（见 deps 的 onLocate）。

    /**
     * 「停住就升级成大图」的待办计时器。
     *
     * ⚠️ 声明放在 `closePreview` **之前**（顺序即依赖，不靠侥幸）：关闭时要掐它，
     * 而关闭的时机是运行时事件，理论上哪天有人在本文件里加一句"声明时就调一次
     * closePreview"就会当场 TDZ。这个文件已经吃过一次这种亏（见 installWheelZoom）。
     */
    let sharpTimer: number | undefined;
    /**
     * 掐掉上面那个待办计时器。
     *
     * ⚠️ 关闭时**必须**调它：`/preview` 可能要去读移动硬盘上的原图（见 `previewUrlOf`），
     * 而计时器是在**关闭之前**就排好的 —— 不掐掉的话"打开后马上关掉"仍会发出那个请求，
     * 白读一次盘。这是"少读移动硬盘"（第一约束）直接相关的一条。
     *
     * 为什么不靠 `watch(previewKey)` 顺带清：关闭时 `previewKey` **故意不变**
     * （见 `closePreview`），那个 watcher 根本不会触发。
     */
    const cancelSharpTimer = () => {
        window.clearTimeout(sharpTimer);
        sharpTimer = undefined;
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
     *
     * ⚠️ 声明在 `openPreview` **之前**（顺序即依赖）：`openPreview` 要调它。
     *
     * 抽成函数而不是只写在 `watch` 里：关闭时 `previewKey` **故意不变**（见 `closePreview`），
     * 所以"**重新打开同一条**"不会触发那个 watcher ⇒ 只靠 watcher 的话，重开一张图永远
     * 停在糊图上（那个 0.3s 计时器在关闭时已被掐掉）。`openPreview` 必须自己再排一次。
     */
    const scheduleSharpUpgrade = () => {
        cancelSharpTimer();
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
    };

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
    /**
     * 预览层开着没有。**独立状态，不是从 `previewKey` 派生的**。
     *
     * ⚠️ 为什么必须独立（2026-10-04 修的真缺陷，静态读不出来、只有真机看得见）：
     * 关闭时若把 `previewKey` 清掉，`previewIndex` 就变 -1 ⇒ `:current="-1"` ⇒
     * naive-ui `ImageGroup.mjs:78,83` 算出 `currentId=undefined` ⇒ `currentUrl=undefined`
     * ⇒ `ImagePreview.mjs:561` 的 `src` 变 undefined ⇒ **`<img src=undefined>`**。
     * 而淡出动画期间 `:564` 的 `vShow` 还让这个 `<img>` 留在场（naive-ui 用 `displayed`
     * 专门留了这段窗口，见 `ImagePreview.mjs:496`）⇒ 浏览器给无 src 的 img 画那个
     * 「图片图标 + 空白透明边框」，被用户看到。
     *
     * ⇒ 判据：**「关」只该改「开不开」，不该毁掉「开着时是第几条」** —— 后者在
     * 淡出动画结束前仍是有效输入。
     *
     * 仍保留派生：**条目真没了（换目录/搜索/盘拔了）⇒ 索引算成 -1 ⇒ 自动关**，
     * 不靠任何同步代码（见本文件头部契约）。所以它是「开着 **且** 看得见」。
     */
    const previewOpenState = ref(false);
    const previewOpen = computed(() => previewOpenState.value && previewIndex.value >= 0);

    /**
     * 关预览层。**只翻开关，不清 `previewKey`** —— 淡出动画那 0.2s 里 naive-ui 还要
     * 照着 `previewKey` 把图算出来（见 `previewOpenState` 那段）。
     *
     * 上次看的那条会留在 `previewKey` 里，这是**有意的**：它是"重新打开时看第几条"
     * 的依据；`previewOpen` 已经是 false，不会因此露出任何东西。
     */
    const closePreview = () => {
        previewOpenState.value = false;
        // 已经排好的"升级大图"要掐掉：那个请求可能要读移动硬盘上的原图，
        // 预览都关了还去读就是白读（见 cancelSharpTimer 的注释）。
        cancelSharpTimer();
    };

    /** naive-ui 的 ✕ / Esc / 点遮罩都会发这个事件 —— 统一落回 closePreview，不各写一遍 */
    const onPreviewShowChange = (v: boolean) => { if (v) previewOpenState.value = true; else closePreview(); };

    /**
     * `← →` 键或工具条上那两颗箭头：naive-ui 算好新索引后发回来，这里把它**落回 key**。
     * 刻意不存索引 —— 存索引就等于把"列表不变"当成前提了。
     *
     * ⚠️ 这里也同步网格选择器：预览层里 `← →` 翻的**就是网格那一条**（同一个序列），
     * 不同步的话"翻到第 12 张、按回车定位"会落回第 1 格 —— 用户以为在定位刚看的那张。
     * 这是 `previewKey → cursorKey` 单向同步的**第三个也是最后一个**口子。
     */
    const onPreviewCurrentChange = (i: number) => {
        const e = previewEntries.value[i];
        if (e) {
            previewKey.value = e.key;
            // 只同步选择器，**不滚动、不闪**：此刻遮罩还盖着，滚了也看不见。
            // 滚动是「定位」那一刻的事（`locateInGrid` → `focusCursor({scroll, blink})`）。
            syncCursor(e.key);
        }
    };

    /**
     * 点网格里那张图 = 打开预览层（卡片自己的预览已被 `preview-disabled` 挡住）。
     *
     * ⚠️ 这里同步网格选择器，是为了覆盖**键盘打开**那条路：鼠标单击图片时，
     * 卡片的 `@click` 会顺带把选择器移过去（冒泡到卡片，`Image.mjs:99-101` 不阻止），
     * 但 `Enter` 打开时**没有鼠标事件** ⇒ 那条自动生效的路径不存在。
     * 在这里补上，两个入口就都齐了。
     */
    const openPreview = (item: WiredFileInfo) => {
        if (picking.value) return;
        const e = previewEntries.value.find(x => x.key === keyOf(item));
        if (!e) return;
        previewKey.value = e.key;
        syncCursor(e.key);
        // 开关在这里翻，而不是靠"key 从空变成有值"派生 —— 关的时候 key 是**故意留着**的
        previewOpenState.value = true;
        // 同一条重开也要重新排升级：`watch(previewKey)` 只在 key **变化**时跑，而重开同一条
        // key 没变（见 scheduleSharpUpgrade 的注释）
        scheduleSharpUpgrade();
    };

    /**
     * 「定位」：关预览 → 把网格的选择器落到那一格（滚进视口 + 闪一下）。
     *
     * ## 为什么"找格子 + 滚动"搬走了
     *
     * 那是**选择器的本职**（`useGridCursor.focusCursor`）。留在这里会出现两个
     * 各自能滚动的出口（这里一个、方向键移动一个），迟早有一处忘了更新高亮。
     * 搬走之后"定位"和"用方向键走过去"走的是**同一条路**。
     *
     * ⚠️ 预览层开着时 `← / →` 是 naive-ui 自己监听的 keydown（`ImagePreview.mjs:78-100`），
     * 它每次翻页都会回填 `previewKey` ⇒ 关掉预览时 `previewKey` 已是"最后看的那一条"
     * ⇒ 定位落点是**当前正在看的那条**，不是打开时那条。这是现有行为，不改。
     */
    const locateInGrid = () => {
        const k = previewKey.value;
        // ⚠️ 先关再定位：留着遮罩的话，滚动结果被盖住，等于没定位。
        // `closePreview` **不清** `previewKey`（见它的注释），所以这里还读得到。
        closePreview();
        if (k) onLocate(k);
    };

    watch(previewKey, scheduleSharpUpgrade);

    /** 图标条目**不铺满视口** —— 放大一个文件夹图标没有任何信息增益，只会糊成一片色块 */
    const isIconEntry = computed(() => {
        const f = previewFile.value;
        return !!f && f.type === 'folder' && !f.avatar;
    });

    /**
     * 可视区（wrapper 的**内容盒**）尺寸，单位 px。
     *
     * 为什么不是 `window.innerWidth/Height`：wrapper 被 `index.vue` 加了
     * 读不出来时返回 0 ⇒ 调用方回落到「不设尺寸」那条路。
     */
    const readViewportBox = () => {
        const el = document.querySelector<HTMLElement>('.n-image-preview-wrapper');
        if (!el) return { w: 0, h: 0 };
        // ⚠️ **必须自己减 padding**：`clientWidth/Height` 给的是**含 padding 的外框**
        //（实测 1602×903，而真可视区 = 903−16−64 = 823）。拿外框算 ⇒ 图撑出内容盒、比例也歪。
        const cs = getComputedStyle(el);
        const px = (v: string) => parseFloat(v) || 0;
        return {
            w: el.clientWidth - px(cs.paddingLeft) - px(cs.paddingRight),
            h: el.clientHeight - px(cs.paddingTop) - px(cs.paddingBottom),
        };
    };

    /**
     * 按 `contain` 规则算出「图在可视区内能占的最大尺寸」。
     *
     * ⚠️ 不用 `object-fit:contain` 让浏览器算：它把黑边放在**元素盒子内**，而盒子就是
     * `<img>` 自己 ⇒ 那圈黑边仍会吃掉点击，「点图外关闭」又坏。必须让盒子精确贴合图像。
     *
     * 返回 null = 算不出来（还没打开/ 还没量到）⇒ 调用方不写尺寸，交回原尺寸。宁可小不要错。
     */
    const fitToViewport = (natW: number, natH: number) => {
        if (!(natW > 0 && natH > 0)) return null;
        const { w: boxW, h: boxH } = readViewportBox();
        if (!(boxW > 0 && boxH > 0)) return null;
        // 取小的比例 ⇒ 必然装得下（业主要的「不能超过」），且至少一边贴边（「占满」）
        const scale = Math.min(boxW / natW, boxH / natH);
        return { w: Math.round(natW * scale), h: Math.round(natH * scale) };
    };

    /**
     * 当前显示的那张 `<img>` 的自然尺寸，**连同它属于哪一条**。
     *
     * 必须是响应式：尺寸只在图**加载完之后**才有值，而 computed 求值那刻通常还没加载完
     * ⇒ 自己读 DOM 只会算一次、永远停在「量不到」那支。用 ref 由 load 事件**推**进去。
     *
     * ⚠️ 连「哪一条」一起存，是因为它才是判断「能不能沿用旧值」的唯一可靠依据（见
     * `watchPreviewImgLoad`）。`naturalWidth` 在没加载完时是 0 ⇒ 那一刻**比不出比例**。
     */
    const previewImgNatural = ref<{ key: string; w: number; h: number } | null>(null);

    /**
     * 图 load 之后把自然尺寸喂进响应式状态。
     *
     * 挂 `<img>` 的 `load`（不用 ResizeObserver/轮询）：`key=src` ⇒ 换图就是新元素、
     * 新 load 事件，挂一次只对这一张图有效。
     *
     * ⚠️ **没加载完那一瞬要不要沿用旧值，判据是「是不是同一条」**（2026-10-04 修跳动）：
     * 换 src 后新 `<img>` 要一帧才`naturalWidth > 0`，那之前：
     *   · **同一条**（缩略图 → 大图这档升级）⇒ 沿用。同一张源图 ⇒ 撑满后的目标尺寸
     *     **本来就一样** ⇒ 沿用零副作用，而画面**不跳**。不沿用的话 `previewedImgProps`
     *     会掉回「`max-width` + `auto`」那一档、图缩回原始尺寸，大图加载完再撑满 ⇒ 肉眼看到一次跳动。
     *   · **换了一条**（← → 翻页）⇒ 必须清掉，否则新图会先按**上一条的尺寸**显示一瞬
     *     （歪、比例错），比跳动更难看。
     */
    const watchPreviewImgLoad = () => {
        const el = document.querySelector<HTMLImageElement>('.n-image-preview');
        if (!el) return;
        const key = previewKey.value;
        const feed = () => {
            if (el.naturalWidth) {
                previewImgNatural.value = { key, w: el.naturalWidth, h: el.naturalHeight };
                return;
            }
            // 还没加载完 ⇒ **只有同一条**才沿用（见上）
            previewImgNatural.value = previewImgNatural.value?.key === key
                ? previewImgNatural.value
                : null;
        };
        feed();
        // 已缓存完成的图不会再触发 load ⇒ 上面 feed 一次就够；
        // 未完成的走 load 事件。两者都要，因为缓存状态事先不可知。
        if (!el.complete) el.addEventListener('load', feed, { once: true });
    };
    /** 视口/面板尺寸变了要重量一次 —— 可视区变了，同一张图的「占满」尺寸也变了。 */
    const onViewportResize = () => { if (previewOpen.value) watchPreviewImgLoad(); };

    /**
     * 预览图**按可视区最大化**：尽量占满（已扣掉底部工具条那一条），四周留出可点空白。
     *
     * **占满可视区、又不超、且图外可点** —— 三条同时成立。
     *
     * ⚠️ 两条不能碰的机制：
     * ① **不能用 `width/height:100%`**：关闭的唯一入口是 overlay 的 `onClick`
     *   （`ImagePreview.mjs:510`），官方靠 wrapper 的 `pointer-events:none`
     *   （`styles/index.cssr.mjs:45`）让点击穿到它；而图是 `pointer-events:all`（`:52`），
     *   图元素一旦铺满就把 overlay 盖死。缩小也救不了（黑边在盒内 + 缩放下限 0.5，`:291`）。
     * ② **不能用 `transform: scale()` 放大**：`max-*` 只缩小不放大，而 transform 那段是
     *   naive-ui 自己的，`derivePreviewStyle` 每次缩放/拖动都重写整个 `style.cssText`
     *   （`:317`）⇒ 我写的会被当场抹掉；它算好的比例只在 `resizeToOrignalImageSize()`（`:332`）
     *   里用，而那个方法没对外暴露（`exposedMethods` 只有 `setThumbnailEl`）。
     *
     * ⇒ 办法：把尺寸写成 `width/height`。同一个 `cssText` 里它与 transform 是**叠加**的
     *（`:314` 先写我的、`:316` 再追加它的）⇒ 我只管"图该占多大"，缩放/拖动/旋转全归它。
     * 尺寸 = `contain` 公式取较小者 ⇒ 必然不超、且至少一边贴边；而盒子精确贴合图像
     * ⇒ 盒外那圈是 wrapper 空白（`pointer-events:none`）⇒ 穿透到 overlay 能关。
     */
    const previewedImgProps = computed<ImgHTMLAttributes>(() => {
        // 图标条目：原尺寸居中，不放大（放大图标没有信息增益，只会糊成色块）
        if (isIconEntry.value) {
            return { style: { height: '128px', width: 'auto', objectFit: 'contain' as const } };
        }
        // ⚠️ `key` 必须与当前条目一致才用它的尺寸 —— 换条目后那值是**上一张**的
        // （见 watchPreviewImgLoad：不同条时会清空，这里是第二道保险）。
        const nat = previewImgNatural.value?.key === previewKey.value
            ? previewImgNatural.value
            : null;
        const fitted = nat ? fitToViewport(nat.w, nat.h) : null;
        return {
            style: fitted
                ? { width: `${fitted.w}px`, height: `${fitted.h}px`, objectFit: 'contain' as const }
                // ⚠️ **回退档也必须撑满**（`height:100%` 而不是 `auto`）：冷启动时
                // `previewImgNatural` 还是 null（应用刚启动、没打开过任何图），
                // 若这里回 `auto` ⇒ 图按**原尺寸**显示，一帧后才撑满 ⇒ **肉眼看到
                // 「先小后大」**（业主真机报的就是这个；第二次打开不复现，因为那时
                // 已经有量好的尺寸、压根不走这条回退档）。
                // `max-*` 兜住别超出可视区。`width:auto` + `height:100%` ⇒ 竖图贴满高、
                // 横图则由 `max-width` 收着⇒ 两个方向都不超。
                : { maxWidth: '100%', maxHeight: '100%', width: 'auto', height: '100%', objectFit: 'contain' as const },
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
        };
    });

    /**
     * 「显示哪张图」变了就重量一次。
     *
     * 挂 `previewSrcList`（=显示中那张图 src 的**唯一产出点**）而不是分别挂到
     * 「打开/换条目/升级大图」三个动作 ⇒ 三条路径收在一处，将来加第四条也不会漏。
     * `nextTick`：src 变了 DOM 要下一帧才更新完，那时才查得到新 `<img>`。
     */
    watch(previewSrcList, () => { if (previewOpen.value) nextTick(watchPreviewImgLoad); });

    /** 视口变了要重量 —— 可视区变了，同一张图的「占满」尺寸也变了。 */
    onMounted(() => window.addEventListener('resize', onViewportResize));

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
     * 卸载时收干净：挂起的清晰版计时器 + 滚轮监听 + resize 监听。
     * `installWheelZoom` 返回它自己的撤销函数（对称于 `addEventListener`）——
     * **不返回就是"看不见的全局监听"**，组件没了还会一直拦滚轮。
     */
    const dispose = () => {
        cancelSharpTimer();
        removeWheelZoom?.();
        // 与上面同一条纪律：全局监听不摘就是"看不见的残留"
        window.removeEventListener('resize', onViewportResize);
    };

    return {
        // 写入口
        openPreview, closePreview, locateInGrid,
        // 状态（供模板与工具条读）
        previewKey,
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