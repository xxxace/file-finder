# 探针：多部组成的 popover —— 点击归属 vs 预览层抢点击

复算：

```bash
bash docs/probes/popover-pick/run.sh
```

用**项目自带的 electron** 当真浏览器（不需要 playwright / happy-dom）。三页：

| 页 | 问的是 |
|---|---|
| `index.html` | 文件列表 popover **自己**：每个格子的命中归属、`openFile` 收到什么 |
| `grid-preview.html` | **改前**：双击卡片（带真 `n-image` 预览）到底谁吃掉了第二下 |
| `grid-preview.html?v=fixed` | **改后**：双击能不能落到卡片上、列表点第二项是不是打开第二部 |

markup 不是手抄的：`templates.cjs` 从**活源码** `src/views/FileFinder/index.vue` 切片，
`build-css.mjs` 真实编译那份 `<style scoped>`（less + scoped 转换）。

## 结论（2026-10-02）

### ① popover 本身没问题（先说清，免得改错地方）

`index.html` 的实测：3 个格子各自的**中心点**最顶层都是它自己（无重叠），
逐个派发 `dblclick` → `openFile` 依次收到 `TST-046-1/2/3.mp4`，拼出的路径是
`cover.dir + '/' + 那一个名字`。**"点 A-2 打开 A-1" 不发生在这一层。**

### ② 真正吃掉点击的是**预览图**

`grid-preview.html`（改前）的实测：

- 单击卡片 → 预览立刻打开，那张 `<img>` 的盒子是 **1370×871（窗口 1400×900）**——
  被 `previewedImgProps` 的 `width/height:100%` 撑满了视口，而 naive-ui 的
  `.n-image-preview` 是 `pointer-events: all`、外包层是 `none`；
- 于是双击的**第二下** `dblclick` 的 target = **`.n-image-preview`**，卡片的
  `@dblclick` 永远收不到 ⇒ **多部组成的封面弹不出文件列表**；
- 本该落在列表上的点击漏到下层卡片上，而卡片那条路是 `files.find(VIDEO_EXT_RE)`
  ⇒ **永远第一部片子**（用户反馈的正是它）；
- 顺带解释了"老是误触下载"：预览图铺满后**点图外关不掉**（遮罩在图的下面，
  `z-index: -1`），只剩 ✕ / Esc，而「下载」就紧挨着 ✕。

### ③ 改后（改的东西见 `src/views/FileFinder/index.vue`）

| 断言 | 改前 | 改后 |
|---|---|---|
| 单击 → 预览立刻开 | ✅ | ✅（不变） |
| 预览工具条图标数 | 7 | **6**（下载去掉） |
| 双击卡片 → 文件列表打开 | ❌ | **✅** |
| 双击后预览还开着吗（过窗口） | 开着 | **关掉了** |
| 列表点第 2 项 → `openFile` 收到 | — | **`TST-046-2.mp4`** ✅ |

两处改动都走**已有入口**，没有新机制：
`render-toolbar`（naive-ui 官方口子，`Image.mjs` 透传）+ `previewedImgProps.onDblclick`
（`ImagePreview.mjs` 的 `handlePreviewDblclick` 会转发给它）。

⚠️ 走过的弯路记一笔：第一版是「`preview-disabled` 常开 + 200ms 后自己调 `showPreview()`」，
**被这个探针当场否掉** —— naive-ui 的 `showPreview()` 开头就是 `if (previewDisabled) return`
⇒ 预览会**彻底打不开**（实测 `单击_过窗口后_预览已开 = false`）。`showPreview` 确实在
setup 返回里（`exposedMethods`）、实例拿得到，但那个守卫让它和 `preview-disabled` 互斥。
