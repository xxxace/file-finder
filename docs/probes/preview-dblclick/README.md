# preview-dblclick —— 预览图「双击无行为 + 滚轮缩放」行为探针

> **状态（2026-10-04）：6 条断言全过**（真 Chromium，视口 1400×900）。
> 被测逻辑与 `src/views/FileFinder/usePreview.ts` 同构。

## 复算

```bash
bash docs/probes/preview-dblclick/run.sh      # 结果同时落到 out.txt
```

## 背景：为什么改

原来的 `onDblclick` 是「关预览 + 把双击还给下面那张卡片」，为修「多部组成的封面弹不出文件列表」。
但它**抢走了双击这个动作** ⇒ 双击预览图会直接开视频 / 进文件夹。
业主 2026-10-04 裁定：**双击、单击都不做任何行为**；缩放走**工具条按钮 + 滚轮**。

## 实测结论

| # | 断言 | 实测 |
|---|---|---|
| ① | 双击预览图**不触发卡片**（原 BUG） | `cardDblclick: 0` |
| ① | 双击后预览仍开着（不误关） | `previewStillOpen: true` |
| ② | **A/B 对照**：切回旧实现同样双击 ⇒ 卡片真收到 | `cardDblclick: 2`（见下注） |
| ③ | 滚轮放大生效 | `scale: null → 2.25` |
| ④ | 滚轮缩小生效 | `2.25 → 1.5` |
| ⑤ | 关窗后无残留滚轮监听 | `listenerAfterClose: false`、`wheelAfterClose: 0` |

**② 为什么是 2 次**：旧实现本来就会被调**两次**（naive-ui 的 `mergeProps` 对同名 `onXxx`
合并成数组、两个都调）—— 那正是 2026-10-04 已修的既有缺陷（见 `preview-nav` 探针 6a/6b/6c）。
所以断言用 `>= 1`：**这里测的是"会穿透"这个事实，次数不影响结论。**
顺带印证：新实现没有那个双调问题（① 的 `cardDblclick` 恒 0）。

## 关键机制：滚轮缩放**复用**naive-ui，不自己实现

- 它的 `handleKeydown` 绑在 **document** 上（`ImagePreview.mjs:112`），
  `ArrowUp→zoomIn` / `ArrowDown→zoomOut`（`:91` / `:95`）**已经接好**；
- ⇒ 滚轮只需**派发 ↑↓ 键**：`deltaY < 0 ? 'ArrowUp' : 'ArrowDown'`。
- 自己改 `scale` 就得复制它的 clamp（`0.5 ~ maxScale`，`:279-297`）与 offset 回弹
  —— 那是它的内部实现细节，不该被复制。

挂/撤跟着 `watch(previewOpen)` 走：**一处管两头**。
`onPreviewShowChange` 只在**关闭**时被调（`v === false`），打开不经过它 ⇒ 挂在那儿会漏掉"开"。

## ⚠️ 探针本身踩的三个坑（都是"探针错了"，不是代码错了）

1. **`show` 必须初始为 `false` 再打开**：naive-ui 在 `watch(mergedShowRef)` 里挂 keydown
   （`:112`），初始就`true` ⇒ watch 从不触发 ⇒ 键盘与缩放**全都失灵**（我第一版 3 条断言全 FAIL）。
   生产里预览总是「关 → 开」，所以那边没问题；**探针必须复现这条路径**。
2. **transform 要读 `style.cssText`，不是 `style.transform`**：naive-ui 是
   **整段写** `style.cssText = ...`（`:319`）⇒ 读 `style.transform` 永远读不到（3 条 FAIL）。
3. **`getMaxScale()` 可能返回 1**：图比视口小 ⇒ `scale < maxScale` 为假 ⇒ 放大不了。
   断言别写死"scale 一定变大"，要写"放大后有数字且 > 1"。

另外调试 Electron 探针时若报 `ERR_FAILED` / `GPU process isn't usable`，
是**缺 `--no-sandbox` + `--disable-gpu-compositing`**（`run.sh` 里已有，手写调试脚本容易漏）。
