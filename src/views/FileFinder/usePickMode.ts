/**
 * 「换封面」挑片模式 —— 选中集合、可选判据、单击/键盘共用入口。
 *
 * 分工（别混）：
 *   · 焦点归 `useGridCursor`（唯一真相），选中归这里；
 *   · `picking` 这个开关留在页面 —— 有 6 处守卫在读它，它不属于"挑片"这一个功能。
 *
 * ⚠️ 选中的是**位置**（dir/name/ext/kind），不是条目对象：刷新或换目录后 `fileList` 里
 * 的对象换了新的，位置没变 ⇒ 选择能活下来（切目录、按 ↻ 都不丢）。
 */
import { computed, ref, type Ref } from 'vue';
import type { WiredFileInfo } from '../../../electron/server/index';

export type PickedEntry = { dir: string; name: string; ext?: string; kind: 'dir' | 'item' };

export interface PickModeDeps {
    /** 页面持有的模式开关（守卫要读，所以不搬进来） */
    picking: Ref<boolean>;
    keyOf: (item: WiredFileInfo) => string;
    /** 落光标（`useGridCursor` 提供）—— 挑片与键盘共用的那条焦点通道 */
    focusCursor: (key: string, opts?: { scroll?: boolean; smooth?: boolean }) => void;
    /** 把选中的位置交给补封面弹窗（展开/抓取/写入整条链路零改动） */
    openFacesModal: (picks: PickedEntry[]) => void;
}

export function usePickMode(deps: PickModeDeps) {
    const picked = ref(new Map<string, PickedEntry>());
    const pickedCount = computed(() => picked.value.size);

    /**
     * 这个格子能不能被选：只有**已经有脸**的（封面卡 / 带 avatar 的目录）。
     * 裸视频、没脸的目录归「补封面」管 —— 两边互补、不重叠，所以这里不让它们被误选。
     */
    const isPickable = (item: WiredFileInfo) =>
        item.type === 'image' || (item.type === 'folder' && !!item.avatar);

    const isPicked = (item: WiredFileInfo) => picked.value.has(deps.keyOf(item));

    /** 只管 `picked` 一个状态，**不碰焦点**（焦点是 useGridCursor 的事）。 */
    const togglePick = (item: WiredFileInfo) => {
        if (!isPickable(item)) return;
        const key = deps.keyOf(item);
        const next = new Map(picked.value);
        if (next.has(key)) {
            next.delete(key);
        } else {
            next.set(key, {
                dir: item.dir,
                name: item.name,
                ext: item.ext,
                // kind:'dir' = 展开它下面所有有封面的（按演员/文件夹批量）；'item' = 只换这一个
                kind: item.type === 'folder' ? 'dir' : 'item',
            });
        }
        picked.value = next;
    };

    /**
     * 单击：模式态 = 选中/取消，非模式态 = 只把选择器移过去（**不开预览**，
     * 开预览仍只由单击图片触发；双击一个字没改）。
     * ⚠️ 模式态也必须先落焦点 —— 漏了这一步，方向键会"跑到别处"（业主四次报）。
     */
    const onItemClick = (item: WiredFileInfo) => {
        if (!deps.picking.value) {
            deps.focusCursor(deps.keyOf(item));
            return;
        }
        deps.focusCursor(deps.keyOf(item), { scroll: true });
        togglePick(item);
    };

    const clearPicked = () => { picked.value = new Map(); };

    const enterPick = () => {
        picked.value = new Map();
        deps.picking.value = true;
    };

    /** 退出即清空 —— 留着的话，下次进来会看到一堆"不知道什么时候选的"东西 */
    const exitPick = () => {
        deps.picking.value = false;
        picked.value = new Map();
    };

    const openFaces = () => {
        const picks = [...picked.value.values()];
        if (!picks.length) return;
        deps.openFacesModal(picks);
    };

    return { pickedCount, isPickable, isPicked, onItemClick, clearPicked, enterPick, exitPick, openFaces };
}
