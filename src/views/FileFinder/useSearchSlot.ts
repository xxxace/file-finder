/**
 * 顶栏搜索槽 —— 过滤词、展开态、聚焦时机。
 *
 * **唯一不变量：收起 ⇒ 一定没有过滤词。** 一个收起的框里还留着词，网格会莫名其妙少一半，
 * 界面上却只有一颗图标、没有任何线索 —— "看不见的过滤条件"是最坏的一种陷阱。
 *
 * 实现靠两头守：`watch` 保证"有词就展开"，`onSearchBlur` 保证"要收就必须是空的"。
 */
import { nextTick, ref, watch } from 'vue';
import type { InputInst } from 'naive-ui';

export function useSearchSlot() {
    const searchText = ref('');
    /** 收起 = 28px 一颗图标；展开 = 220px 输入框（宽度从地址槽里挤，不做浮层） */
    const searchOpen = ref(false);
    const searchSlot = ref<HTMLDivElement | null>(null);
    const searchInput = ref<InputInst | null>(null);

    const openSearch = () => {
        searchOpen.value = true;
        // 等宽度挂上去再聚焦：给 width:28 的框聚焦，光标会落在被裁掉的那一侧
        void nextTick(() => searchInput.value?.focus());
    };

    /** 收起态被 Tab 命中时自动展开 —— 否则焦点落在一个 opacity:0 的框里，打字直接过滤网格 */
    const onSearchFocus = () => { searchOpen.value = true; };

    /**
     * 失焦即收起，但**必须先看焦点去了哪**、而且**有词时不许收**：
     * ① 点「清空 ×」是先 blur 再 click —— 直接收会让那次点击落在已经消失的框上；
     * ② 有词还收就是上面那条不变量被打破（`onBack` 会还原上一屏的词，且不碰展开态）。
     */
    const onSearchBlur = () => {
        window.setTimeout(() => {
            if (searchSlot.value?.contains(document.activeElement)) return;
            if (searchText.value) return;
            searchOpen.value = false;
        }, 0);
    };

    /** Esc：把焦点交还网格（否则打字框一直吃着方向键）。收起交给 blur 那条路判。 */
    const blurSearch = (e: KeyboardEvent) => {
        (e.target as HTMLElement | null)?.blur();
    };

    // 词一出现就强制展开 —— 不依赖任何调用方（`onBack` 还原词时不会调 openSearch）
    watch(searchText, v => { if (v) searchOpen.value = true; });

    return { searchText, searchOpen, searchSlot, searchInput, openSearch, onSearchFocus, onSearchBlur, blurSearch };
}
