/**
 * 「这个封面下有哪几个文件」弹层 —— 状态、定位、键盘。
 *
 * 与页面只通过 `deps` 交换数据（同 `usePreview` / `useContextMenu`）。
 * ⚠️ 它与"打开"咬合：`openFile` 要靠 `popover.cover` 算父目录 —— 别在这里改这个语义。
 */
import { nextTick, ref } from 'vue';
import type { FileInfoFiles, WiredFileInfo } from '../../../electron/server/index';
import type { CardLike, DirCard } from './openDecision';

export interface FileListPopoverDeps {
    /** 只有多文件封面才弹这一层。
     *  ⚠️ 必须保留**类型谓词**：`item.files` 的可空性靠它收窄，写成 `=> boolean`
     *  就得在下面补 `?? []` —— 那是把判据抄第二遍。 */
    isMultiFileCard: (item: CardLike) => item is DirCard;
    /** 打开其中一个文件（传文件名；父目录由页面按 `popover.cover` 算） */
    openFile: (name: string) => void;
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

    /** 高亮的那一项（键盘用）。-1 = 没高亮 */
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

    /** 弹层。`x,y` 是视口坐标：鼠标传事件坐标，键盘传卡片中心（键盘没有事件对象） */
    const openFileList = (item: WiredFileInfo, x: number, y: number) => {
        if (!deps.isMultiFileCard(item)) return;
        popover.value.visible = true;
        popover.value.x = x;
        popover.value.y = y;
        popover.value.files = item.files;
        popover.value.cover = item;
        fileCursor.value = 0;
        // ⚠️ nextTick 必需：这一层是 `:show` 驱动的，此刻 DOM 还没渲染，直接 focus 落空
        void nextTick(() => fileListBox.value?.focus());
    };

    /**
     * 弹层内的键盘。隔离靠结构：监听挂在容器上并 `.stop`（不进 window），
     * 焦点又在这一层里（`isGridKeyBlocked` 兜第二道）。
     * 主轴是**左右**（容器横排）；到头停住不环绕 —— 这是"选哪个文件"的短列表，环绕会点错。
     */
    const onFileListKeydown = (e: KeyboardEvent) => {
        const n = popover.value.files.length;
        if (!n) return;
        const prev = () => { fileCursor.value = Math.max(fileCursor.value - 1, 0); e.preventDefault(); };
        const next = () => { fileCursor.value = Math.min(fileCursor.value + 1, n - 1); e.preventDefault(); };

        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
            next();
        } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
            prev();
        } else if (e.key === 'Enter') {
            // ⚠️ `e.repeat` 必须挡：长按回车会重复打开同一个文件（实测 1 秒 33 次 = 33 个播放器进程）。
            //    ← → 相反，**要** repeat（长按连续选是想要的）。
            if (e.repeat) return;
            const f = popover.value.files[fileCursor.value];
            if (f) deps.openFile(f.name);
            e.preventDefault();
        } else if (e.key === 'Escape') {
            closeFileList();
            e.preventDefault();
        }
    };

    return { popover, fileCursor, fileListBox, openFileList, closeFileList, onFileListKeydown };
}
