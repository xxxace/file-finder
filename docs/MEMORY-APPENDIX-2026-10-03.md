# file-finder 记忆附录 · 血泪规则全文（2026-10-03 从 MEMORY.md 迁出）

> 迁出原因：`MEMORY.md` 超 ~10KB 会被注入截断 ⇒ 细节搬到这里，索引只留一行指针。
> 本文件与 `MEMORY.md` 配套；`MEMORY.md` 里的编号（§九/§十一/§十二）指向本文对应端。

---

## 九、实测事实（错了会误导）

1. 验证**先放"已知存在 ID"当控制组**（验 FC2 曾拿 javbus → 假阴性）。javbus 不收 FC2，5 站仅 javdock 收；freejavbt 详情需 `/en/`。
2. unmatched 里 **46% 是目录** ⇒ 维持现状，别再提拆桶（他否决）。
3. **缓存库**：读库**必须跳过 `$$indexCreated`**；死行 0；库全是真内容 ⇒ **「压缩库瘦身」是伪需求**。
4. `DriveInfo.label` **从来没被赋值**（`probe()` 写死 `''`）⇒ 已用「离线(序列号后4位)」绕过。
5. **收敛条目的 size = 该子目录所有文件之和**；**双算 = 0**；内存聚合 0.07 ms ⇒ **面板做聚合零新增磁盘 I/O**（nedb 全库常驻内存）。
6. `parseSize` 曾把 TB 截断（`% 1024`）⇒ 已由 `formatBytes` 取代。
7. `HistoryTable` 换每页条数**不重置页码** ⇒ 会翻到空白页。
8. 缓存记录入口原为无文字无 tooltip 的脚印图标；旁边 `n-badge` 是"当前目录条目数"却**像它的角标**。
   ⇒ **2026-10-02 已挪到面包屑当前段**，此问题解决；工具条少 26px，640px 下导航区 189→224px。
9. **本机主屏 = 逻辑 2048×1280**（物理 2560×1600 @1.25），可用区 2048×1232 ⇒
   `screen.getPrimaryDisplay()` 给的是**逻辑值**，按物理分辨率心算会全错（探针 `probes/win-size/`）。
10. **`minWidth` 不是脑补约束**：实测 640/800 下 `.nav-zone` 会裁内容（既有局限），1024 是崩坏线之上的第一档。
11. **网格 = 一行 6 个**：item 是"margin 撑间距 + `width: 100%/6 − 10px` 补偿回来"的算法（每格恰好占 100%/6）。
    ⇒ 容器边缘也被吃掉 5px，**用 `.image-box` 负 margin 5px 抵消**才对得齐头部。
    ⚠️ 别换 `gap`（要重算 5 个断点的 `--item-width`）、别用 `nth-child` 删首尾 margin（会算错且窄窗失效）。
    ⚠️ item 有 5 个响应式断点（≤600→5 列…），但 `minWidth 1024` ⇒ 实际触不到。见 `CHANGES-2026-10-02.md` §五。
12. **Windows 上 `fs.stat()` 对目录返回 size = 0** ⇒ 网格里 `type:'folder'` 的条目 size 恒 0、title 显示 `—`。
    收敛成封面的条目反而有大小（`handleCover` 遍历累加）。⇒ 目录大小**没有系统调用能直接给**，只能自己算；
    唯一不读盘的路 = **缓存库子树求和**（实测中位 0.84 ms、子文件夹命中率 99%）。`relPath` 分隔符实测是 **`/`**。
    **✅ 2026-10-02 已实现**：`nedb.ts` 的 `loadSubtreeBytes` + 纯函数 `mergeSubtreeBytes`；
    **落点是 `wire()`（下发态唯一出口），不是 `readFolder`** —— 见 §十一.4 的教训。
    查表键要用 `diskNameOf()`（拼回 ext），不能用削过的 `item.name`。
    见 `docs/CHANGES-2026-10-02.md` §六 · `docs/ANALYSIS-folder-size-2026-10-02.md` · `probes/folder-size/verify.mjs`（17/17）。
