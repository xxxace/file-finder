# 预览器：上一条 / 下一条 + 定位到网格（设计 + 已落地）

日期：2026-10-04 ｜ 状态：**已落地**（`typecheck` 0 error · 生产构建通过 · 机制探针 9 条断言全过；
剩**真机目视**，见 §九）
需求（主人原话）：
> 1. 点开后可以看上一张、下一张（UI 按钮 和 左右键都要支持）
> 2. 可以定位到具体的文件（也就是 scroll 过去，UI 按钮 和 回车都要支持）
> 补充澄清：只认「**上一条 / 当前 / 下一条**」；有封面给看封面，没封面给看抽帧图，文件夹显示文件夹图标，最好显示名称。

---

## 一、定稿的决策（6 条）

| # | 决策 | 理由 / 依据 |
|---|---|---|
| D1 | 序列 = **当前 `fileList` 的全部条目里"有图可显示"的那些**（含搜索过滤结果），**顺序与网格逐格一致** | 主人澄清。只有同一条序列，「定位」才成立（预览里第 12 条 = 网格第 12 格） |
| D2 | 每条显示**它卡片上的那张图**：图片→缩略图（停住后升原图）、视频→抽帧图、目录→`avatar` 或文件夹图标 | 与卡片同一规则；不另造一套「预览专用」表示 |
| D2b | **非图片类文件不进序列**（网格里它们用的是 `file-icon-vectors` 的字体图标，塞不进 `<img>`；而且它们今天也没有"点开"的入口） | ⚠️ 这是动手前自查时**改掉**的一条 —— 见 §八.2 |
| D3 | 图片条目：**先缩略图（秒显、零读盘）→ 停住约 0.3s 再悄悄换成原图** | 第一目标「少碰盘」。连续切时 0 读盘，只有真正停下的那条读 1 次 |
| D4 | **定位 = 关预览 → 网格滚到那一格 → 描边闪一下**（1.2s） | 主人选定。描边复用「换封面」已选中那套手法（只改 `border-color` + `box-shadow`，都**不参与布局** ⇒ 6 列宽度算法不受影响，见 `index.vue` 的 `.image-box-item`）。颜色用 info 蓝而非绿 —— 绿在这个网格里已经是"已选中" |
| D5 | 名称 + 计数（`3 / 24`）显示在**工具条**上；名称取 `item.name`（与网格那行字逐字相同） | naive-ui 预览层没有可注入的标题栏（无 slot），工具条是唯一官方入口。名称逐字一致 = 两个视图里「同一条」看起来就是同一条 |
| D6 | 工具条布局：`[定位] [◀] [▶]  名称 · 3/24   ｜ 旋转×2 原始 缩小 放大 ✕` | 右侧 6 颗**一颗不动、✕ 仍在最右** —— 上次「下载」紧邻 ✕ 造成误触的教训（`index.vue` 的 `previewToolbar` 注释） |

键位：`← / →` = 上一条 / 下一条；`⏎` = 定位；`Esc` = 关闭（已有）。

## 二、为什么用 `n-image-group`，而不是自己造

naive-ui 2.45.3 **本来就带这套导航**，证据（均已实测核对过行号）：

- `node_modules/naive-ui/es/image/src/ImagePreview.mjs:78-100` `handleKeydown`：`ArrowLeft→onPrev`、`ArrowRight→onNext`、`ArrowUp/Down→zoomIn/zoomOut`、`Escape→close`、空格 `preventDefault`。⇒ **左右键白拿**；回车没人用 ⇒ 可安全征用。
- 同文件 `:521-539`：`renderToolbar` 拿到的 `nodes` 里**本来就有 `prev` / `next`**，只是默认工具条只在 `this.onPrev` 存在时才渲染它们 ⇒ 单张 `<n-image>` 给不了 `onPrev`。
- `ImageGroup.mjs:13-30` props：`srcList` / `current` / `show` / `renderToolbar` + `onUpdate:*` ⇒ **全受控**，且我们自己就知道「现在是第几条」= 定位所需。
- `ImageGroup.mjs:96-124`：`nextIndex/prevIndex` **跳过空 url** 并**首尾环绕**（wrap，无法关闭，接受）。

## 三、为什么是 `srcList` 模式（组必须无子节点）

两条实测事实把「把网格包进 group」这条路堵死了：

1. `Image.mjs:93-98`：**每个** `<n-image>` 都会 `registerImageUrl`，**与 `preview-disabled` 无关** ⇒ 集合会掺进「目录的脸」；而且顺序 = **Map 插入序 = 组件挂载序**，不由我们控制（列表局部更新/刷新后可能不等于显示序）。
   ⚠️ 本条推翻了我最初的假设：cover 模式下 `item.avatar` 是**活的**（只有 `avatar.jpg/cover.jpg`、没有其它图片的目录 → `handleCover` 返回 `null` 保持目录形态 → `index.ts:347-356` 给它挂 `avatar`）。所以「目录的脸」既会掺进序列、又不是死分支。
