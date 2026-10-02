# file-finder 备忘（索引）

> 细节在 `docs/`。本文件只留**铁律 + 当前状态 + 关键决策**。
> ⚠️ 超 ~10KB 注入时会被**截断** ⇒ 新增内容写 `docs/`，这里最多加一行索引。

## 一、最高优先级
**减少对移动硬盘的读写。** 冲突时以此为准。涉及扫盘的方案必须附**读盘清单**。

## 二、协作（他 ADHD + 阅读障碍）
- 正文 **≤10 行** + 优先**一张图** + 需他做的动作一行；过程/根因/数据落 `docs/`
- 问「还有哪些没做」→ **只给剩余清单**，不复盘
- 问「X 能不能/有没有/怎么用」= **认知需求**（讲机制 + 给可自跑的实验），结尾**不许**加"要我执行吗"
- 有**成本梯度**时先摆**成本阶梯**让他选，别替他把最完整那版做完
- 改主进程 ⇒ **重启 dev**；改扫描逻辑 ⇒ 按**刷新（↻）**重建那条缓存

## 三、铁律
1. **特性默认神圣**：他声明过的便捷设计不动；判断真有问题才**提交讨论**，通过才改。
2. 其余问题：多视角交叉验证 + 确认没理解错 + 确认真要修 → **用正确的方式修，不许打补丁**（判据=同类场景还会不会复发）。**必须标证据等级**（静态/推理/实测），未实测就写"未实测"。
3. `grep` 计数不能证"运行时渲染出一份"。
4. 不在 `n-space` 放**会增减**的子元素（2.45.3 每个 key 都是 `1`）⇒ 用裸 flex `.hstack`。
5. 缓存层**永不自动删**；`wire()` 唯一出口；`CACHE_VERSION=2` 非必要不升；`CACHE_KEY`/`CACHE_IV` **永不可改**。
6. **脱敏仓库**（`github.com/xxxace/file-finder`，`fff69a0` 立标准）：入库文本**不许**出现真实番号/演员名/作品名/真机目录文件名/站点流水号/盘序列号/用户名。占位：`TST-xxx`、`示例演员A…H`、`示例作品标题`、`D:/sample/videos/…`（番号保留格式族，让解析示例仍成立）。
   ⚠️ **写"我脱敏了"的复盘时最易复发**——只写类别与占位风格，**别抄原值**。手法见 skill `desensitize-audit`。
   ⚠️ **遗留未清（等他定）**：`HEAD` 里 12 个文件含真实标识、**都不是当轮新增**（最重 `PRD-manager-assistant-2026-09-25.md`、`CODE-REVIEW.md`）。改工作区只让"以后"干净；真要清得改历史+强推。**不擅动别的会话的文档。**

## 四、文档索引
- 开工先读：`docs/PROJECT-MEMO-2026-09-24.md`（契约/特性/缓存全文）· `docs/DESIGN-CONVERGED-2026-09-24.md` §六 · `docs/UX-DESIGN-INPUT-2026-09-24.md`（**§二事实不许推翻 / §四神圣清单 / 硬要求**）
- 角色产出：`docs/DESIGN-UIUX-2026-09-24.md` · `docs/DESIGN-PM-2026-09-24.md`
- 管理助手：`docs/PRD-manager-assistant-2026-09-25.md`（权威）+ 同名 `DESIGN-` / `KICKOFF-`
- 缓存面板：`docs/DESIGN-CACHE-PANEL-2026-09-30.md` · `docs/PLAN-cache-panel-2026-09-30.md` · `docs/cache-panel-mockup-2026-09-30.html`
- 头部/面包屑：`DESIGN-HEADER-2026-09-30.md`（§18 工具条预算 / 分隔符 / 截图）+ `DESIGN-NAV-2026-09-30.md`（§12 四问自查）+ `PLAN-nav-header-2026-10-01.md`（三阶段 + §十一 实施结果）—— **已落地，待真机目视**；探针 `probes/header-width/`（真 Chromium + 真编译 scoped CSS + **截图**）· `probes/crumbs/`
- **2026-10-02 四条小改动**：`docs/CHANGES-2026-10-02.md`（窗口 1280×860 + min 1024×640 / 右键加「去后缀」/ 角标挪面包屑当前段 / 标题 File Finder）＋ §五（网格左右贴边＝`.image-box` 负 margin）＋ §六（**文件夹 size 用缓存聚合，零读盘**）；新增探针 `probes/win-size/` `probes/grid-6col/` `probes/folder-size/`
- **文件夹 size 分析原文（已落地）**：`docs/ANALYSIS-folder-size-2026-10-02.md`
- **应用图标（2026-10-02 续）**：`docs/CHANGES-2026-10-02.md` §七 → 源 `build/icon.svg`，产出 `build/icon.ico`(七档)+`build/icon.png`+`public/favicon.ico`；生成脚本/证据/目视页 `docs/probes/icon-render/`
- 探针 `docs/probes/`：`scan-real/` `parse-title/` `table-scroll/` `preview-fill/` `remove-race/` `cache-panel-*` `header-width/` `crumbs/` `win-size/` `grid-6col/` `icon-render/`；skill：`electron-headless-verify` · `real-module-probe` · `ui-render-verify` · `headless-rasterize`
  ⚠️ **探针的媒体查询盲区**：`@media (max-width)` 看的是 **viewport** ⇒ 改 `#stage.style.width` **不触发断点**。要测响应式必须 `win.setSize()`。
