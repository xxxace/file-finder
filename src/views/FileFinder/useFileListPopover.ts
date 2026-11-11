/**
 * 「这个封面下有哪几个文件」弹层 —— 状态、定位、键盘、音效。
 *
 * 与页面只通过 `deps` 交换数据（同 `usePreview` / `useContextMenu`）。
 * ⚠️ 它与"打开"咬合：`openFile` 要靠 `popover.cover` 算父目录 —— 别在这里改这个语义。
 *
 * ## 这一层为什么是**纵向菜单**而不是卡片网格（2026-11-11 重构）
 *
 * 它本质上是从 2~5 个近似项里挑一个的**短列表**，不是一个内容网格。原来照网格卡做的
 * 150×116 卡片有三个硬伤：系统大图标（Windows 紫色立体方块）与全站"封面图/扁平线条图标"
 * 两套语言；名字居中折行、大小被 `margin-top:auto` 推到 116px 之外（判断依据被拆散）；
 * 横排的 ←→ 与网格方向键同键不同义，4 个以上换行后 ←→ 还会跨行。
 * 现在照 `ctx-menu.css`（右键菜单，Apple PC 尺度）来做：行高 32、图标 16、名字左对齐。
 */
import { computed, nextTick, ref } from 'vue';
import type { FileInfoFiles, WiredFileInfo } from '../../../electron/server/index';
import type { CardLike, DirCard } from './openDecision';
import { splitFileName } from './fileNameSplit';
import { compareFileName } from './fileNameSort';
import { playSfx } from '@/utils/sfx';

export interface FileListPopoverDeps {
    /** 只有多文件封面才弹这一层。
     *  ⚠️ 必须保留**类型谓词**：`item.files` 的可空性靠它收窄，写成 `=> boolean`
     *  就得在下面补 `?? []` —— 那是把判据抄第二遍。 */
    isMultiFileCard: (item: CardLike) => item is DirCard;
    /** 打开其中一个文件（传文件名；父目录由页面按 `popover.cover` 算） */
    openFile: (name: string) => void;
}

/** 一行要显示的全部东西 —— 模板里零计算（`splitFileName` 只在这里跑一次）。 */
export interface FileRow extends FileInfoFiles {
    /** 可被省略号截断的前半段 */
    head: string;
    /** 扩展名 + 前 3 个字符，永不被截断 */
    tail: string;
}