2. `Image.mjs:53-57`：`srcList` 模式下，任何 `<n-image>` 子节点调 `registerImageUrl` 都会 `throwError` ⇒ **组必须是空的、独立的一个节点**，与网格并列。

⇒ 集合由我们用 `srcList` 精确给出 ⇒ 索引 ↔ 条目的对应关系**是我们给的，不是在猜**（定位的判据必须落在事实上）。

## 四、代价：`previewedImgProps` 没了，要自己 `provide`

`ImagePreview.mjs:390-428` 与 `:550-564`：预览那张 `<img>` 的样式与 `onDblclick` 只从 `imageContext` 取，而 `imageContextKey` 是 `<n-image>` 自己 provide 的 —— **naive-ui 没给 group 留这个 prop**。组模式下 `inject` 找不到它（网格里的 n-image 是组的**子孙/兄弟**，不是祖先）⇒ 现有两件东西会掉：

- 「铺满视口」（`index.vue:337-365`，有 `docs/probes/preview-fill/` 实测）
- 「双击预览图 = 关预览 + 把这一下还给下面那张卡片」（`index.vue:368-395`，`docs/probes/popover-pick/` 实测）—— 多部组成的封面靠它弹出文件列表

补法：在 `index.vue` 里 `provide(imageContextKey, { previewedImgPropsRef: computed(...) })`，注入链：`ImagePreview ← ImageGroup ← … ← index.vue`（`ImageGroup.render()` 把 `ImagePreview` 渲染成自己的子节点，走 normal< 向上查找）。
- 合法前提：`naive-ui` 的 `package.json` **没有 `exports` 字段**（实测）⇒ 深路径 `naive-ui/es/image/src/interface.mjs` 可导入，旁边有 `interface.d.ts`。
- 备选（只解决样式）：全局 `.n-image-preview{width:100%;height:100%;object-fit:contain}` —— `derivePreviewStyle()` 只覆写 **inline** style，类规则不受影响；但**双击穿透没有替代**，所以最终仍走 provide。
- 附带收益：`previewedImgPropsRef` 变成 computed ⇒ **图标类条目可以不铺满**（给 `width/height: auto`，居中给原尺寸）。

## 五、改动清单（全部在 `src/views/FileFinder/index.vue`）

1. **加一个空的组节点**（与网格并列，永不进网格子树）
   `<n-image-group :src-list="previewSrcList" :current="previewIndex" :show="previewOpen" :render-toolbar="previewToolbar" @update:show @update:current />`
2. **网格 n-image**：`:preview-src` / `:previewed-img-props` / `:render-toolbar` 移交给组（成为死属性 → 删）；改为 `preview-disabled` + `class="can-preview"` + `:img-props="{ onClick: () => openPreview(item) }"`（`Image.mjs:99-102` 会把 `imgProps.onClick` 转发，语义与今天一致：**点图**才开，点文字不开）。
   ⚠️ `preview-disabled` 会让光标不再是 `pointer`（`styles/index.cssr.mjs` 里 `cNotM("preview-disabled","cursor:pointer")`）⇒ 补 1 行 CSS 恢复。
3. **状态**：唯一可写的是 `previewKey`（正在看哪一条）；`previewEntries` / `previewSrcList` / `previewIndex` / `previewOpen` / `previewFile` / `sharpKey` 全部**派生**。
   为什么不存索引：存索引等于把"列表不变"当前提。存 key ⇒ 条目没了索引算出来是 -1，预览层自己关（同 `currentPath → crumbs` 那套手法）。
4. **`previewedImgProps` 改成 computed**（图标类条目给 128px 高、`width:auto`；其余 `100% × 100% + contain`），并**由本组件 `provide` 进 `imageContextKey`**（组渲染出的 ImagePreview 从 context 读它）。
5. **工具条**：`[定位, …(total>1 ? [prev, next] : []), 名称, …(total>1 ? [计数] : []), …原有 6 颗]`。
6. **定位**：关预览 → 按 `:data-key` 找到那一格（**不拼 CSS 选择器**，目录名里什么字符都可能有）→ `scrollIntoView({ block:'center', behavior:'smooth' })` → 加 `.located` 1.2s。
7. **缩略图→原图**：停住计时（300ms）→ `new Image()` 预载 → `onload` 才换 src（预载失败就停在缩略图上，不报错）。
8. **键位**：`← / →` 白拿 naive-ui 自带的 keydown；`⏎` 加在**已有的** `onKeyup`（网格那层唯一的单键入口）里，并**短路** `S/D/Backspace/F5` —— 理由与「换封面」模式那条同族（预览层盖着网格时那些键打的是背后那一屏）。
9. **类型声明**：`src/env.d.ts` 里加 `declare module 'naive-ui/es/image/src/interface.mjs'`（同文件里 `@ffprobe-installer/ffprobe` 那个先例）。

## 六、读盘清单（硬约束 #3）

