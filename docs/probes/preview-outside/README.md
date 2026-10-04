# 探针：预览层「点图外关闭」

## 缺陷与根因

**现象**：打开预览图 → 点图片外的区域 → 关不掉；**缩小了也关不掉**。

**根因**（naive-ui 2.45.3 行号为证）：关闭预览的**唯一**入口是 overlay 的 `onClick`
（`ImagePreview.mjs:510`）。官方靠 `.n-image-preview-wrapper { pointer-events:none }`
（`styles/index.cssr.mjs:45`）让点击穿到 overlay —— 但 `.n-image-preview`（图）是
`pointer-events:all`（`:52`），**图元素一旦铺满视口就把 overlay 完全盖死**。

本项目2026-10-04 把图覆盖成 `width/height:100%`（为了"打开就是大的"）⇒ 关闭能力被顺带弄丢，
且没有注释记录这个取舍。

⚠️ **缩小救不了**：`object-fit:contain` 的黑边在**元素盒子内**（盒子恒为全屏）；
而 naive-ui 的缩放下限是 `0.5`（`ImagePreview.mjs:291`），最小也有半屏大。
⇒ 无论怎么缩，都不存在"图外"可点。

## 修法

`previewedImgProps.style` 回到官方那套「`max-*` + `width/height:auto`」，只把**约束源**
从视口换成 wrapper 的**内容盒**（`index.vue` 给 wrapper 加了 `padding:16px 16px 64px`，
那 64px 正是底部工具条那一条）：

```js
{ maxWidth:'100%', maxHeight:'100%', width:'auto', height:'auto', objectFit:'contain' }
```

⇒ 图按比例缩到**装得下且尽量大**，元素盒子精确贴合图像 ⇒ 四周留白可点。
工具条那条由 `z-index:1`（`styles/index.cssr.mjs:21`）天然在上，不会误关。

## 判据（8 条，真Chromium + 命中测试）

| # | 判据 | 实测 |
|---|---|---|
| ① | 图未铺满视口（四周有留白） | 图 99×258 / 视口 1602×903 |
| ②a | 点图上命中 `.n-image-preview`（不关） | ✓ |
| ②b | 点右侧留白命中 **overlay**（关） | ✓ |
| ②c | 点上方留白命中 **overlay**（关） | ✓ |
| ③ | 底部工具条命中 **toolbar**（不误关） | ✓ |
| ④ | **缩到最小后仍有图外留白** | 缩小后 100×260 |
| ④b | 缩小后点图外仍命中 overlay | ✓ |
| ⑤ | 点遮罩真的能关闭 | 在场 true→false |

④/④b 是关键：它们直接对应用户报的「**缩小了也关不掉**」。

## 为什么必须真 Chromium

判据全在**命中测试**（`elementFromPoint`）与**真实布局**上。静态读 CSS 只能给"应该"。
窗口必须 **offscreen**（`show:false` 时 Windows 上不参与合成 ⇒ rAF 不推进 ⇒ 一帧都测不到）。

## ⚠️ 本探针**测不到**的一类缺陷（别指望它）

**「缩略图→大图升级时画面跳一下」测不到。** 原因：大图在探针里是 data URL
（**同步可用** ⇒ `naturalWidth` 立刻有值、`complete=true`）⇒ 根本走不到
「新 `<img>` 还没加载完」那一支；而真实环境大图走 **HTTP**（有延迟）才会出现那一瞬。

我试过两种造法（强制 `naturalWidth=0`、异步换 src），**回退修复后断言依然 PASS**
⇒ 该断言无效。**无效的断言已从探针里删掉**（留着会让人误以为测过了）。
要真测它，得给探针架一个**真 HTTP 延迟**，或靠真机目视。

判据抓不到缺陷 ⇒ 一条 PASS 说明不了任何事。这是本项目探针的**入库判据**：
**必须先能抓到那个缺陷**（回退修复后应 FAIL）。

## 写探针时踩的两个坑

1. **漏绑 `onUpdate:show`** ⇒「点遮罩能关」测的是**探针自己的 bug**：naive-ui 关闭只发
   这个事件，不绑回去 `show` 永远是 true。主界面绑的是 `onPreviewShowChange`。
2. 探针的 `<style>` 必须**搬进项目真实的 wrapper padding** —— 判据里的"可视区"依赖它，
   不搬过来量到的是错的视口。
3. `clientWidth/Height` 给的是**含 padding 的外框**（不是内容盒）—— 这是实现侧的坑，
   探针与实现必须用**同一个口径**（都自己减 padding），否则量到的"可视区"两边不一致。

## 跑法

```bash
bash docs/probes/preview-outside/run.sh
```
