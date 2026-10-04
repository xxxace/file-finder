# preview-nav —— 预览层「上一条 / 下一条 + 定位」的机制探针

> **状态（2026-10-04）：7 条机制全部实测成立；顺手抓到并修掉一个既有缺陷（见下 A/B）。**
> 被测的写法与 `src/views/FileFinder/index.vue` **逐字同构**：空节点的 `n-image-group`
> （`src-list` + 受控 `show`/`current`）+ `provide(imageContextKey, { previewedImgPropsRef })`
> + 自己排的 `render-toolbar`。

## 复算

```bash
bash docs/probes/preview-nav/run.sh      # 结果同时落到 out.txt
```

## 为什么要打一个 bundle（而不是像 preview-fill 那样直接用 `naive-ui/dist/index.prod.js`）

本轮最需要验的是**注入链**：`provide` 一个 naive-ui **内部**的注入键
（`imageContextKey`），能不能真的喂到"由 `n-image-group` 渲染出来的那张预览 img"。
IIFE 包只暴露 `window.naive` 上的公开组件，**拿不到那个符号** ⇒ 必须走 ESM 打包
（`vite.config.mjs`，用项目自带的 vite，几秒钟）。

## 实测结论（视口 1400×900 的 offscreen Electron，真实 Chromium）

| # | 断言 | 结果（`out.txt`） |
|---|---|---|
| ① | 空节点的 group 能显示预览，且整页只有**一个** `.n-image-preview` | `imgCount: 1` |
| ⑤ | `provide` 的内部键喂到了预览 img（"铺满视口"那套 style 生效） | `inlineStyle: width:100%; height:100%; object-fit:contain` |
| ② | `← →` 键换张（naive-ui 自带的 keydown） | index 0→1，`srcMatched: true`（图片与索引逐字节对上） |
| ③ | 首条再往左**环绕**到最后一条 | index 0 → 2（共 3 条） |
| ④ | `renderToolbar({nodes}).nodes.prev / .next` 排进**我们自己拼的数组**里仍可点 | 8 颗 icon；点第 2 颗 → index 1、`srcMatched: true` |
| ④b | 名称 / 计数节点跟着当前索引走 | `toolbarText: "名称-12 / 3"`（= `名称-1` + `2 / 3`） |
| ⑦ | `srcList` 里**同一位置换一张图**（缩略图 → 原图）不漂移、就地换 | index 不变；`natural 1200×1500 → 2400×1350`、`srcMatched: true` |
| ⑧ | 图标条目（目录）不铺满，给 128px 高 | box `152×128`（`folder.png` 76×64 的 2 倍），`width: auto` |
| ⑨ | 打开 / 关闭跟着受控值走 | 关闭后 `img:false`、再打开 `img:true` |
| ⑩ | 关闭之后 `← →` **没有残留监听** | index 不变、仍关闭 |

## ⚠️ 顺手抓到的既有缺陷：预览图双击会被处理**两次**（已修）

`6a` / `6b` 是同一件事的 A/B 对照（探针里一个开关模拟"加不加守卫"）：

| 场景 | hits |
|---|---|
| `6a` 不加守卫（= 改动前的现状） | **2** |
| `6b` 加"同一个事件只处理一次"的守卫（= 本次修法） | **1** |
| `6c` 守卫之后**下一次**双击仍然生效 | 1 |

根因（静态读 naive-ui 可得，实测确认）：`previewedImgProps` **整个对象**被
`mergeProps(previewedImgProps, { onDblclick: handlePreviewDblclick, … })` 铺到那张 img 上
（`ImagePreview.mjs:555-564`），而 `mergeProps` 对**两边都有**的 `onXxx` 会合并成数组、
**两个都调**；同时 `handlePreviewDblclick` 内部**又**显式调一次我们的 `onDblclick`
（`:218-223`）⇒ 两条路都到我们这儿。

后果（对生产代码而言）：卡片被 `dispatchEvent` 两次 dblclick —— 双击预览图进子目录会
**压两条一样的历史**（返回要按两次）、双击视频会**交给系统播放器两次**。

修法：事件同一性（`if (e === lastPreviewDblclick) return`）。不去猜两条路的先后顺序 ——
那是 naive-ui 的内部实现细节，不该当成前提。
