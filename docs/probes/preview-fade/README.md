# 探针：预览层关闭淡出期间 `src` 被清空

## 这条缺陷是什么

用户报：**打开预览图 → 关闭 → 淡出动画期间出现"图片图标 + 空白透明边框"**。

## 根因（有naive-ui 源码行号证据）

1. 关闭时 `closePreview()` 把 `previewKey` 清空 ⇒ `previewIndex` 变 **-1**
   （`usePreview.ts`）。
2. `:current="-1"` 传进 `n-image-group` ⇒ `ImageGroup.mjs:78` `currentId = imageIdList[-1]`
   = `undefined` ⇒ `:83` `currentUrl = urlMap.get(undefined)` = `undefined`。
3. `ImagePreview.mjs:561` `src: this.previewSrc` = `undefined` ⇒ **`<img src=undefined>`**。
4. 但 `:564` 的 `vShow` 在淡出期间仍让这个 `<img>` 留在场 —— naive-ui 用 `displayedRef`
   **专门留了这段窗口**（`:496` `if (!(mergedShow || displayed)) return null`，
   动画走完才在 `onAfterLeave` 里置false）。

⇒ 所以浏览器给一个没有 `src` 的 `<img>` 画了那个占位图标。**不是naive-ui 的缺陷，
是我的状态设计错了**：「关」不该毁掉「开着时是第几条」—— 那是淡出动画期间的有效输入。

## 修法

`previewOpenState`（开不开）从 `previewKey`（看的是哪条）里**拆出来**，成为独立状态：

- `closePreview()` 只翻开关，**不清 `previewKey`** ⇒ `:current` 保持有效 ⇒ `src` 一直在。
- `previewOpen = previewOpenState && previewIndex >= 0` ⇒ 条目真没了仍**自动关**
  （换目录/搜索/盘拔了都成立），不靠任何同步代码。
- 附带两处必须配套的修正（否则引入新缺陷）：
  - `closePreview` 里要 `cancelSharpTimer()` —— 否则"打开后马上关"仍会发 `/preview`，
    而它可能去**读移动硬盘上的原图**（第一约束）。
  - 升级逻辑抽成 `scheduleSharpUpgrade`，`openPreview` 也要调 —— 否则**重开同一条**
    永远停在糊图上（`watch(previewKey)` 只在 key 变化时跑，而重开时 key 没变）。

## 为什么必须真 Chromium

缺陷只存在于「`show` 已 false、DOM 仍在场」这个**动画窗口**内。静态读代码只能给
"应该"，必须真点关闭、逐帧读那个 `<img>` 的 `getAttribute('src')`。

窗口必须 **offscreen**：`show:false` 时 Windows 上不参与合成 ⇒ rAF 不推进 ⇒ 一帧都测不到。

## A/B 对照（这是本探针的关键设计）

页面用 `?mode=` 切换**同一段判据**下的两种实现：

| mode | 行为 | 预期 |
|---|---|---|
| `buggy`（缺省） | `previewOpen = previewIndex >= 0`，关 = 清 key | **恰好 1 条 FAIL**：淡出 6/6 帧 src 为空 |
| `fixed` | 开关独立，关只翻开关 | 5 条全 PASS |

**探针必须先能抓到那个缺陷**，否则一条 PASS 说明不了任何事。实测输出见 `out.txt`。

## 跑法

```bash
bash docs/probes/preview-fade/run.sh
```

## 三个环境坑（与 `preview-nav` 同源，都踩过）

1. 本机 shell 注入 `ELECTRON_RUN_AS_NODE=1` ⇒ 必须 `env -u` **真删掉**（设空字符串没用）。
2. 独立 userData + 禁 GPU：dev 实例占着默认 userData 的 GPUPersistentCache，
   共用会让 GPU 反复崩、渲染进程 `ERR_FAILED`。
3. 窗口必须 offscreen（见上）。

## 一个写探针时踩的坑

第一版把 `n-image` 放进了 `n-image-group` 的 default slot，naive-ui 报
「can't be placed inside `n-image-group` when `src-list` is set」。
**真实界面里 `n-image-group` 是个空节点**，网格里的 `n-image` 是它的**兄弟**。
抄错结构 ⇒ 探针不足以代表真实界面 ⇒ 必须改成同构。
