/**
 * naive-ui 主题映射 —— **只做「L2 语义 → naive 键」的翻译，不写任何色值**。
 *
 * ⚠️ 为什么不能直接写 `var(--ff-...)`：naive 会在 JS 里对 `primaryColor` 做
 * `changeColor()` 解析（实测 `dropdown/styles/light.mjs:47`、`input/styles/dark.mjs:69`、
 * `checkbox/styles/light.mjs:44` 都用了），传 `var()` 进去会解析失败、组件颜色直接丢。
 * ⇒ 这里从 `<html>` 的**计算样式**读真 hex 喂给 naive，`tokens.css` 仍是唯一真相源。
 *
 * ⚠️ 必须包成 `computed` 并显式依赖 `isDark`：切主题时 `data-theme` 先变、本对象随后重算，
 * 才拿得到新主题的值。少了这个依赖，切主题后 naive 组件会停在旧配色上。
 *
 * ⚠️ 主按钮是「反色」：naive 默认 `textColorPrimary = baseColor`（白），
 * 而我们的 primary 在深色下就是白 —— 白底白字会直接看不见。所以五个 `textColor*Primary` 全部显式覆盖。
 */
import { computed } from 'vue';
import type { ComputedRef } from 'vue';
import type { GlobalThemeOverrides } from 'naive-ui';
import { useTheme } from '@/hooks/useTheme';

/** 读一个 L2 变量。读不到说明 token 层漏了这个名字 —— 开发期喊一声，别静默降级。 */
function makeReader(): (name: string) => string {
    const styles = getComputedStyle(document.documentElement);
    return (name: string) => {
        const raw = styles.getPropertyValue(name).trim();
        if (!raw && import.meta.env.DEV) {
            console.warn(`[naive-theme] token 缺失：${name}`);
        }
        return raw;
    };
}