- **没有测试框架**（`package.json` 只有 dev/typecheck/build）⇒ 验证固定三件套：`typecheck` 0 error + `docs/probes/` 只读探针 + 真机目视。**别写 TDD 式假测试**。
- 探针证据**必须 `.txt`**（`.gitignore` 挡 `*.log`，否则文档引用变死链）。

## 五、当前状态（2026-10-02）
- **10-02 文件夹显示大小（改了服务端 ⇒ 待重启 dev）**：用缓存库**子树聚合**补 `type:'folder'` 的 `size`，**零读盘**；前端 0 行；`verify.mjs` 17/17（含针对"缓存命中路径"的端到端 ⑥ 段）。详见 `CHANGES-2026-10-02.md` §六
- **10-02 四条（改了主进程 ⇒ 待重启 dev 后真机目视）**：窗口 `1280×860` + `minWidth/minHeight 1024×640` · 右键菜单加「复制文件名（去后缀）」（**加法，原含扩展名那项未动**）· 条目数角标挪到**面包屑当前段**（`::after`+`attr()`，不新增 DOM 子元素）· 标题 `File Finder`。详见 `docs/CHANGES-2026-10-02.md`
- **已落地并提交**：缓存面板 A/B/C（详情见 `DESIGN-CACHE-PANEL` / `PLAN-cache-panel`，**故意不做**：chips 换下拉 / 盘改名 / 上下键选行）· P0+P1+P2 · 加密备份还原合并 · 离线只读浏览（界面待目视）· **头部+导航改造**（分区/折叠/绝对链 + 工具条收进「更多」+ 根 chip 图标化，§四索引，待真机目视）· 管理助手 Phase 1+2A+5（真机部分通过 scan 23/25，**未全验**）
- 缓存库基线：`5 盘 · 213 目录 · 1247 条目 · 3.35 TB · 库 81.7 MB`
- n-space 重复 key 已修；`.toolbar{flex-wrap:nowrap}` + `.header-bar .n-input{width:200px}` **两条不许删**
- 视频扩展名单一真相源 `electron/server/videoExt.ts`；改它要同步 `index.vue` 的 `VIDEO_EXT_RE` 并重启 dev
- **图标已接好，但 exe 里的图标未实测**：`electron-builder.json5` 原本**没有 `icon` 字段**（打包用 Electron 默认图标），现已补 `win.icon`/`mac.icon`；窗口图标走 `public/favicon.ico`（`main/index.ts:57` 与 `index.html:5` 未动）。16/24 档镜片内网格糊（等主人定要不要出"简化标记"版）

## 六、待他动作
重启 dev · 跑 PRD §15/§16 真机自测 · 目视验收离线只读层 · **真机回归导航**（选根/下钻/返回/刷新/批量扫描 + 缓存跳转→返回，见 `PLAN-nav-header` §十一）· `ffprobe` 超时回收（泄漏实测成立）· **`npm install`**（`node_modules` 里 `app-builder-bin` 只剩 npm 暂存目录 `.app-builder-bin-YaNL61c1` ⇒ `require.resolve` MODULE_NOT_FOUND ⇒ 现在打包必失败，与图标无关）

