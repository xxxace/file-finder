/**
 * 主题状态 —— 模块级单例（与 `playlist.ts` 同一个做法：
 * 主题是**全局唯一**的东西，不需要每个组件各持一份 ref）。
 *
 * 落点：`<html data-theme="...">`，token 在 `styles/tokens.css` 里按这个属性切换。
 * 默认深色：这一轮改造的目标形态就是截图那一套。
 */
import { computed, ref, watch } from 'vue';

export type ThemeName = 'light' | 'dark';

const STORAGE_KEY = 'ff-theme';

function readStored(): ThemeName {
    try {
        const v = localStorage.getItem(STORAGE_KEY);
        if (v === 'light' || v === 'dark') return v;
    } catch {
        // 存储被禁用（隐私模式）时不该让整个应用起不来
    }
    return 'dark';
}

const theme = ref<ThemeName>(readStored());

watch(
    theme,
    (v) => {
        document.documentElement.dataset.theme = v;
        try {
            localStorage.setItem(STORAGE_KEY, v);
        } catch {
            // 同上：存不下就算了，本次会话内仍然生效
        }
    },
    { immediate: true },
);

export function useTheme() {
    return {
        theme,
        isDark: computed(() => theme.value === 'dark'),
        toggleTheme: () => {
            theme.value = theme.value === 'dark' ? 'light' : 'dark';
        },
    };
}