export function useFileListPopover(deps: FileListPopoverDeps) {
    const popover = ref<{
        visible: boolean;
        x: number;
        y: number;
        files: FileInfoFiles[];
        /** 打开的那张封面卡。**`openFile` 靠它算父目录** —— 别在这里改语义 */
        cover: WiredFileInfo | undefined;
    }>({
        visible: false,
        x: 0,
        y: 0,
        files: [],
        cover: undefined,
    });

    /**
     * 展示用的行（名字已切成 head/tail）。
     * 派生而不是在 `openFileList` 里提前算：`files` 是**服务端下发的那份**，
     * 加工结果不该和它并排放两个可能不一致的数组（同一份数据只留一个来源）。
     *
     * ⚠️ **必须在这里排序**：服务端下发的 `files` 是 `readdir` 原序（码位序），
     * 于是 `TST-003-2.mp4` 会排在 `TST-003.mp4` 前面（`-`(45) < `.`(46)）。
     * 为什么不放服务端排：旧数据已在 `searchCache.db` 里，服务端改完要重扫才生效，
     * 而重扫要读盘 —— 项目最高优先级是"尽可能少读盘"。这里排 2~5 项，立刻生效。
     * 规则与理由见 `fileNameSort.ts`。
     *
     * ⚠️ `[...]` 浅拷贝再排：`popover.value.files` 是响应式数组，原地 sort 会改动它。
     */
    const rows = computed<FileRow[]>(() =>
        [...popover.value.files]
            .sort((a, b) => compareFileName(a.name, b.name))
            .map((f) => ({ ...f, ...splitFileName(f.name) })),
    );

    /** 高亮的那一项（键盘与鼠标共用）。-1 = 没高亮 */
    const fileCursor = ref(-1);
    /** 可聚焦的容器。`tabindex="-1"` 让它能被 `.focus()`，但不进 Tab 序 */
    const fileListBox = ref<HTMLDivElement | null>(null);

    /**
     * 关弹层并把焦点**还给 body**。
     * ⚠️ 必做：焦点留在 v-show 隐藏的元素上时，`activeElement` 既不是 body 也不是可见元素
     * ⇒ 网格方向键被 `isGridKeyBlocked` 挡死、看不出原因。
     */
    const closeFileList = () => {
        popover.value.visible = false;
        fileCursor.value = -1;
        (document.activeElement as HTMLElement | null)?.blur?.();
    };

    /**
     * 把弹层收进视口。
     *
     * 为什么需要：`:x/:y` 是**固定坐标**，naive 在 manual 定位下**不做翻转**
     * （只有 trigger 挂在元素上时才自动 flip）。卡片靠屏幕底部时，从它的下沿往下展开
     * 会顶出视口 —— 那时最后一行被截掉，用户看不到它。
     *
     * 只**平移**、不翻转到卡片上方：这一层最多 5 行（≈170px），平移几十像素就够；
     * 翻转会让弹层跳到卡片另一边，与"从这张卡展开"的手感断掉。
     *
     * ⚠️ 必须等 naive 自己定位完再量：它拿到 `x/y` 后还有一次写 style 的过程，
     * 此刻量到的是**上一帧的位置**。用 rAF 而不是再加一层 nextTick —— nextTick 只等
     * 本组件的渲染，等不到 naive 内部的定位；而 rAF 落在同一个动画帧的绘制之前，
     * 配合弹层自身的淡入（第一帧透明），看不出这次修正。
     */
    const clampIntoViewport = () => {
        const box = fileListBox.value;
        if (!box) return;
        const r = box.getBoundingClientRect();
        const GAP = 8;
        const dy = r.bottom - (window.innerHeight - GAP);
        const dx = r.right - (window.innerWidth - GAP);
        const dTop = GAP - r.top;
        // 同一帧内这些赋值会被 Vue 合并成一次渲染 ⇒ 不会出现"先右后下"的多次跳动
        if (dy > 0) popover.value.y = Math.max(GAP, popover.value.y - dy);
        // 顶端也要收：卡片贴着顶栏/视口顶时，从它的下沿往下展开仍可能出去一截
        else if (dTop > 0) popover.value.y += dTop;
        if (dx > 0) popover.value.x = Math.max(GAP, popover.value.x - dx);
    };

    /** 弹层。`x,y` 是视口坐标：鼠标传事件坐标，键盘传卡片**下沿**（键盘没有事件对象） */
    const openFileList = (item: WiredFileInfo, x: number, y: number) => {
        if (!deps.isMultiFileCard(item)) return;
        popover.value.visible = true;
        popover.value.x = x;
        popover.value.y = y;
        popover.value.files = item.files;
        popover.value.cover = item;
        fileCursor.value = 0;
        // ⚠️ 只在这里 focus，**不在这里发声**：弹层出现本身是强视觉反馈，
        //    再补一个音等于"开个门响两下"（纪律见 `sfx/index.ts` 的例外清单）。
        // ⚠️ nextTick 必需：这一层是 `:show` 驱动的，此刻 DOM 还没渲染，直接 focus 落空
        void nextTick(() => {
            fileListBox.value?.focus();
            requestAnimationFrame(clampIntoViewport);
        });
    };

    /**
     * 把光标挪到第 i 行并响一声。
     * ⚠️ **走到头就不动、也不出声**：按住方向键到底时若还在响，用户以为还在往下走。
     * ⚠️ 键盘与鼠标**共用这一个函数** —— 主人 2026-11-11 要求"方向盘切换 / 鼠标悬浮
     *    用同一个音效"，两条路径分开写就必然漂移。
     */
    const moveTo = (i: number) => {
        if (i === fileCursor.value) return;
        fileCursor.value = i;
        playSfx('file-move');
    };

    /**
     * 弹层内的键盘。隔离靠结构：监听挂在容器上并 `.stop`（不进 window），
     * 焦点又在这一层里（`isGridKeyBlocked` 兜第二道）。
     *
     * ⚠️ **四个方向都收**，不是只管 ↑↓：这一层从"横排"改成"纵向"了，但用户手上的
     *    肌肉记忆还是 ←→（网格就是 ←→），只收上下等于让他在自己最熟的方向上按不动。
     * ⚠️ 到头**不环绕** —— 这是"选哪个文件"的短列表，环绕会点错。
     */
    const onFileListKeydown = (e: KeyboardEvent) => {
        const n = popover.value.files.length;
        if (!n) return;
        const prev = () => { e.preventDefault(); moveTo(Math.max(fileCursor.value - 1, 0)); };
        const next = () => { e.preventDefault(); moveTo(Math.min(fileCursor.value + 1, n - 1)); };

        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
            next();
        } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
            prev();
        } else if (e.key === 'Enter') {
            // ⚠️ `e.repeat` 必须挡：长按回车会重复打开同一个文件（实测 1 秒 33 次 = 33 个播放器进程）。
            //    方向键相反，**要** repeat（长按连续选是想要的）。
            if (e.repeat) return;
            const f = popover.value.files[fileCursor.value];
            if (f) {
                playSfx('file-open');
                deps.openFile(f.name);
            }
            e.preventDefault();
        } else if (e.key === 'Escape') {
            closeFileList();
            e.preventDefault();
        }
    };

    /** 鼠标悬浮到某一行 = 与方向键同一个动作（同音效、同高亮）。别名而不是再包一层，
     *  免得将来有人只改其中一处 —— 两条路径必须走同一份实现 */
    const hoverFile = moveTo;

    return {
        popover, rows, fileCursor, fileListBox,
        openFileList, closeFileList, onFileListKeydown, hoverFile,
    };
}