## 七、暂缓
视觉去重/以图搜图 **砍掉**；盘舰队看板、常驻增量索引 **短期不做**；走「功能完善」路线。

## 八、管理助手（active，只做 JAV）
- 隐藏 BrowserWindow 抓取（不引 puppeteer/cheerio）；站点规则=JSON 候选链；默认只写封面文件；接口走 `route()` 加 `/assistant/*`；UI=全屏 `n-modal`（浅色）。apply 后**必须 `removeCache` 失效**；目标目录 `tmp→rename` 原子写 + `apply.log` + 回滚
- `cf_clearance` 绑 IP+UA+TLS ⇒ **不能**走 Node `fetch`，全程 Chromium 网络栈
- `avatar.jpg` / `cover.jpg` 是**保留名，助手永不写**；有它们 UI 自动当目录脸
- 线索降级链：解析出番号 → 站点抓封面；认不出 → **视频抽帧**；都不行 → 手动 URL。**禁止**对"认不出"自动乱搜（=误配）
- `parseTitle` = 有序候选链（FC2 排前；连写无分隔**一律不识别**）；**容器判断先于条目判断**
- ⚠️ `route()` 精确匹配 pathname ⇒ 不支持 `/:id`，任务 id 走 `?id=`
- ⚠️ 隐藏窗使 `window-all-closed` 永不触发 ⇒ 加 `win.on('closed', destroyTrackedWindows)`
- 站点：`freejavbt` / `javwine` / `javbus` / `javdock` / `onejav` + `javtext.net`，均无账号

## 九、实测事实（错了会误导）
1. 验证**先放"已知存在 ID"当控制组**（验 FC2 曾拿 javbus → 假阴性）。javbus 不收 FC2，5 站仅 javdock 收；freejavbt 详情需 `/en/`。
2. unmatched 里 **46% 是目录** ⇒ 维持现状，别再提拆桶（他否决）。
3. **缓存库**：215 行 = 213 记录 + 2 行 `$$indexCreated`；死行 0；81.7 MB 全是真内容 ⇒ **「压缩库瘦身」是伪需求**。⚠️ 读库**必须跳过 `$$indexCreated`**。
4. `DriveInfo.label` **从来没被赋值**（`probe()` 写死 `''`）⇒ 已用「离线(序列号后4位)」绕过。
5. **收敛条目的 size = 该子目录所有文件之和**；**双算 = 0**；内存聚合 0.07 ms ⇒ **面板做聚合零新增磁盘 I/O**（nedb 全库常驻内存）。
6. `parseSize` 曾把 TB 截断（`% 1024`）⇒ 已由 `formatBytes` 取代。
7. `HistoryTable` 换每页条数**不重置页码** ⇒ 会翻到空白页。
8. 缓存记录入口原为无文字无 tooltip 的脚印图标；旁边 `n-badge` 是"当前目录条目数"却**像它的角标**。
   ⇒ **2026-10-02 已挪到面包屑当前段**，此问题解决；工具条少 26px，640px 下导航区 189→224px。
9. **本机主屏 = 逻辑 2048×1280**（物理 2560×1600 @1.25），可用区 2048×1232 ⇒
   `screen.getPrimaryDisplay()` 给的是**逻辑值**，按物理分辨率心算会全错（探针 `probes/win-size/`）。
10. **`minWidth` 不是脑补约束**：实测 640/800 下 `.nav-zone` 会裁内容（既有局限），1024 是崩坏线之上的第一档。
11. **网格 = 一行 6 个**：item 是"margin 撑间距 + `width: 100%/6 − 10px` 补偿回来"的算法
    （每格恰好占 100%/6）。⇒ 容器边缘也被吃掉 5px，**用 `.image-box` 负 margin 5px 抵消**才对得齐头部。
    ⚠️ 别换 `gap`（要重算 5 个断点的 `--item-width`）、别用 `nth-child` 删首尾 margin（会算错且窄窗失效）。
    ⚠️ item 有 5 个响应式断点（≤600→5 列…），但 `minWidth 1024` ⇒ 实际触不到。见 `CHANGES-2026-10-02.md` §五