| 动作 | 读盘 |
|---|---|
| 新增扫盘 / 后台任务 | **0** |
| 上一条 / 下一条（连续切） | **0**（缩略图走 `/thumb`，主进程内存 + `immutable` 缓存；`index.ts:901-919`） |
| 停在某条图片上（约 0.3s 后） | **1 次 `/raw`**（现状是「点开 1 次」，量级相同；只发生在**图片**条目） |
| 视频 / 目录条目 | **0**（视频的图本来就是抽帧） |

## 七、已知边界（知情选择）

1. 深路径导入 naive-ui 内部文件：版本升级会断。当前 pin `2.45.3`，且无 `exports` 限制。
   ⚠️ 路径**必须带 `.mjs`**：本项目 `resolve.extensions = ['.ts','.vue','.js']` ⇒ 不带扩展名连 dev 都解析不了（构建实测报 "Rollup failed to resolve"）。
2. 环绕（wrap）关不掉：末条按 → 回到第 1 条。用计数（`3 / 24`）兜住认知。
3. 缩略图抽不出来的条目（约 0.5%）：url 为空 ⇒ **不进序列**（naive-ui 的上一张/下一张天然跳过空 url）。这是**现状的同类行为**，本轮不改。
4. 名称对「封面条目」而言是**封面图的名字**（`index.ts:495` `getFilename(file)`）—— 与网格那行字一致，不是片的标题。若观感不对，下轮单独议。
5. 唯一的一条**观感小损**：预览不再"从缩略图位置放大出来"（`syncTransformOrigin` 要 naive-ui 的 `setThumbnailEl`，srcList 模式下拿不到那个入口）⇒ 现在是居中淡入。刻意不修：为它去够组内部暴露的 `previewInstRef` 不划算。
6. 只做了一层网格的序列：预览里**不跨越**目录层级（不进子目录、不回到上一层）。

## 八、动手前自查（改动前的对抗式复核，抓出 4 处）

1. **`item.avatar` 不是死分支** —— 我最初以为「目录的脸」只在 folder 模式出现。查 `index.ts:317-356`：cover 模式下，子目录若只有 `avatar.jpg/cover.jpg`（没有别的图片 + 没有子目录）⇒ `handleCover` 返回 `null` 保持目录形态，并给它挂 `avatar`。⇒ 若走「把网格包进 group」那条路，这些**活着的**脸会掺进上一张/下一张。这是改用 `srcList`（集合由我们给）的决定性理由。
2. **图标资产：从"复活"改成"不碰"** —— 原设计打算用 `assets/fileTypeIcon/<ext>.svg` 给非图片文件配图标。查 `docs/VERDICT-2026-10-03.md:74` 与 `CLEANUP-AUDIT`：`useFileTypeIcon.ts` + 16 个 svg 是**已确认可删**的清理项 ⇒ 复活它们等于推翻一个已定的清理决定。改成：非图片文件**不进序列**（网格里它们用 `file-icon-vectors` 的字体图标，塞不进 `<img>`；而且它们今天本来也没有"点开"的入口）。⇒ 少写代码、不与清理项打架。
3. **索引脱钩** —— 原设计存 `previewIndex`。列表一变就可能指向别的条目 ⇒ 改成存 `previewKey`、索引全派生（见 §五.3）。
4. **预览开着时 `S/D/Backspace/F5` 会打在背后那一屏**（F5 还会换掉列表，让预览序列跟着变）⇒ 在 `onKeyup` 里短路，沿用「换封面」模式那条现成规则。

另：`previewToolbar` 里的名称/计数**必须用内联样式** —— 那块 DOM 由 naive-ui 渲染并 teleport 到 body，本组件的 `<style scoped>` 够不到它。

## 九、已实测 / 待目视

**已实测**（`docs/probes/preview-nav/`，真 Chromium，9 条断言全过）
- 空节点 group 能显示预览、整页只有一个预览层；`provide` 的内部键**真的喂到了**那张 img（`inlineStyle: width/height 100% + contain`）
- `← / →` 换张且与索引逐字节对上；首条往左**环绕**到最后一条；关闭后**没有残留监听**
- `nodes.prev / .next` 排进我们自排的数组里仍可点；名称/计数跟着索引走（`名称-1` + `2 / 3`）
- `srcList` 同位置换图（缩略图→原图）**不漂移**；图标条目 `152×128`（不铺满）
- ⚠️ 顺带抓到并修掉一个**既有缺陷**：预览图双击会被处理**两次**（卡片被 dispatch 两次 dblclick ⇒ 进子目录压两条历史、双击视频开两次播放器）。A/B 实测：不守卫 2 次 / 守卫 1 次 / 下一次双击仍生效。详见探针 README。

**待主人真机目视**（无头测不到的部分）
- 定位的实际滚动落点与描边闪现（依赖真实网格）
- 名称在工具条里的排版（长名字是否会挤压计数）、目录 128px 图标的观感
- 停住 0.3s 后"缩略图 → 原图"的观感（是否觉得闪/慢）
- ⏎ 与网格那套单键是否互不干扰

**验收方式**：这是渲染层改动 ⇒ 重启 dev 后直接看；**不用重扫盘**（没碰扫描/缓存逻辑）。
