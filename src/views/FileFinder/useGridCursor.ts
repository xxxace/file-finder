/**
 * 网格选择器：方向键移动 + 回车确认 + 空格看预览。
 *
 * ## 它是什么
 *
 * 一个**常驻**的"当前格"高亮。方向键移动它、回车打开它、鼠标单击也落到它。
 * 预览层的「定位」也落到它 —— 所以"看完预览回到网格"之后，键盘不用重新起步。
 *
 * ## 为什么状态只有`cursorKey` 一个
 *
 * 因为**坐标是布局的函数，而布局不是我们能存住的**：
 * 网格的列数可选（6 / 8 / 12，见 `density.ts`），但**坐标仍然不存**：位置是布局的函数 ——
 * 搜索过滤后的残行、窗口尺寸变化都会让同一个 key 落在不同行列
 *（旧版 6/5/3/2/1 断点下更明显：同一个 key 在 6 列是 `(1,1)`、3 列是 `(2,1)`，探针 R7 断言过）。
 * 存坐标就得跟着这些同步 —— 那是会漏的同步代码。
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
     * 本页是否在前台。**可选**，但路由化之后必须传：组件被 `KeepAlive` 缓存后
     * `window` 上的 keydown 监听不会摘 ⇒ 在别的页按方向键/回车会操作**看不见的网格**
     * （甚至打开文件）。与 `isPreviewOpen` 同一条"函数而非 Ref"的理由。
     */
    isActive?: () => boolean;
    /**
     * 回车干什么。**语义由调用方决定**，本模块不认识"打开 / 选中"这些词。
     *
     * 为什么要传进来而不是在这里 `if (picking)`：打开的规则（图片走内置、视频走系统、
     * 封面卡弹文件列表…）是**主界面那一层**的知识，把它写进本模块会让这里也背上
     * 一份"什么条目该怎么打开"的判断，而那条规则还在演进。
     */
    onConfirm: (item: WiredFileInfo) => void;
    /**
     * 空格干什么：**看一眼**（开内置预览），不打开这一格代表的东西。
     *
     * 为什么不能并进 `onConfirm`：同一个格子上两者结论**不同** ——
     * 封面卡按 `Enter` 是"打开里面的片子"，按空格是"看封面大图"（鼠标点封面那个行为）。
     * 合成一个入口就必然出现"想看一眼，结果把片子打开了"。
     *
     * ⚠️ 调用方必须传**箭头函数**（`(i) => openPreview(i)`），不能传裸引用：
     * `openPreview` 在 `index.vue` 里声明在本模块**之后**（它要用本模块的 `focusCursor`）
     * ⇒ 裸引用会在 setup 期间 TDZ 报错。与 `isPreviewOpen` 只能收函数是同一条理由。
     */
    onPreview: (item: WiredFileInfo) => void;
    /**
     * 网格当前的列数（密度档位派生出来的那个数）。
     *
     * ## 为什么要传进来（这是**正确性**，不是优化）
     *
     * 列数变 ⇒ 每行装几个变 ⇒ 同一个 key 的行列坐标变 ⇒ `layoutCache.rows` 整块作废。
     * 而缓存原本只有两个失效源：`fileList` 变、`window resize`。
     * 切密度档位**两个都不触发**（只改一个 CSS 变量）⇒ 缓存里留着旧列数的行结构
     * ⇒ 切到紧凑档后第一次按 →，会按 6 列的行去跳（撞边界 / 横跳一格），
     * 与 2026-10-04 那次"前几行正常、第 4 行起全错"是同一族的症状。
     *
     * ⚠️ **不在调用方（切档回调里）手动调失效**：那样新增第二个切档入口
     * （快捷键 / 菜单项）就会忘。失效由本模块订阅，结构上不可能漏。
     * 可选参数：不传 = 行为与加这个功能之前完全一致。
     */
    cols?: ComputedRefLike<number>;
}) {
    const { fileList, keyOf, imageBox, isPreviewOpen, isActive, onConfirm, onPreview, cols } = deps;

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

    // ── 定位闪烁：⛔ 已整条移除（业主 2026-10-04 六次报"丑死了"）─────────────────
    //
    // 原来这里有 `blinkKey` + `startBlink` + 1.2s 计时器：定位那一格闪一下**橙色边框**，
    // 理由是"定位是动作、常驻高亮是状态，动作不给反馈用户会以为没生效"。
    //
    // ⚠️⚠️ **实测它与焦点框叠在一起**（主人截图：同一个格子上蓝框 + 橙框同时在）
    // ⇒ **两套焦点语言叠成双框**，这才是"丑"的来源。
    // 而它想解决的那个问题（"以为没生效"）**本就不存在**：
    // 定位后焦点框**本来就落在那一格**、而且网格只有 1px 细框 + 淡蓝灰底 ——
    // "焦点在哪"已经一目了然，不需要第二个颜色来重复说一遍。
    //
    // ⇒ 结论：**动作反馈 ≠ 加第二种状态色**。真要强化，用 `scale` 那一下抬起
    //   （`transition` 里已有）就够了，不该另开一套配色。
    // ⇒ 整条链路（状态 / 计时器 / `opts.blink` / 模板 class / CSS）一并删掉，
    //   不留"暂时不用但留着以防万一"的残件。

    // ── 行列结构：一次 DOM 探测 + 缓存 ───────────────────────────────────
    /**
     * 上一次探测的结果。`null` =还没探过（或已失效）。
     *
     * 缓存的**唯一目的**是省掉同一次按键内的重复探测（探测要读上百个 `offsetTop`）。
     * 失效点在下面显式写着—— 宁可多探一次，也不能留一个"忘了失效"的雷。
     */
    let layoutCache: GridLayout | null = null;
    /**
     * 让**整块**缓存失效。
     *
     * `fileList` 变（条目增减 / 换屏）与窗口变宽是仅有的两个原因。
     */
    const invalidateLayout = () => { layoutCache = null; };
    /**
     * 只让 `rowTops` 失效 —— **滚动**时必须做这件事。
     *
     * ⚠️ 缓存里两个量的**生命周期不同**，不能绑在一起：
     * - `rows`（哪一格在第几行第几列）**与滚动无关** ⇒ 滚动时不该重算
     * - `rowTops`（每行的 `getBoundingClientRect().top`）是**视口坐标** ⇒ **滚动就变**
     *
     * 原实现只让整块缓存失效，而失效点只有 `fileList` 与 `resize`（**没有滚动**）
     * ⇒ 滚动后首次按方向键，落点用的是**滚动前**的行位置 ⇒ 选到视口外的行。
     * 而"从子目录返回"正好是"恢复 scrollY 之后立刻可能触发探测"⇒ 两个问题叠加。
     */
    const invalidateRowTops = () => { if (layoutCache) layoutCache.rowTops = []; };

    /**
     * 探测当前网格的行结构。
     * ⚠️ 分行用 offsetTop 不用 rect.top：焦点格 scale(1.012) 会抬高 top 被判成单独一行 ⇒ 方向键行列错位；判"行在不在视口"(rowTops) 才用 rect.top（视口坐标随滚动变）。依据 docs/probes/cursor-scale-row、docs/ANALYSIS-arrow-key-misalign-2026-10-04.md。
     * 不需要等图片加载：格子高度固定（封面按 `--ff-cover-ratio` 定比例 + 标题固定占两行）
     * ⇒ 懒加载的图没到也不会改变行高（实测图片到达前后 `offsetTop` 漂移 **0.000px**）。
     */
    const probeLayout = (): GridLayout => {
        // `rowTops` 空 ⇒ 滚动把它作废了（见 invalidateRowTops）⇒ 必须重新探测。
        // ⚠️ 重新探测会**连`rows` 一起重算**（它们在同一个对象里）——
        //    修复前这正是"滚动一次就永久变脏"的机制；换成 `offsetTop` 后重算也不再产生脏数据。
        if (layoutCache && layoutCache.rowTops.length) return layoutCache;
        const box = imageBox.value;
        if (!box) return { rows: [], rowTops: [] };

        // 第一趟只读 `offsetTop`（分行用；同一容器内可比，且不建对象）
        const cells: CellBox[] = [];
        const elByKey = new Map<string, HTMLElement>();
        for (const el of Array.from(box.querySelectorAll<HTMLElement>('.image-box-item'))) {
            const key = el.dataset.key;
            if (!key) continue;                // 没有 data-key 的不是条目格（防御性，模板保证了）
            cells.push({ key, rowTop: el.offsetTop });
            elByKey.set(key, el);
        }
        const rows = groupRows(cells);
        // 第二趟只对**每行第一格**读视口坐标 —— `firstVisibleKey` 只用得到这些值。
        // ⚠️ 原来对全部格子逐个 `getBoundingClientRect()`（每个调用都新建一个 DOMRect），
        //    而滚动后重算时这一趟正是大头，其中 531 个结果从头到尾没人用。
        const rowTops = rows.map(r => elByKey.get(r[0]!)?.getBoundingClientRect().top ?? Number.NaN);
        layoutCache = { rows, rowTops };
        return layoutCache;
    };

    /**
     * 窗口变宽变窄 ⇒ 格子尺寸与换行位置都会变 ⇒ 缓存的布局作废。
     * （列数不变时也一样：行高变了，`rowTops` 就不是那批值了。）
     * ⚠️ 密度**档位**变化不走这里（没有 resize 事件），由 `deps.cols` 的 watch 管。
     *
     * 必须挂，也**必须摘**（`dispose`）—— 本项目已经因为全局监听没摘被坑过两次
     * （见 `usePreview` 的 `installWheelZoom` 与 `onViewportResize`）。
     */
    const onWindowResize = () => {
        invalidateLayout();
        // 窗口一变，光标格可能已经被挤出视口 —— 布局稳定后把它滚回来
        scheduleEnsureVisible();
    };

    /**
     * 滚动宿主的**缓存引用**。
     * `dispose` 时 `imageBox.value` 可能已经是 `null`（组件卸载），那时再取就抓不到
     * 那个元素 ⇒ 监听摘不掉 ⇒ 残留的全局监听会继续让缓存失效（不是致命，但违反
     * "不返回就是看不见的全局监听"这条纪律）。
     */
    let scrollHost: HTMLElement | null = null;

    // ── 移动 ──────────────────────────────────────────────────────────────
    /**
     * 系统偏好：减少动效时一律不做平滑滚动（原生 `behavior: 'smooth'` **不会**自动降级）。
     * 每次现读，不缓存 —— 用户可能在系统设置里中途改。
     */
    const prefersReducedMotion = () =>
        window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

    /**
     * 滚到指定那一格，让它进入视口。
     *
     * `block: 'nearest'` 而不是 `'center'`：`center` 会让**每按一次方向键都把目标
     * 顶到屏幕正中**，连按 5 下画面就在猛跳。`nearest` 只在它真的看不见时才滚，
     * 看得见就一动不动。
     *
     * ## ⚠️⚠️ 但 `nearest` 有个盲区，必须补（业主 2026-10-04 真机报）
     *
     * `nearest` 的判据是"**这个元素**看得见吗"⇒ 焦点在**首行第一格**时它已可见
     * ⇒ **不滚** ⇒ 滚动条永远停在中间；
     * 同理焦点在**末行**时也永远够不到底。
     * 业主原话：「到第一行和最后一行都不会到顶和到底（滚动条），体验不好」。
     *
     * ⚠️ 这不是"要不要加一点余量"的问题，而是**两个不同的问题**：
     * - `nearest` 解决的是"**焦点这一格**别跑出视口" ⇒ 保留
     * - "**首行要滚到顶、末行要滚到底**"是**视口对齐**问题 ⇒ 单独补
     *
     * ⇒ 判据：**落点已经在首行（`r === 0`）⇒ 直接滚到顶；在末行 ⇒ 滚到底**。
     * 只在这两种情况下强制对齐，中间行仍然交给 `nearest`（不动画面）。
     * 零横轴滚动条 ⇒ 纵向对齐就是全部（不用管 `inline`）。
     *
     * ---
     * 滚进视口。
     *
     * @param smooth 只有**单次按键**才给 `true`（见 `moveCursor` 的调用点）。
     *        长按必须瞬时 —— 实测（`docs/probes/scroll-smooth/`）：每 60ms 追加一格时，
     *        平滑滚动每一步的落后从 150px 一路涨到 **636px**，追加结束后 600ms 还停
     *        在 714/1200 ⇒ **光标会被滚出视口**，而瞬时版每一步落后都是 0。
     *        单次按键平滑一格 ≈ **210ms**、四格 ≈ 415ms（原生按距离给时长，同一次跑出来的数）。
     *
     * ⚠️ 用原生 `behavior: 'smooth'`，**不是**自己在 rAF 里写 `scrollTop`：
     * ① 长按/换层的同一帧里 `probeLayout` 要对几百个格子读 `offsetTop`，把滚动也塞进我们的
     *    rAF 等于在最忙的那一帧再加一份写入；原生滚动跑在 Blink 自己的滚动动画里，不抢这份预算。
     * ② `scrollIntoView` 会替我们处理 `scroll-margin-block`（格子外面那 6px 环让位）。
     * ③ 中途被下一次滚动打断时，原生是"从当前位置改目标"，不需要我们写重入逻辑。
     *
     * ⚠️ 绝不用 CSS `scroll-behavior: smooth` 兜全局：那会让 `onBack` 的 `scrollTo(恢复 scrollY)`
     * 和 `enterScreen` 的 `scrollTo(0,0)` 一起变成动画，而它们后面的"回读确认"是**当帧**读的
     * ⇒ 会读到动画中间值。只在这一个函数里逐次传参。
     */
    const scrollIntoViewIfNeeded = (key: string, smooth = false) => {
        const box = imageBox.value;
        const el = box?.querySelector<HTMLElement>(
            `.image-box-item[data-key="${CSS.escape(key)}"]`,
        );
        if (!box || !el) return;
        // ⚠️ 用 `CSS.escape` 而不是拼选择器：目录名里什么字符都可能有（引号 / 方括号 / 空格），
        // 拼出来迟早炸。同款处理见 `usePreview.locateInGrid`（那里用 dataset 比对，
        // 因为它要拿的是**已知存在**的格子；这里每次移动都可能遇到特殊字符，逃不掉）。
        const behavior: ScrollBehavior = smooth && !prefersReducedMotion() ? 'smooth' : 'auto';
        el.scrollIntoView({ block: 'nearest', behavior });

        // 纵向对齐：首行⇒ 顶、末行 ⇒ 底。中间行不做（画面不该乱跳）。
        // ⚠️ 这两句会**覆盖**上面那次 `scrollIntoView`，所以 behavior 必须一起传 ——
        // 否则平滑刚起步就被一句瞬时赋值掐掉，单次按键等于没平滑。
        const rows = probeLayout().rows;
        const at = posOf(rows, key);
        if (!at) return;
        if (at.r === 0) box.scrollTo({ top: 0, behavior });
        else if (at.r === rows.length - 1) box.scrollTo({ top: box.scrollHeight, behavior });
    };

    /**
     * 把选择器落到 `key`，滚进视口，可选闪一下。
     *
     * **这是"定位"的唯一实现**：`usePreview.locateInGrid` 也调它，
     * 所以"从预览层飞回来"和"用方向键走过去"走的是**同一条路** ——
     * 两个入口的行为差异被结构性地消掉了。
     */
    /**
     * 布局变了（窗口缩放 / 切密度档）之后，把光标格重新滚回视口。
     *
     * 为什么需要：光标位置只记在 `cursorKey` 里，它在文档里的坐标是**布局的产物** ——
     * 窗口一缩、或列数一变，那一格可能已经被挤出视口，而**没有任何事件会提醒它**。
     *
     * 为什么防抖 150ms：`resize` 是 60Hz 的连续事件，每次都滚会互相打架；
     * 150ms 也够布局稳定下来，让下面的 `probeLayout` 只重算一次。
     */
    let ensureVisibleTimer = 0;
    const scheduleEnsureVisible = () => {
        window.clearTimeout(ensureVisibleTimer);
        ensureVisibleTimer = window.setTimeout(() => {
            const k = cursorKey.value;
            if (k) scrollIntoViewIfNeeded(k);
        }, 150);
    };

    const focusCursor = (key: string, opts: { scroll?: boolean; smooth?: boolean } = {}) => {
        if (!key) return;
        cursorKey.value = key;
        if (opts.scroll !== false) scrollIntoViewIfNeeded(key, opts.smooth === true);
    };

    /**
     * 首次激活：落在**视口内最靠上那一行**的第一格。
     *
     * ⚠️ 不能取 `rows[0][0]`：`onBack` 会恢复这一屏的 `scrollY` ⇒
     * 从子目录返回时屏幕可能停在中间，落第一行等于放到屏幕外（按了方向键却什么都没看见）。
     *
     * ## ⚠️⚠️ 这里**必须不滚动**（业主 2026-10-04 五次报"按返回没恢复 scroll 位置"）
     *
     * 原来这里是 `focusCursor(key)` —— 默认 `scroll: true` ⇒ 会调 `scrollIntoViewIfNeeded`
     * ⇒ **把视口滚走**。
     *
     * ⛔ 而它跑在**比 `onBack` 的 `scrollTo` 更晚一拍**的位置上：
     * ```
     * onBack: setCursorKey → await fetchFolder → nextTick → scrollTo(恢复到 to.scrollY)
     *                ↓（watch 是 pre flush，此刻排队）
     *         watch 触发 → void nextTick(activateCursor)      ← ★晚一拍
     *                ↓
     *         activateCursor → focusCursor → scrollIntoView  ← ★把恢复值覆盖掉
     * ```
     * ⇒ 症状：**滚动位置"恢复了一点但不对"**（`scrollTo` 的值被 `scrollIntoView` 顶掉）。
     *
     * ## 为什么"不滚动"在三个调用点上全都安全
     *
     * `activateCursor` 只有三个入口，**每一个的视口都已经就位**：
     * ① 首次按方向键：`cursorKey` 为空 ⇒ 用户还没滚动过
     * ② 新屏加载完：`enterScreen` 已把视口**归零**（`imageBox.scrollTo(0,0)`）
     * ③ `onBack` 恢复的 key 不在新屏 ⇒ 视口刚被 `onBack` **恢复**到 `to.scrollY`
     *
     * 而 `firstVisibleKey` 的定义本身就是"**视口里**最靠上那一行"
     * ⇒ 落点按定义就在视口内 ⇒ **不需要滚**。
     *
     * ⇒ 这是**职责分离**：**视口归导航层（`enterScreen` / `onBack`）管，焦点归本模块管。**
     * 一个动作只做一件事，两边都不越界 —— 不是加条件绕过症状。
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
        // 看不见的那一行—— 那时**更不能滚**（滚了就把恢复好的视口顶掉）。
        // 容器量不到 ⇒ 退成 `[-Inf, +Inf]`（与可视区相交）⇒ 由函数末尾的兜底处理。
        const viewTop = r ? r.top : Number.NEGATIVE_INFINITY;
        const viewBottom = r ? r.bottom : Number.POSITIVE_INFINITY;
        // ⚠️⚠️ **`scroll: false`** —— 见上文"这里必须不滚动"的整段推导
        focusCursor(firstVisibleKey(rows, rowTops, viewTop, viewBottom), { scroll: false });
    };

    /**
     * 方向键走一格。
     *
     * 三种情形一次处理完，不需要调用方分支：
     * - 未激活 /野 key（`posOf` 给null）⇒ 先激活到视口第一行
     * - 正常⇒ 走一格，到边界停住（`stepPos` 内部管）
     * - 网格是空的⇒ 什么都不做（不抢事件、不报错）
     */
    const moveCursor = (dir: Dir, smooth = false) => {
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
        // ⚠️ `smooth` 只对**单次按键**为真（见下面的 keydown）：长按必须瞬时，理由在
        //    `scrollIntoViewIfNeeded` 的注释里（实测落后 636px，光标会被滚出视口）。
        if (next.r !== at.r || next.c !== at.c) focusCursor(rows[next.r]![next.c]!, { smooth });
    };

    // ── 键盘 ──────────────────────────────────────────────────────────────
    const DIR_KEYS: Record<string, Dir> = {
        ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
    };

    /**
     * 长按连续移动的最小间隔（≈16 格/秒）。**单次按键不受影响** —— 只有 `e.repeat` 才节流。
     *
     * 为什么需要：光标每走一格都可能要重算行结构（滚动一次 `rowTops` 就作废，
     * 而重算要对**每个格子**各做一次 `offsetTop` + `getBoundingClientRect`）。
     * 30Hz 的长按速率下，光标一到视口边缘（每格都触发滚动 ⇒ 每格都重算）就发涩。
     * 60ms 给每次重算留够预算，同时仍比人手连点快。
     */
    const MOVE_REPEAT_MIN_MS = 60;
    let lastMoveAt = 0;

    /**
     * 网格的 keydown：只接方向键、回车与空格。
     * ⚠️ 用 keydown 不用 keyup（长按连续移动靠 event.repeat）；S / D / F5 / Backspace 仍走 index.vue 的 keyup，两种事件不互相吃。
     * ⚠️ 回车必须挡 e.repeat 且在 onConfirm 之前（长按 = 重复执行取数 / IPC 等动作）；index.vue 定位回车（keyup 侧）同样要挡。
     */
    const onGridKeydown = (e: KeyboardEvent) => {
        // 本页在后台（被 KeepAlive 缓存）⇒ 一个键都不接
        if (isActive && !isActive()) return;
        if (e.key === 'Enter') {
            if (isPreviewOpen()) return;              // ← 见上：预览层接管回车
            // ⚠️ Enter 分支也必须调 isGridKeyBlocked：否则焦点在搜索框、IME 上屏时按回车会打开当前选中格（事件冒泡到 window）。
            if (isGridKeyBlocked(e)) return;
            if (e.repeat) return;                      // ★ 长按只算一次，见上
            const item = cursorItem.value;
            if (!item) return;                        // 没选中就别抢（免得吞掉别人的回车）
            e.preventDefault();
            onConfirm(item);
            return;
        }
        /**
         * 空格 = **看一眼**（= 鼠标点封面），不打开这一格代表的文件。
         * 与 `Enter` 是两条路：封面卡按回车会去播片，按空格才看到封面大图。
         *
         * ⚠️ 焦点停在工具条按钮上时，空格可能连带激活那个按钮（按钮的 Space 在 keyup
         * 触发，`preventDefault` 未必拦得住）—— 与"Enter 已被网格接管"同一类取舍，**未实测**。
         */
        if (e.key === ' ') {
            if (isPreviewOpen()) return;              // 已经开着：不再"开"一次（免得重排升级计时器）
            if (isGridKeyBlocked(e)) return;          // 焦点在搜索框 ⇒ 空格是打字
            if (e.repeat) return;                     // 长按只算一次，纪律同 Enter
            const item = cursorItem.value;
            if (!item) return;
            e.preventDefault();                       // 别让空格滚页面
            onPreview(item);
            return;
        }
        const dir = DIR_KEYS[e.key];
        if (!dir) return;                             // 其余按键一律不碰
        /**
         * ⚠️ 带 Alt 的方向键**不是网格导航**（2026-11-10 双向导航）：
         * `Alt+←/→` 是后退 / 前进，由 `index.vue` 的 keyup 接手。
         * 不加这条守卫的后果不是"少移动一格"，而是**两个动作都发生** ——
         * keydown 里 `preventDefault` 挡不住 keyup ⇒ 选择器动一格 + 整屏跳走，
         * 而屏换掉之后那"一格"已经没人看得见了（最难查的那种）。
         */
        if (e.altKey) return;
        if (isGridKeyBlocked(e)) return;              // 焦点在会吃方向键的控件上 ⇒ 键归它
        if (isPreviewOpen()) return;                  // 预览层开着：← → 翻页 / ↑ ↓ 缩放都是它的
        e.preventDefault();                           // 别让方向键滚页面
        // 只拦长按重复：单击必须零延迟（这是"跟手"的底线）
        if (e.repeat) {
            const now = performance.now();
            if (now - lastMoveAt < MOVE_REPEAT_MIN_MS) return;
            lastMoveAt = now;
        }
        // 平滑只给单次按键：`e.repeat` = 正在长按 ⇒ 每 60ms 一格，平滑会追不上（实测见
        // `scrollIntoViewIfNeeded`）。这条判据和上面那条节流用的是**同一个事实**，
        // 所以放在一起：它们描述的是"这一次移动是不是人手点的一下"。
        moveCursor(dir, !e.repeat);
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
        window.clearTimeout(ensureVisibleTimer);
        window.removeEventListener('keydown', onGridKeydown);
        window.removeEventListener('resize', onWindowResize);
        // ⚠️ 这个监听挂在 `imageBox` 上（不是 window）⇒ 摘的必须是**同一个元素**。
        // `imageBox.value` 若在卸载时已变成 null，就抓不到那个元素了 ⇒ 缓存引用。
        scrollHost?.removeEventListener('scroll', invalidateRowTops);
    };

    // ⚠️ 注册 `onUnmounted` **必须**写在 setup 顶层。写在 `onMounted` 回调内部的那个
    // 永远不会被调用（本次生命周期早过了注册窗口）—— `index.vue` 已因同一处漏网
    // 被坑过一次（它的 `onKeyup` 监听），这里不重复那个错。
    onUnmounted(dispose);

    // 列表变了 ⇒ 行结构作废（同一个 key 的坐标可能变了；条目增减也改变了行数）
    watch(() => fileList.value, invalidateLayout);

    // 列数变了 ⇒ 行结构必然变 ⇒ 整块作废。与上面那条并列，理由见 deps.cols 的注释。
    // 切密度档同理：列数变 ⇒ 每行装几个变 ⇒ 除了失效缓存，还要把光标滚回视口
    if (cols) watch(cols, () => { invalidateLayout(); scheduleEnsureVisible(); });

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
     * ⚠️ 判据用「key 集合变了」，不能用「长度 0→有」：dataSource 整份替换、加载期间旧数据仍在 ⇒ prev 永远不是 0 ⇒ 永不落焦点。
     * ⚠️ 用第一个 key + 长度做指纹即可（目录切换首 key 带 dir 必变）；刷新/重扫 key 不变 ⇒ 不抢用户焦点。
     */
    const listFingerprint = () => {
        const l = fileList.value;
        return l.length ? `${l.length}:${keyOf(l[0]!)}` : '';
    };

    watch(listFingerprint, (fp) => {
        // 空列表（加载中 / 空目录 / 请求失败）⇒ 不落，那不是"一屏内容"
        if (!fp || !takeIntent()) return;
        /**
         * ⚠️⚠️ **已经有有效焦点时不许覆盖**（2026-10-04 业主真机报"进子目录再回来，焦点回到第一个"）。
         *
         * `onBack` 会先 `setCursorKey(to.cursorKey)` 恢复这一屏的记忆，
         * 而恢复出来的 key **若在这一屏里**，它就是**正确的焦点位置**。
         * ⚠️ 但 `setCursorKey` 写在 `fetchFolder` **之前** —— 那一刻 `dataSource` 还是**旧屏**，
         * ⇒ `cursorItem` 是 `undefined`（派生判据，key 在旧屏里找不到），
         * ⇒ 等新屏数据到位、这个 watch 触发时，**必须重新看一眼**"key 现在在不在这一屏里"。
         *
         * ⇒ 判据：**`cursorItem` 存在 ⇒ 有人已经站好了，别动它**。
         * 那个"落视口第一行"只该服务于**真的没有焦点**的情况
         * （冷启动、刚点过目录、恢复的 key 不在这一屏里）。
         */
        if (cursorItem.value) return;
        // ⚠️ `nextTick` 是必需的：此刻 DOM 还是**旧屏的格子**（`dataSource` 已换但未渲染），
        // 直接激活会量到旧布局的行高 ⇒ 焦点落到一个算错的位置上。
        void nextTick(activateCursor);
    });

    return {
        // 状态（供模板读）
        cursorKey, cursorItem, cursorIndex,
        // 写入口（**全部**只改`cursorKey`，没有别的副作用）
        /** 鼠标单击卡片 / 定位 / 首次激活：落焦点 + 滚进视口（+ 可选闪一下） */
        focusCursor: (key: string, opts?: { scroll?: boolean; smooth?: boolean }) => {
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
         * 由 `index.vue` 的 `enterScreen` / `goStep` 在**换屏动作之前**调 ——
         * 那一刻还没进新屏，但用户显然是在用键盘/鼠标浏览 ⇒ 新屏加载完该给他焦点。
         * ⚠️ 为什么不放在 `moveCursor` 里自动置位：加载中按方向键那一次会被
         * `probeLayout()` 判空直接返回，**置位发生在返回之前**才有意义，
         * 而那条路径已经return 了 ⇒ 只能由调用方在**动作发生前**声明。
         */
        noteIntent: () => { armed = true; },
        dispose,
    };
}