12. **Windows 上 `fs.stat()` 对目录返回 size = 0** ⇒ 网格里 `type:'folder'` 的条目 size 恒 0、title 显示 `—`。
    收敛成封面的条目反而有大小（`handleCover` 遍历累加）。⇒ 目录大小**没有系统调用能直接给**，只能自己算；
    唯一不读盘的路 = **缓存库子树求和**（实测中位 0.84 ms、子文件夹命中率 99%）。`relPath` 分隔符实测是 **`/`**。
    **✅ 2026-10-02 已实现**：`nedb.ts` 的 `loadSubtreeBytes` + 纯函数 `mergeSubtreeBytes`；
    **落点是 `wire()`（下发态唯一出口），不是 `readFolder`** —— 见下面 §十一.5 的教训。
    查表键要用 `diskNameOf()`（拼回 ext），不能用削过的 `item.name`。
    见 `docs/CHANGES-2026-10-02.md` §六 · 分析 `docs/ANALYSIS-folder-size-2026-10-02.md` · 验证 `probes/folder-size/verify.mjs`（17/17）
13. **本机没有任何 SVG 光栅化器**（`sharp`/`@resvg/resvg-js`/`canvas`/`jimp`/`cairosvg`/`Pillow`/ImageMagick 全无；`/c/Windows/system32/convert` 是 NTFS 那个 convert.exe）⇒
    要光栅化就走**无头 Electron**（先例 `probes/header-width/`）。图标那条路额外两条：**必须 `force-device-scale-factor=1`**（本机 1.25 缩放，否则"32px"变 40px）、
    **别提前 `win.destroy()`**（没注册 `window-all-closed` 时会直接开始退出，后续 `loadFile` 报 `ERR_FAILED (-2)`）。见 `probes/icon-render/`

## 十、五条硬约束（他原话，跨会话）
1. **不加「操作」列** —— 打开固定为**双击**；可发现性不许靠加列解决。
2. **不要读盘** —— 统计必须是**纯内存汇总**。
3. **尽量不加扫盘功能**；若有**必须主动告诉他**（⇒ 每轮方案附读盘清单）。
4. 交付前自查：**自洽 / 有没有误解 / 有没有把握**（未实测必须标出）。
5. **不允许手动输入 / 编辑路径**（2026-09-30）—— 路径只能由"点击 / 选择"产生；"可编辑地址栏"这类双模式一概不做。

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
5. **布局类坑**（表头吸顶 / 弹窗内只有表格滚 / 小窗口下 flex 子项被挤压）**正文搬到 `docs/LAYOUT-GOTCHAS.md`** ——
   太长，留在这里会把注入上限撑爆。改"容器/滚动/flex"之前先读它。

## 十二、两条自检问句（血泪换来）
1. **判据落在"事实"还是"快照"上？** 曾用 `path.startsWith('#')`（地址形态=历史快照）判"能不能打开" ⇒ 盘插回来也**永久打不开**。正解：`/resolveAnchor` 在**动作那一刻**问服务端。
   ⚠️ 2026-09-30 一天内**再犯两次**（`v-if="dir"` 控制返回按钮、`emptyTip` 判 `dir`）⇒ **改任何 UI 条件前先过这一问**。
2. **这个尺寸/行数，是常量还是用户数据的函数？**（**高度**）无界内容（路径 + 面包屑）包在 `flex-wrap` 容器里 ⇒ 高度成了用户数据的函数。正解：容器 `nowrap` + `min-width:0`；内部按**层数折叠**（保首尾、当前层永远可见）+ 单条 `max-width` + ellipsis。
   ⚠️ **紧接着问第二句：固定那一侧之后，另一侧还剩多少？**（**宽度**）10-01 实测：工具条收进「更多」后 **405px**（原 605），导航区 **188/341/616/936**（640/800/1280/1920）；而**改造前 640/800 是"头部变高 196px 且工具条仍然溢出"** ⇒ 分区＋收纳把两件事一起修好了。**给窄容器定"谁让路"前，先量出固定那一侧的预算。**
   详见 `docs/DESIGN-HEADER` §18；探针 `docs/probes/header-width/`（真 Chromium + **真编译 scoped CSS**，量头部高/导航区宽/工具条预算）。
