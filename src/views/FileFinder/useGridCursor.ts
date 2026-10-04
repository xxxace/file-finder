/**
 * 网格选择器：方向键移动 + 回车确认。
 *
 * ## 它是什么
 *
 * 一个**常驻**的"当前格"高亮。方向键移动它、回车打开它、鼠标单击也落到它。
 * 预览层的「定位」也落到它 —— 所以"看完预览回到网格"之后，键盘不用重新起步。
 *
 * ## 为什么状态只有`cursorKey` 一个
 *
 * 因为**坐标是布局的函数，而布局不是我们能存住的**：
 * 网格列数随窗口宽度变（6/5/3/2/1 列，见 `index.vue` 的 `--item-width` 断点），
 * 同一个 key 在 6 列下是 `(1,1)`、在 3 列下是 `(2,1)`（探针 R7 断言了这件事）。
 * 存坐标就必须跟着窗口宽度同步 —— 那是会漏的同步代码。
 *
 * ⇒ 只存 key，行列结构每次现算（`gridGeometry.ts` 的纯函数 + 一次 DOM 探测）。
 * 同一个手法在`usePreview` 里已经用过一遍（`previewKey` 是唯一真相、索引从它派生）。
 *
 * ## 为什么**不**复用 `usePreview` 的 `previewKey`
 *
 * 因为 `watch(previewKey, scheduleSharpUpgrade)` 会在 key 变化时排一个0.3s 后的
 * `/preview` 请求 —— 那条路会去读移动硬盘上的原图（本项目第一约束）。
 * 方向键每按一次就改一次 `previewKey` ⇒ 每按一次排一次读盘。
 *
 * ⇒ 两个状态、**单向**同步：`previewKey → cursorKey`（在 `openPreview` 与
 * `locateInGrid` 两个口子上），**没有反向**。反向就等于又变回同一个状态。
 * 不同步的唯一合法情形是"预览关着时用方向键" —— 那正是预期行为。
 *
 * ## `fileList` 变了怎么办（切目录 / 刷新 / 搜索）
 *
 * **什么都不做**，判据全部派生：
 * -格子不在当前 `fileList` 里 ⇒ `cursorItem` 算出来是 `undefined` ⇒ 模板不画高亮
 * - 这种"野 key"状态下按方向键 ⇒ `posOf` 返回 null ⇒ 走首次激活，落回视口第一行
 *
 * 写成派生而不是"切目录时清空"，是因为**清空是同步代码**：新增第 6 个导航入口
 * （前进 / 历史 / 多标签）忘了写一行，状态就脱钩了。派生没有这个漏点。
 */
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { isGridKeyBlocked } from '@/utils';
import { firstVisibleKey, groupRows, posOf, stepPos } from './gridGeometry';
import type { CellBox, Dir, Pos } from './gridGeometry';
import type { WiredFileInfo } from '../../../electron/server/index';

type RefLike<T> = { value: T };
type ComputedRefLike<T> = { readonly value: T };

/** 一次探测的产物：行结构 + 每行第一格的 top（`firstVisibleKey` 要用）。 */
interface GridLayout {
    rows: string[][];
    rowTops: number[];
}