export function useNaiveOverrides(): ComputedRef<GlobalThemeOverrides> {
    const { isDark } = useTheme();

    return computed<GlobalThemeOverrides>(() => {
        // 只为了建立依赖，不是为了读值：切主题后本 computed 必须重跑一次
        void isDark.value;

        const v = makeReader();

        return {
            common: {
                /* 字体栈只活在 tokens.css 的 `--ff-font`：这里再写一份就是两个真相源，
                   将来改字体（比如给中文换成有 500 的可变字体）必然漏掉一处。 */
                fontFamily: v('--ff-font'),
                /* 主按钮＝**反色**，不是高亮色。
                   2026-11-07 裁决：`#049eff` 只给「卡片选中 / 悬浮 / 输入框焦点」三处，
                   其余保持中性 —— 主按钮涂蓝就变成了第四处。 */
                primaryColor: v('--ff-action'),
                primaryColorHover: v('--ff-action-hover'),
                primaryColorPressed: v('--ff-action-pressed'),
                primaryColorSuppl: v('--ff-action-hover'),
                /* 三层面 */
                bodyColor: v('--ff-canvas'),
                cardColor: v('--ff-panel'),
                modalColor: v('--ff-panel'),
                popoverColor: v('--ff-raised'),
                tableColor: v('--ff-panel'),
                tableHeaderColor: v('--ff-panel'),
                inputColor: v('--ff-raised'),
                hoverColor: v('--ff-raised-hover'),
                /* 文字只有两档（L2 只有 text-1 / text-2） */
                textColorBase: v('--ff-text-1'),
                textColor1: v('--ff-text-1'),
                textColor2: v('--ff-text-2'),
                textColor3: v('--ff-text-2'),
                placeholderColor: v('--ff-text-2'),
                iconColor: v('--ff-text-2'),
                /* 线：日常分区用 8%，控件描边要 14% 才看得出 */
                borderColor: v('--ff-line-strong'),
                dividerColor: v('--ff-line'),
                /* 形态 */
                borderRadius: v('--ff-r-ctl'),
                borderRadiusSmall: v('--ff-r-ctl'),
                fontWeightStrong: '500',
                /* 语义色只做文字与描边 */
                errorColor: v('--ff-danger'),
                warningColor: v('--ff-warn'),
                successColor: v('--ff-ok'),
                infoColor: v('--ff-text-2'),
            },

            Button: {
                /* ⚠️ 去边框必须写 transparent，不能写 none —— 写 none 会少 2px，
                   hover 时整行跳一下。这条是踩过的坑。 */
                border: '1px solid transparent',
                borderHover: '1px solid transparent',
                borderPressed: '1px solid transparent',
                borderFocus: '1px solid transparent',
                borderDisabled: '1px solid transparent',
                colorHover: v('--ff-ctl-hover'),
                colorPressed: v('--ff-ctl-on'),
                colorFocus: v('--ff-ctl-hover'),
                /* ⚠️ 正常态**必须比禁用态亮一档**。
                   naive 原厂 `textColor` 与 `textColorDisabled` **同值**（都取 `textColor2`），
                   只靠 `opacityDisabled` 区分。而本项目按钮是**透明底**（§4.5 文字钮形态），
                   于是"可点的灰字"和"禁用的灰字"几乎一样 —— 用户读到的就是
                   「正常的按钮长得像 disabled」（2026-11-08 主人指出的正是这里：
                   换封面底栏里唯一可点的「退出」被当成禁用）。
                   判据：可点的字降到 text-2 就必须靠底色或描边补回来，而透明底没有东西可补
                   ⇒ 正常态只能是 text-1；禁用态退回 text-2，再叠 naive 自己的透明度。 */
                textColor: v('--ff-text-1'),
                textColorHover: v('--ff-text-1'),
                textColorPressed: v('--ff-text-1'),
                textColorFocus: v('--ff-text-1'),
                textColorDisabled: v('--ff-text-2'),
                colorPrimary: v('--ff-action'),
                colorHoverPrimary: v('--ff-action-hover'),
                colorPressedPrimary: v('--ff-action-pressed'),
                colorFocusPrimary: v('--ff-action-hover'),
                colorDisabledPrimary: v('--ff-action'),
                textColorPrimary: v('--ff-on-action'),
                textColorHoverPrimary: v('--ff-on-action'),
                textColorPressedPrimary: v('--ff-on-action'),
                textColorFocusPrimary: v('--ff-on-action'),
                textColorDisabledPrimary: v('--ff-on-action'),
                borderRadiusTiny: v('--ff-r-ctl'),
                borderRadiusSmall: v('--ff-r-ctl'),
                borderRadiusMedium: v('--ff-r-ctl'),
                heightTiny: '22px',
                heightSmall: '28px',
                fontWeightStrong: '500',
                /* 反色按钮上的白色水波纹等于看不见，去掉更干净 */
                rippleColor: 'transparent',
            },

            Input: {
                /* ⚠️ 不是 `--ff-raised`：那个在深色下贴面板只差 5 级，输入框会"看不见"
                   （2026-11-08 主人："过滤框的颜色太浅"）。见 tokens 的 `--ff-field`。 */
                color: v('--ff-field'),
                colorFocus: v('--ff-field'),
                border: '1px solid transparent',
                borderHover: `1px solid ${v('--ff-line-strong')}`,
                /* 输入框聚焦是「交互态」⇒ 用高亮色描边，**实色不是半透明**
                   （2026-11-07 主人："浅色主题下的蓝色也用 #049eff，不然太淡了"）。
                   不铺蓝底、不加外发光环。 */
                borderFocus: `1px solid ${v('--ff-highlight')}`,
                boxShadowFocus: 'none',
                borderRadius: v('--ff-r-ctl'),
                caretColor: v('--ff-highlight'),
                textColor: v('--ff-text-1'),
                placeholderColor: v('--ff-text-2'),
                heightSmall: '28px',
            },

            /* 小气泡提示。
               ⚠️ 故意**不读** `--ff-tip-*`：那组是左轨自绘浮标专用（白底 + 发丝 + 磨砂），
               而 naive 的 tooltip 没有描边这个键，白底压在白色顶栏/面板上就没有边界了。
               所以它走自己的两个 token，两个主题各自给值。
               ⚠️ 原厂深色是 `color: popoverColor` + `textColor: textColor2` ——
               灰字压深底（#8f8f8f on #242424），12px 下读起来就是"被禁用"，
               而 tooltip 恰恰是**唯一的信息文本**，它必须比正文更亮，不能更暗。 */
            Tooltip: {
                color: v('--ff-tooltip-bg'),
                textColor: v('--ff-tooltip-text'),
            },

            Dropdown: {
                /* 浮层用最亮那一档（浅色纯白 / 深色 #242424），悬停才看得出来 */
                color: v('--ff-popover'),
                /* 菜单里的"已选"不靠颜色，靠**勾选图标**（菜单项自带 checkmark）。
                   所以悬停与选中共用同一档灰 —— 比"悬停灰、选蓝"更干净。 */
                optionColorHover: v('--ff-menu-hover'),
                optionColorActive: v('--ff-menu-hover'),
                optionTextColor: v('--ff-text-1'),
                optionTextColorActive: v('--ff-text-1'),
                /* ⚠️ naive 的默认值是 `optionTextColorHover: textColor2` —— 即"悬停时文字**变淡**"。
                   在浅色主题里那是对的（深色字 → 次要灰仍可读），在深色主题里就成了
                   "一悬停像被禁用"（2026-11-08 主人指的正是这里）。悬停只能更亮，不能更淡。 */
                optionTextColorHover: v('--ff-text-1'),
                borderRadius: v('--ff-r-ctl'),
            },

            Table: {
                thColor: v('--ff-panel'),
                tdColor: v('--ff-panel'),
                tdColorHover: v('--ff-raised'),
                borderColor: v('--ff-line'),
                thTextColor: v('--ff-text-2'),
                tdTextColor: v('--ff-text-1'),
                borderRadius: v('--ff-r-card'),
            },

            Checkbox: {
                /* 勾选框跟着主按钮走（反色），不占用高亮色 —— 高亮色只有三处用途 */
                colorChecked: v('--ff-action'),
                borderChecked: `1px solid ${v('--ff-action')}`,
                checkMarkColor: v('--ff-on-action'),
                borderRadius: v('--ff-r-pill'),
            },

            /* Switch / Slider：**Apple 模型**——开态 = 系统绿（--ff-status-ok 就是 #34C759 系，
               浅色字面同值、深色提亮一档），关态轨道用可见的抬升灰；滑杆填充与开关同绿成对，
               圆点恒白（HIG：拇指永远白色，颜色由轨道表达）。
               ⚠️ 不能跟 primaryColor 走：本项目主按钮=反色（深色下白），
               白轨+白点就是主人截图里"看不出开关开着没"的根因。 */
            Switch: {
                railColor: v('--ff-ctl-on'),
                railColorActive: v('--ff-status-ok'),
                loadingColor: v('--ff-status-ok'),
                boxShadow: '0 1px 3px rgba(0, 0, 0, 0.25)',
                boxShadowFocus: '0 1px 3px rgba(0, 0, 0, 0.25)',
            },

            Slider: {
                fillColor: v('--ff-status-ok'),
                fillColorHover: v('--ff-status-ok'),
                dotColor: v('--ff-on-highlight'),
                dotBorder: `1px solid ${v('--ff-line-strong')}`,
            },

            /* 图片预览的底部工具条。
               ⚠️ naive 的默认是 `toolbarColor: rgba(0,0,0,.35)` —— 压在照片上等于没有背景。
               它压在**照片**上，所以这组值不随主题（见 tokens 的 `--ff-media-*`）。
               放在主题里而不是只写在 CSS 里：这样任何一处 `n-image` 预览都吃到同一份值。 */
            Image: {
                toolbarColor: v('--ff-media-bar-bg'),
                toolbarIconColor: v('--ff-media-icon'),
            },

            Dialog: {
                color: v('--ff-panel'),
                borderRadius: v('--ff-r-card'),
            },

            /* 顶部进度条。
               ⚠️ naive 的样式是 `background: var(--n-color-loading)`（简写，不是 background-color）
               ⇒ 这里可以直接喂渐变字符串，它不会像 `primaryColor` 那样被 `changeColor()` 解析，
               没必要为了一个渐变去写 `!important`。
               ⚠️ 点阵、闪烁、前缘辉光都在 `loading-bar.css`：那些是 naive 没有对应键的东西，
               写进主题只会变成"主题里假装能配、实际不生效"。 */
            LoadingBar: {
                /* 直接拿 `--ff-bar-base-stops` 拼：那条定制属性就是唯一真相源，
                   不在 tokens 里再存一份 `linear-gradient(...)` 的镜像值。 */
                colorLoading: `linear-gradient(90deg, ${v('--ff-bar-base-stops')})`,
                height: v('--ff-bar-h'),
            },

            Modal: {
                color: v('--ff-panel'),
                borderRadius: v('--ff-r-card'),
            },
        };
    });
}