13. **本机没有任何 SVG 光栅化器**（`sharp`/`@resvg/resvg-js`/`canvas`/`jimp`/`cairosvg`/`Pillow`/ImageMagick 全无；
    `/c/Windows/system32/convert` 是 NTFS 那个 convert.exe）⇒ 要光栅化就走**无头 Electron**（先例 `probes/header-width/`）。
    图标那条路额外两条：**必须 `force-device-scale-factor=1`**（本机 1.25 缩放，否则"32px"变 40px）、
    **别提前 `win.destroy()`**（没注册 `window-all-closed` 时会直接开始退出，后续 `loadFile` 报 `ERR_FAILED (-2)`）。见 `probes/icon-render/`。

---

## 十一、已验证写法（别重新踩）

1. **DataTable `render()` 生成的节点，`<style scoped>` 匹配不到** ⇒ 用不带 scoped 的 `<style>` + 外层类名前缀。先例 `HistoryTable/index.vue` 末尾。
2. 并发别用 `if (loading) return` 守卫 ⇒ 用**请求序号** `const my=++seq; if(my!==seq) return;`。
3. `n-input` **吃掉 composition 事件** ⇒ 外面套一层普通 div 接（会冒泡）。
4. **改「下发/输出」类逻辑前，先找"唯一出口"**：本项目已立了三个 ——
   `wire()`（唯一下发出口）· `apiUrl()`（唯一 URL 出口）· `route()`（HTTP 咽喉点）。
   注释里写着"所有路径都必须过这里"的那个函数，**就是正确的落点**。
   ⚠️ **补展示字段只在下发态做，绝不在存储态**：`readFolder` 的返回值会经 `scanAndCache`
   **写进库**，在那补会让 `bytes`（= Σ `data[].size`）**双算**、面板大小列整体失真。
   **2026-10-02 亲历**：把"文件夹 size 聚合"补在 `readFolder` ⇒ 浏览已缓存目录
   （走 `findCache` 短路、**不经过 `readFolder`**）完全看不到，用户实测打回。
   ⇒ 教训：**验收要覆盖用户的真实操作路径**，不是我自己顺手那条；
   15/15 全绿也可能**一条都没碰到**真正的那条路。
5. **布局类坑**（表头吸顶 / 弹窗内只有表格滚 / 小窗口下 flex 子项被挤压）**正文已搬 `docs/LAYOUT-GOTCHAS.md`** ——
   太长，留在这里会把注入上限撑爆。改"容器/滚动/flex"之前先读它。

---

## 十二、两条自检问句（血泪换来）

1. **判据落在"事实"还是"快照"上？** 曾用 `path.startsWith('#')`（地址形态=历史快照）判"能不能打开" ⇒ 盘插回来也**永久打不开**。正解：`/resolveAnchor` 在**动作那一刻**问服务端。
   ⚠️ 2026-09-30 一天内**再犯两次**（`v-if="dir"` 控制返回按钮、`emptyTip` 判 `dir`）⇒ **改任何 UI 条件前先过这一问**。
2. **这个尺寸/行数，是常量还是用户数据的函数？**（**高度**）无界内容（路径 + 面包屑）包在 `flex-wrap` 容器里 ⇒ 高度成了用户数据的函数。正解：容器 `nowrap` + `min-width:0`；内部按**层数折叠**（保首尾、当前层永远可见）+ 单条 `max-width` + ellipsis。
   ⚠️ **紧接着问第二句：固定那一侧之后，另一侧还剩多少？**（**宽度**）10-01 实测：工具条收进「更多」后 **405px**（原 605），导航区 **188/341/616/936**（640/800/1280/1920）；而**改造前 640/800 是"头部变高 196px 且工具条仍然溢出"** ⇒ 分区＋收纳把两件事一起修好了。**给窄容器定"谁让路"前，先量出固定那一侧的预算。**
   详见 `docs/DESIGN-HEADER` §18；探针 `docs/probes/header-width/`（真 Chromium + **真编译 scoped CSS**，量头部高/导航区宽/工具条预算）。
