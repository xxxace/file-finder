/**
 * naive-ui 主题覆盖 —— 只改两件事：主色、圆角。
 *
 * 主色取 B 站蓝 `#00AEEC`（**不是粉**）：粉在这套设计里只表示"我在哪"（导航/选中），
 * 而 naive-ui 的 primary 会被按钮、开关、复选框、loading 一起用 —— 那是"能点哪"的语义。
 * 两者混用会出现"一个粉色开关"这种既不像 B 站也不像工具的东西。
 *
 * 深色那份额外对齐面板色：naive 自带的 `#18181c` 与本项目 `--ff-surface` 差一档，
 * 弹层与左轨会看出两种黑。
 */
import type { GlobalThemeOverrides } from 'naive-ui';

const FONT_FAMILY = '-apple-system, "Segoe UI", "Microsoft YaHei", "PingFang SC", system-ui, sans-serif';

const shared: GlobalThemeOverrides = {
    common: {
        primaryColor: '#00AEEC',
        primaryColorHover: '#33BEF0',
        primaryColorPressed: '#0095CC',
        primaryColorSuppl: '#33BEF0',
        borderRadius: '6px',
        borderRadiusSmall: '4px',
        fontFamily: FONT_FAMILY,
    },
};

export const lightOverrides: GlobalThemeOverrides = {
    common: {
        ...shared.common,
        cardColor: '#FFFFFF',
        modalColor: '#FFFFFF',
        popoverColor: '#FFFFFF',
    },
};

export const darkOverrides: GlobalThemeOverrides = {
    common: {
        ...shared.common,
        bodyColor: '#18191C',
        cardColor: '#1F2022',
        modalColor: '#1F2022',
        popoverColor: '#242527',
    },
};