export function useGridCursor(deps: {
    /** 当前这一屏的条目（过滤后的视图） */
    fileList: ComputedRefLike<WiredFileInfo[]>;
    /** 条目身份，与网格的 `:key` / `:data-key` / 预览序列同源 */
    keyOf: (item: WiredFileInfo) => string;
    /** 网格滚动容器 */
    imageBox: RefLike<HTMLElement | null>;
    /**
     * 预览层开着没有。**必须是函数**，不能是 `Ref<boolean>`。
     *
     * ## 为什么是函数
     *
     * `usePreview` 与本模块在 `index.vue` 里**互相调用**：
     * 预览层「定位」要走过来（⇒ 本模块要拿 `previewKey`），
     * 打开预览又要同步焦点（⇒ `usePreview` 要拿 `focusCursor`）。
     * 两边都要对方的东西，创建顺序无法自洽。
     *
     * 用**函数**把这件事变成"调用时再求值"：`index.vue` 那边写`() => previewOpen.value`，
     * 它在 setup 顶层执行时 `previewOpen` 可能还没声明，但**按键一定发生在挂载之后** ——
     * 那时早已初始化完毕。写成 `Ref` 则会拿到创建那一刻的快照（恒 `false`），
     * 于是"预览层开着时回车要 bail"这条**静默失效、且没有任何报错**。
     *
     * ⚠️ 顺序即依赖这条纪律在这里的落法：**只有函数参数能合法引用后声明的变量**，
     * 值参数不行（`usePreview` 那边收的是 `Ref`，它自己管声明顺序）。
     */
    isPreviewOpen: () => boolean;
    /**
     * 回车干什么。**语义由调用方决定**，本模块不认识"打开 / 选中"这些词。
     *
     * 为什么要传进来而不是在这里 `if (picking)`：打开的规则（图片走内置、视频走系统、
     * 封面卡弹文件列表…）是**主界面那一层**的知识，把它写进本模块会让这里也背上
     * 一份"什么条目该怎么打开"的判断，而那条规则还在演进。
     */
    onConfirm: (item: WiredFileInfo) => void;
}) {
    const { fileList, keyOf, imageBox, isPreviewOpen, onConfirm } = deps;

    // ── 状态：只有一个真相 ────────────────────────────────────────────────
    /**
     * 当前格（`keyOf` 的值）。空串 = 未激活。
     *
     * ⚠️ 它**不需要**在 `fileList` 变化时被清：模板读的是 `cursorItem`，
     * 野 key 算不出item ⇒ 高亮自动消失（见文件头§「fileList 变了怎么办」）。
     */
    const cursorKey = ref('');

    /** 当前格对应的条目。`undefined` = 这一格不在当前这一屏里（含未激活）⇒ **不画高亮** */
    const cursorItem = computed(() =>
        cursorKey.value ? fileList.value.find(f => keyOf(f) === cursorKey.value) : undefined,
    );
    /**
     * 当前格在这一屏里的下标。-1 = 不在（含未激活）。给"第几个 / 共几个"类文案用。
     *
     * ⚠️ **当前无人使用**（2026-10-04 code review 查出：`grep` 只命中定义与导出）。
     * 我**没有删**它 —— 因为它记录着一个**尚未实现的设计决定**，删掉等于把它静默抹掉：
     *
     * **未决问题**：「换封面」模式下可以选中**多格**，此时 `Enter` 打开的是"**当前这一格**"，
     * 而键盘用户**看不到"第 12 格 / 共 40 格"这类位置反馈**（那类文案目前只存在于预览层工具条）。
     * ⇒ 要不要在网格上给焦点一个位置提示？还没定。
     *
     * 为什么留着无害：它只是一个 computed，**没人读就不产生任何渲染与计算开销**。
     * ⛔ 但**别拿它当"选择器已激活"的判据** —— 真判据是 `cursorKey`（或 `cursorItem` 存在）。
     */
    const cursorIndex = computed(() =>
        cursorKey.value ? fileList.value.findIndex(f => keyOf(f) === cursorKey.value) : -1,
    );

    // ── 定位闪烁：常驻高亮之上的那一下"我在这儿" ────────────────────────────
    /**
     * 刚被"定位"到的那一格，1.2s 后落回常驻态。
     *
     * 为什么要有这一下：定位是**动作**（从预览层飞回网格），而常驻高亮是**状态**。
     * 动作不给反馈，用户会以为"定位没生效"。但状态本身已经够显眼了，
     * 所以只闪**边框色**、不加外发光（否则与高亮自己的发光叠成两圈）。
     */
    const blinkKey = ref('');
    let blinkTimer: number | undefined;
    const cancelBlink = () => {
        window.clearTimeout(blinkTimer);
        blinkTimer = undefined;
    };
    /**
     * 声明在 `focusCursor` **之前**（顺序即依赖）：`focusCursor` 要调它，
     * 而调用它的键盘处理是运行时事件。
     */
    const startBlink = (key: string) => {
        cancelBlink();
        blinkKey.value = key;
        blinkTimer = window.setTimeout(() => {
            // 只有"闪的仍是这一格"才清 —— 连点定位两格时，第一格的计时器不能把第二格的闪停掉
            if (blinkKey.value === key) blinkKey.value = '';
        }, 1200);
    };

    // ── 行列结构：一次 DOM 探测 + 缓存 ───────────────────────────────────
    /**
     * 上一次探测的结果。`null` =还没探过（或已失效）。
     *
     * 缓存的**唯一目的**是省掉同一次按键内的重复探测（探测要读上百个 rect）。
     * 失效点只有两个，都在下面显式写着—— 宁可多探一次，也不能留一个"忘了失效"的雷。
     */
    let layoutCache: GridLayout | null = null;
    /**
     * 让**行结构**失效。`fileList` 变（条目增减 / 换屏）与窗口变宽是仅有的两个原因。
     */
    const invalidateLayout = () => { layoutCache = null; };
    /**
     * 只让 `rowTops` 失效 —— **滚动**时必须做这件事（2026-10-04 code review 抓出）。
     *
     * ⚠️ 缓存里两个量的**生命周期不同**，不能绑在一起：
     * - `rows`（哪一格在第几行第几列）**与滚动无关** ⇒ 滚动时不该重算（白花一次上百个 rect）
     * - `rowTops`（每行的 `getBoundingClientRect().top`）是**视口坐标** ⇒ **滚动就变**
     *
     * 原实现只让整块缓存失效，而失效点只有 `fileList` 与 `resize`（**没有滚动**）
     * ⇒ 滚动后首次按方向键，落点用的是**滚动前**的行位置 ⇒ 选到视口外的行。
     * 而"从子目录返回"正好是"恢复 scrollY 之后立刻可能触发探测"⇒ 两个问题叠加。
     */
    const invalidateRowTops = () => { if (layoutCache) layoutCache.rowTops = []; };

    /**
     * 探测当前网格的行结构。
     *
     * ⚠️ **为什么用 `getBoundingClientRect().top` 而不是 `offsetTop`**：
     * `offsetTop` 是相对 **`offsetParent`** 的，而 `.image-box-item` 自己带
     * `position: relative`（`index.vue` 的 `.image-box-item` 块）⇒ 它的 `offsetParent`
     * 是自己，读出来的 `offsetTop` 恒为 0。用rect 拿的是**视口坐标**，
     * 一视同仁、且与任何祖先的定位方式无关。
     *
     * 顺序：模板里 `v-for` 直接铺 `fileList`，flex `row wrap` **保持 DOM 顺序**
     * ⇒ 探测顺序就是视觉顺序（从上到下、从左到右），不需要额外排序。
     *
     * 不需要等图片加载：格子高度被 `height: var(--item-height) !important` 钉死
     * ⇒ 懒加载的图没到也不会改变行高。
     */
    const probeLayout = (): GridLayout => {
        // `rowTops` 空 ⇒ 滚动把它作废了（见 invalidateRowTops）⇒ 必须重新探测
        if (layoutCache && layoutCache.rowTops.length) return layoutCache;
        const box = imageBox.value;
        if (!box) return { rows: [], rowTops: [] };

        const cells: CellBox[] = [];
        for (const el of Array.from(box.querySelectorAll<HTMLElement>('.image-box-item'))) {
            const key = el.dataset.key;
            if (!key) continue;                // 没有 data-key 的不是条目格（防御性，模板保证了）
            cells.push({ key, top: el.getBoundingClientRect().top });
        }
        const rows = groupRows(cells);
        // 每行第一格的 top：`firstVisibleKey` 判"这行在不在视口内"要用，
        // 重新算一遍 rect 是不必要的（同批元素，取该行首个即可）
        const rowTops = rows.map((r, i) => cells.find(c => c.key === r[0]!)?.top ?? Number.NaN);
        layoutCache = { rows, rowTops };
        return layoutCache;
    };

    /**
     * 窗口变宽变窄 ⇒ 列数变了（6/5/3/2/1）⇒ 缓存作废。
     *
     * 必须挂，也**必须摘**（`dispose`）—— 本项目已经因为全局监听没摘被坑过两次
     * （见 `usePreview` 的 `installWheelZoom` 与 `onViewportResize`）。
     */
    const onWindowResize = () => invalidateLayout();

    /**
     * 滚动宿主的**缓存引用**。
     * `dispose` 时 `imageBox.value` 可能已经是 `null`（组件卸载），那时再取就抓不到
     * 那个元素 ⇒ 监听摘不掉 ⇒ 残留的全局监听会继续让缓存失效（不是致命，但违反
     * "不返回就是看不见的全局监听"这条纪律）。
     */
    let scrollHost: HTMLElement | null = null;

    // ── 移动 ──────────────────────────────────────────────────────────────
    /**
     * 滚到指定那一格，让它进入视口。
     *
     * `block: 'nearest'` 而不是 `'center'`：`center` 会让**每按一次方向键都把目标
     * 顶到屏幕正中**，连按 5 下画面就在猛跳。`nearest` 只在它真的看不见时才滚，
     * 看得见就一动不动。
     */
    const scrollIntoViewIfNeeded = (key: string) => {
        const el = imageBox.value?.querySelector<HTMLElement>(
            `.image-box-item[data-key="${CSS.escape(key)}"]`,
        );
        // ⚠️ 用 `CSS.escape` 而不是拼选择器：目录名里什么字符都可能有（引号 / 方括号 / 空格），
        // 拼出来迟早炸。同款处理见 `usePreview.locateInGrid`（那里用 dataset 比对，
        // 因为它要拿的是**已知存在**的格子；这里每次移动都可能遇到特殊字符，逃不掉）。
        el?.scrollIntoView({ block: 'nearest' });
    };

    /**
     * 把选择器落到 `key`，滚进视口，可选闪一下。
     *
     * **这是"定位"的唯一实现**：`usePreview.locateInGrid` 也调它，
     * 所以"从预览层飞回来"和"用方向键走过去"走的是**同一条路** ——
     * 两个入口的行为差异被结构性地消掉了。
     */
    const focusCursor = (key: string, opts: { blink?: boolean; scroll?: boolean } = {}) => {
        if (!key) return;
        cursorKey.value = key;
        if (opts.scroll !== false) scrollIntoViewIfNeeded(key);
        if (opts.blink) startBlink(key);
    };

    /**
     * 首次激活：落在**视口内最靠上那一行**的第一格。
     *
     * ⚠️ 不能取 `rows[0][0]`：`onBack` 会恢复这一屏的 `scrollY` ⇒
     * 从子目录返回时屏幕可能停在中间，落第一行等于放到屏幕外（按了方向键却什么都没看见）。
     */
    const activateCursor = () => {
        const { rows, rowTops } = probeLayout();
        if (!rows.length) return;
        const box = imageBox.value;
        // ⚠️ `viewBottom` 与 `rowTops` **必须同一坐标系** —— 两者都取自
        // `getBoundingClientRect()`（视口坐标），所以直接比大小即可成立。
        // 这里**不用 `offsetTop`**：`focusCursor` 要的是"哪一行在用户眼前"，
        // 那是视口坐标的问题，不是文档坐标的问题（用 offsetTop 就得再换算scrollTop，多一处易错）。
        // 容器量不到（还没挂上 / 被隐藏）⇒ 用 `Infinity` ⇒ `top < Infinity` 恒真
        // ⇒ 落回第一行第一格。**这正是想要的兜底**（宁可落在屏幕外，也不能毫无反应）。
        const r = box ? box.getBoundingClientRect() : null;
        // ⚠️ **两个边界都要给**（`viewTop` 是2026-10-04 code review 补上的）：
        // 只给下界时，屏幕停在中间（onBack 恢复 scrollY 之后）会选出**屏幕上方**
        // 看不见的那一行，然后 `scrollIntoView` 把视口猛拉到最顶。
        // 容器量不到 ⇒ 退成 `[-Inf, +Inf]`（与可视区相交）⇒ 由函数末尾的兜底处理。
        const viewTop = r ? r.top : Number.NEGATIVE_INFINITY;
        const viewBottom = r ? r.bottom : Number.POSITIVE_INFINITY;
        focusCursor(firstVisibleKey(rows, rowTops, viewTop, viewBottom));
    };

    /**
     * 方向键走一格。
     *
     * 三种情形一次处理完，不需要调用方分支：
     * - 未激活 /野 key（`posOf` 给null）⇒ 先激活到视口第一行
     * - 正常⇒ 走一格，到边界停住（`stepPos` 内部管）
     * - 网格是空的⇒ 什么都不做（不抢事件、不报错）
     */
    const moveCursor = (dir: Dir) => {
        const { rows } = probeLayout();
        // ⚠️ **先置意图、再判空**（业主 2026-10-04 报"加载时方向键失焦"）：
        // 加载中按方向键，这一行之后会 `return`（格子还没渲染）⇒ 若在这里不置位，
        // "这一屏需要焦点"这个信息就丢了，加载完成后**没有任何东西重新激活**。
        // ⇒ 置位必须在 return **之前**。
        noteIntent();
        if (!rows.length) return;
        const at = posOf(rows, cursorKey.value);
        if (!at) {
            activateCursor();
            return;
        }
        const next: Pos = stepPos(rows, at, dir);
        // 走一格（而不是停住）才 focus：停住时不必重滚，也免得抖一下
        if (next.r !== at.r || next.c !== at.c) focusCursor(rows[next.r]![next.c]!);
    };

    // ── 键盘 ──────────────────────────────────────────────────────────────
    const DIR_KEYS: Record<string, Dir> = {
        ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
    };

    /**
     * 网格的keydown。**只有方向键与回车**。
     *
     * 为什么是 **keydown** 而不是 keyup：长按方向键要能连续移动，
     * 那是 keydown 的自动重复（`event.repeat`）提供的，keyup 做不到。
     * 现有的 `S` / `D` / `F5` / `Backspace` 仍走 `index.vue` 的 keyup ——
     * 两种事件不互相吃掉（那条已记录在 `index.vue` 的 `onKeyup` 注释里）。
     *
     * ##⚠️ 方向键要 repeat，**回车绝对不能**
     *
     * 键盘的自动重复对两类键的意义完全相反：
     * - **方向键**：长按 = 连续移动，**正是我们要的**
     * - **回车**：长按 = **重复执行同一个动作**。实测（无头 Chromium）
     *   按住回车 1 秒 = **33 次 keydown，其中 32 次带 `e.repeat === true`**
     *   ⇒ 不挡就是"一次长按打开 33 次"。
     *
     * 而回车触发的每个动作都不便宜（`onConfirm` 一路走下去）：
     * 目录 → 压栈 + 重新取数；视频/文件 → 一次 IPC 开外部程序；
     * 图片 → 重排清晰版计时器（**可能真去读移动硬盘**，见 `scheduleSharpUpgrade`）。
     * ⇒ 挡在**动作之前**（`onConfirm` 之前），不是靠"打开的文件太多"去补救。
     *
     * 这一条与 Windows / macOS 的行为一致（按住 Enter 不等于重复执行）。
     * `index.vue` 的定位回车（keyup 侧）同样要挡，否则长按回车会反复"定位"。
     */
    const onGridKeydown = (e: KeyboardEvent) => {
        if (e.key === 'Enter') {
            if (isPreviewOpen()) return;              // ← 见上：预览层接管回车
            // ⚠️⚠️ **守卫必须在这里也调一次**（2026-10-04 code review 抓出，阻断级）。
            // 我原先只在方向键分支调，于是**焦点在搜索框里按回车会打开当前选中格**；
            // 中文输入法选词（IME 上屏）同样触发 ⇒ 打中文时按回车会随机打开文件。
            // 根因：naive-ui `Input.mjs:578` 的 `handleWrapperKeydown` 只
            // `call(props.onKeydown, e)`（我们没绑）**不 stopPropagation**
            // ⇒ 事件照常冒泡到 window；而下面那句 `e.preventDefault()`
            // 还会顺手吞掉输入框自己的回车行为，让症状更隐蔽。
            if (isGridKeyBlocked(e)) return;
            if (e.repeat) return;                      // ★ 长按只算一次，见上
            const item = cursorItem.value;
            if (!item) return;                        // 没选中就别抢（免得吞掉别人的回车）
            e.preventDefault();
            onConfirm(item);
            return;
        }
        const dir = DIR_KEYS[e.key];
        if (!dir) return;                             // 其余按键一律不碰
        if (isGridKeyBlocked(e)) return;              // 焦点在会吃方向键的控件上 ⇒ 键归它
        if (isPreviewOpen()) return;                  // 预览层开着：← → 翻页 / ↑ ↓ 缩放都是它的
        e.preventDefault();                           // 别让方向键滚页面
        moveCursor(dir);
    };

    // ── 生命周期 ──────────────────────────────────────────────────────────
    onMounted(() => {
        window.addEventListener('keydown', onGridKeydown);
        window.addEventListener('resize', onWindowResize);
        // ⚠️ 滚动只作废 `rowTops`（视口坐标），`rows` 仍有效 —— 见 invalidateRowTops 的注释
        scrollHost = imageBox.value;
        scrollHost?.addEventListener('scroll', invalidateRowTops, { passive: true });
    });

    /**
     * 卸载时摘干净。**两个监听都必须摘** ——
     * 留着就是"看不见的全局监听"：组件没了还在拦方向键（新页面的键盘就失灵了）。
     * 与 `usePreview.dispose` 同一条纪律。
     */
    const dispose = () => {
        window.removeEventListener('keydown', onGridKeydown);
        window.removeEventListener('resize', onWindowResize);
        // ⚠️ 这个监听挂在 `imageBox` 上（不是 window）⇒ 摘的必须是**同一个元素**。
        // `imageBox.value` 若在卸载时已变成 null，就抓不到那个元素了 ⇒ 缓存引用。
        scrollHost?.removeEventListener('scroll', invalidateRowTops);
        cancelBlink();
    };

    // ⚠️ 注册 `onUnmounted` **必须**写在 setup 顶层。写在 `onMounted` 回调内部的那个
    // 永远不会被调用（本次生命周期早过了注册窗口）—— `index.vue` 已因同一处漏网
    // 被坑过一次（它的 `onKeyup` 监听），这里不重复那个错。
    onUnmounted(dispose);

    // 列表变了 ⇒ 行结构作废（同一个 key 的坐标可能变了；条目增减也改变了行数）
    watch(() => fileList.value, invalidateLayout);

    /**
     * **这一屏刚加载完、之前等着焦点的人现在有地方站了** ⇒ 重新激活。
     *
     * ## 为什么要专门做这一步（业主 2026-10-04 真机报"加载时方向键失焦"）
     *
     * 加载一屏的过程中按方向键，`moveCursor` 会因为 `probeLayout()` 返回空
     * （格子还没渲染）而**直接返回** —— 那一刻确实什么也做不了，这是对的。
     * 但**加载完成之后没有任何东西重新激活**，于是：
     * 用户在 A 屏焦点在第 7 格 → 回车进 B 屏 → B 屏加载完 → **选择器没了**。
     * 他必须点一下网格才有焦点。
     *
     * ⚠️ 这里**不是**"把旧key 恢复回来"（那属于每屏记忆，是 `NavEntry` 的活），
     * 而是"**新的一屏该有一个初始焦点**" —— 否则键盘用户在新屏上是**完全失能**的：
     * 他按方向键会激活，但那得先知道"要按方向键"；而屏幕上一点提示都没有。
     *
     * 判据：只在"之前有人**正在这一屏等焦点**"时才激活（`armed`）——
     * 否则冷启动 / 纯鼠标浏览会被莫名其妙地画一个焦点框。
     * `armed` 由**移动意图**置位（按过方向键、或点过某格），加载完成后用一次即清。
     */
    let armed = false;
    /** 移动意图：键盘或鼠标都算"用户在这一屏需要焦点"。 */
    const noteIntent = () => { armed = true; };
    const takeIntent = () => { const had = armed; armed = false; return had; };

    /**
     * 列表换了一屏 ⇒ 若之前有人要焦点，现在给他。
     *
     * ## ⚠️ 判据为什么是「key 集合变了」而不是「长度从 0 变有」（业主 2026-10-04 二次报）
     *
     * 第一版写的是 `watch(() => fileList.value.length, (len, prev) => len > 0 && prev === 0)`，
     * 看着像"一屏刚加载出来"。**它永远不成立** ——
     * `dataSource` 是**整份替换**的（`fetchFolder` 成功后 `dataSource.value = data`），
     * 加载期间**旧数据一直留在屏幕上**（那是刻意的：失败时列表不能被清空，见 `fetchFolder` 的注释）。
     * ⇒ 进新屏时 `prev` 是**旧屏的条目数**（比如 8），不是 0 ⇒ 条件恒假 ⇒ **永远不落焦点**。
     * 这就是"我加了初始化默认选中，还是要点一下"的根因（第一版那处`armed` 机制是对的，
     * 只是**没人调用**它 —— 判据不成立）。
     *
     * ## 现在的判据：比较「key 集合」
     *
     * "换了一屏"的**事实**是"屏幕上这些条目已经不是同一批了"⇒ 比 key。
     * - 换目录：key 全变（`keyOf` 含 `dir`）⇒ 触发
     * - 刷新/重扫：key 不变⇒ **不触发**（用户在等它，不能把焦点从他手上抢走）
     * - 搜索：key 变（筛掉了几个）⇒ 触发，但那种情况选择器多半还在屏内，`activateCursor` 幂等
     *
     * ⚠️ 用**第一个 key + 长度**做指纹就够了，不必每次都建全量Set：
     * 判据是"变了没有"，不是"变了几个"；而目录切换时第一个 key 必变（它带 `dir`）。
     */
    const listFingerprint = () => {
        const l = fileList.value;
        return l.length ? `${l.length}:${keyOf(l[0]!)}` : '';
    };

    watch(listFingerprint, (fp) => {
        // 空列表（加载中 / 空目录 / 请求失败）⇒ 不落，那不是"一屏内容"
        if (!fp || !takeIntent()) return;
        // ⚠️ `nextTick` 是必需的：此刻 DOM 还是**旧屏的格子**（`dataSource` 已换但未渲染），
        // 直接激活会量到旧布局的行高⇒ 焦点落到一个算错的位置上。
        void nextTick(activateCursor);
    });

    return {
        // 状态（供模板读）
        cursorKey, cursorItem, cursorIndex, blinkKey,
        // 写入口（**全部**只改`cursorKey`，没有别的副作用）
        /** 鼠标单击卡片 / 定位 / 首次激活：落焦点 + 滚进视口（+ 可选闪一下） */
        focusCursor: (key: string, opts?: { blink?: boolean; scroll?: boolean }) => {
            noteIntent();
            focusCursor(key, opts);
        },
        /**
         * 只把 `cursorKey` 写成给定值：**不滚动、不闪烁**。
         *
         * 两个用途：
         * ① `usePreview` 打开 / 翻页时同步（此刻遮罩盖着，滚了也看不见）
         * ② **每屏记忆的恢复**（`index.vue` 的 `onBack`）—— 与 `scrollY` 一起恢复，
         *    两者必须**分别**恢复：滚动用 `scrollTo`、焦点用本函数。
         *
         * ⚠️ 恢复**不算"移动意图"**：那是在把用户放回他离开时站的地方，
         * 不该再叠加一次"新屏初始焦点"（否则会跳到第一行，把刚恢复的位置覆盖掉）。
         */
        setCursorKey: (key: string) => { cursorKey.value = key; },
        /**
         * 声明"用户在这一屏需要焦点"。
         *
         * 由 `index.vue` 在**离开一屏**时调（`rememberCurrentScreen`）——
         * 那一刻还没进新屏，但用户显然是在用键盘/鼠标浏览 ⇒ 新屏加载完该给他焦点。
         * ⚠️ 为什么不放在 `moveCursor` 里自动置位：加载中按方向键那一次会被
         * `probeLayout()` 判空直接返回，**置位发生在返回之前**才有意义，
         * 而那条路径已经return 了 ⇒ 只能由调用方在**动作发生前**声明。
         */
        noteIntent: () => { armed = true; },
        dispose,
    };
}
