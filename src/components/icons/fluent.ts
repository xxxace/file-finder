import { defineComponent, h } from 'vue';

/**
 * Fluent System Icons 的**本地内联版**，只收顶栏实际用到的那几颗。
 *
 * 为什么不装 `@vicons/fluent`：那是七万多个图标的全家桶，只为两颗图标把整包拖进
 * node_modules 不值当（产物侧能 tree-shake，安装与解析成本却是实打实的）。
 * 路径取自官方 `fluentui-system-icons`。
 *
 * ⚠️ 只给 `viewBox`、**不给 `width`/`height`** —— 与 `@vicons/*` 的写法保持一致：
 * 尺寸由 `n-icon` 的 font-size（顶栏 18px）决定，写死宽高会顶掉那套规格。
 *
 * ⚠️ **统一用 28 尺寸，不用 24**（主人 2026-11-08："不然和 ionicons5 的看起来不一样大"）。
 * 原因不是 viewBox 大小，是**墨迹外框占 viewBox 的比例**：Fluent 24 比 ionicons 留白多，
 * 同给 18px 显示时墨迹会小一圈；28 尺寸重绘时把留白收紧了 ⇒ 与 ionicons 视觉尺寸对齐。
 */
const fluentIcon = (name: string, size: number, d: string) =>
    defineComponent({
        name,
        render: () =>
            h(
                'svg',
                { xmlns: 'http://www.w3.org/2000/svg', viewBox: `0 0 ${size} ${size}` },
                [h('path', { d, fill: 'currentColor' })],
            ),
    });

/**
 * 竖三点。
 * 墨迹纵向 21.5/28 = 76.8%（24 尺寸只有 67%、原横三点 81%）⇒ 18px 下约 13.8px 高。
 * 余下那 ~4% 差距就是视觉误差了；若仍觉得偏小，把这颗 `--n-icon-size` 提到 20px。
 */
export const MoreVertical28Filled = fluentIcon(
    'MoreVertical28Filled',
    28,
    'M14 8.75a2.75 2.75 0 1 1 0-5.5a2.75 2.75 0 0 1 0 5.5zm0 8a2.75 2.75 0 1 1 0-5.5a2.75 2.75 0 0 1 0 5.5zM11.25 22a2.75 2.75 0 1 0 5.5 0a2.75 2.75 0 0 0-5.5 0z',
);
