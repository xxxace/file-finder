# preview-bar —— 预览层「底部通栏工具条」的几何探针

> **状态（2026-10-04）：11 条断言在真 Chromium 下全部成立**（两个视口：1400×900 / 2048×1280）。
> 被测的三条 CSS 在 `index.html` 里，与 `src/views/FileFinder/index.vue` 末尾那个
> 非 scoped `<style>` 块**逐字相同**（不是手抄的近似值 —— 抄错了测出来的数就没意义）。

## 复算

```bash
bash docs/probes/preview-bar/run.sh      # 结果同时落到 out.txt
```

## 问题是什么

改之前：图铺满视口（元素盒 `100vw-32 × 100vh-32`），工具条是
`position:absolute; bottom:40px; height:48px` 的**居中胶囊** ⇒
① 工具条整条**落在图里面**，压掉图底 88px；② 内容只有约 844px 宽，两侧各空 602px。

## 实测结果（1400×900 与 2048×1280 两档结论一致）

| # | 断言 | 实测 |
|---|---|---|
| ① | 工具条真贴底（`bottom == viewport.h`） | `tbFlushBottom: true` |
| ② | 工具条真通栏（宽 == 视口宽、左缘 == 0） | `tbFullWidth: true` · `tbLeft0: true` |
| ③ | **`translateX(-50%)` 真的去掉了**（残留会让整条左移半屏） | `tbNoLeftoverShift: true`（`transform: none`） |
| ④ | **图不再被工具条压住**（核心断言） | `imgOverlapsToolbar: false`，`imgGapToToolbar: 16` |
| ⑤ | 图的外边距：上/左/右仍各 16px（与改之前一致，没顺手改掉） | `gaps: {top:16, left:16, right:16, bottom:64}` |
| ⑥ | wrapper 的 padding 真生效 | `padding: "16px 16px 64px"` |
| ⑦ | 竖图（宽度受限那档）也不压 | `tallOverlapsToolbar: false`，间隙同为 16 |
| ⑧ | **点图外能关**（wrapper padding 那圈归 overlay） | `leftGapTarget: n-image-preview-overlay` → `closedAfterLeftGapClick: true` |
| ⑨ | 上下左右四条间隙命中的都是 overlay，不是图 | `hitTopGap` / `hitLeftGap` 均 `n-image-preview-overlay` |
| ⑩ | 长名称被 ellipsis 裁掉，**不挤动右边的按钮组** | `longNameClipped: true`，名称右缘恒 736，按钮末颗右缘恒 2034（换名前后一致） |
| ⑪ | 按钮数= 8（定位 + 上一条 + 下一条 + 旋转×2 + 原始 +缩放×2 + 关闭 = 9 个节点里8 颗 `n-base-icon`，定位是自绘 `NIcon`） | `iconCount: 8` |

## 关键数据：图反而变大了

| | 改之前 | 改之后 |
|---|---|---|
| 图元素盒高 | `100vh - 32` | `100vh - 80` |
| 被工具条遮住的高度 | **88px** | **0** |
| **实际可见图高** | `100vh - 120` | **`100vh - 80`** |

⇒ 可见高度**净增 40px**。这是"图让出底部"唯一要付的代价，方向和直觉相反：
让出64px，但换掉了原来被压住的 88px。

## 为什么动的是 wrapper 而不是图

`.n-image-preview-wrapper` 是 `position:absolute; inset:0` 的 flex 容器，
而图的 `width:100%; height:100%` 是**相对内容盒**解析的 ⇒wrapper 加 padding，
图的可得区域跟着缩。直接改图会先和 `previewedImgProps` 的 inline style 打架。

**附带收益**：wrapper 的 padding 那圈不属于图（`pointer-events` 落在 overlay 上）⇒
「点图外关闭」这条**白捡回来了**。此前它是被"图铺满视口"吃掉的
（见 `../preview-fill/README.md`：那时只剩最外圈 16px 可点）。

## 环境坑（三个，与 `preview-nav` 同源）

1. 本机 shell 注入 `ELECTRON_RUN_AS_NODE=1`，必须 `env -u` 真删掉（设空字符串没用）。
2. 独立 userData + 禁 GPU：dev 实例占着默认 userData 的 GPUPersistentCache。
3. 窗口必须 `offscreen`：`show:false` 时 Windows 上不参与合成 → rAF 不推进 →
   Vue `<Transition>` 的 enter-from（scale .9）赖着不走 ⇒ 量出来的盒子小 10%。
