/**
 * 工具条下拉（磁盘 / 匹配源）共用的一份 naive 主题覆盖。
 *
 * 为什么需要它：naive 的默认深色下拉是「有边框的输入框」长相，放在一排 28px
 * 无边框 ghost 按钮中间，会被读成**禁用状态**（2026-11-08 主人指出匹配源"像 disabled"）。
 * 这里把它拉回工作台的控件语言：无边框、28 高、文字用正文色、只有聚焦才描高亮边。
 *
 * ⚠️ 三个地方不改：
 *   ① 不改全局主题（`styles/naive-theme.ts`）—— 那会影响整个应用，而这里只讨论工具条；
 *   ② 不复刻 naive 的内部 DOM（`.n-base-selection__border` 之类）—— 版本一升就碎；
 *   ③ 颜色只引 `--ff-*`，本文件不出现色值字面量。
 */
export const TOOLBAR_SELECT = {
    peers: {
        InternalSelection: {
            // **常驻底色**（主人 2026-11-08：不要只在悬停时才出现底）。
            // 取 `--ff-field` 而不是 `--ff-raised`：深色下 #313131 vs #242424，
            // 后者贴 `--ff-panel` 只差几级，框和背景会糊在一起。
            color: 'var(--ff-field)',
            colorActive: 'var(--ff-field)',
            textColor: 'var(--ff-text-1)',
            textColorDisabled: 'var(--ff-text-2)',
            placeholderColor: 'var(--ff-text-2)',
            placeholderColorDisabled: 'var(--ff-text-2)',
            arrowColor: 'var(--ff-text-2)',
            arrowColorDisabled: 'var(--ff-text-2)',
            caretColor: 'var(--ff-highlight)',
            // 常态不描边；聚焦才亮一条高亮边（与输入框同一套规矩）
            border: '1px solid transparent',
            borderHover: '1px solid transparent',
            borderActive: '1px solid transparent',
            borderFocus: '1px solid var(--ff-highlight)',
            // naive 深色默认是 `0 0 0 2px rgba(255,255,255,.28)` —— 一圈白环，
            // 正是"像被启用/像被禁用"两不管的那个东西，直接关掉。
            boxShadowHover: 'none',
            boxShadowActive: 'none',
            boxShadowFocus: 'none',
            borderRadius: 'var(--ff-r-ctl)',
            heightSmall: 'var(--ff-h-ctl)',
            paddingSingle: '0 8px',
        },
        InternalSelectMenu: {
            color: 'var(--ff-popover)',
            borderRadius: 'var(--ff-r-ctl)',
            optionHeightSmall: '30px',
            // 悬停 = 控件悬停灰；**已选 = 卡片选中的那片蓝**（主人指定）
            optionColorPending: 'var(--ff-ctl-hover)',
            optionColorActive: 'var(--ff-highlight-weak)',
            optionColorActivePending: 'var(--ff-highlight-weak)',
            optionTextColor: 'var(--ff-text-1)',
            optionTextColorPending: 'var(--ff-text-1)',
            optionTextColorPressed: 'var(--ff-text-1)',
            optionTextColorActive: 'var(--ff-text-1)',
            // ⚠️ 不要加 `optionCheckMarkColor`：当前 naive 版本里**没有这个键**，
            // 写了也是静默无效（勾选色取 `common.primaryColor`，即本应用的反色主按钮色）。
        },
    },
};
