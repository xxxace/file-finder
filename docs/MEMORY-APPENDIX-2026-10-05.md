# MEMORY-APPENDIX-2026-10-05 · §四/§五 全文（从 MEMORY.md 迁出）

> 由 `MEMORY.md` §四·§五 指向这里。**MEMORY.md 已严重超注入上限（18.7KB，实测被截断）**，
> 本次（2026-10-05）把「探针入库细则」与「当前状态长清单」全文迁到此文件，MEMORY 只留摘要。
> ⚠️ 以后新增细节**直接写这里或对应 docs/**，别往 MEMORY.md 加。
> 其余附录：`MEMORY-APPENDIX-2026-10-03.md`（§九/§十一/§十二）、`MEMORY-APPENDIX-2026-10-04.md`（§十三 注释纪律）。

---

## 一、探针入库细则（原 §四 末段，防膨胀 + 真实踩坑）

⚠️ **探针入库判据（防膨胀）**：**结论进文档；脚本默认一次性**。只有
① 会被**反复重跑**的断言 或 ② **重建成本高**的工具（无头 Electron / 真编译 CSS / PE·JPEG 二进制解析）才留。
`docs/probes/` 现 **30 目录 / 180 文件 / 1.7MB**，估 **≈1/5 有留价值**（清理是独立一件事，尚未做）。

⚠️ **构建产物必须精确挡**（2026-10-04 补）：`.gitignore` 加 `docs/probes/*/bundle*.cjs`
—— ⚠️ **绝不能用 `*.cjs`**（探针源码本身就是 `.cjs`）；vite 的 `dist` 已被通用规则挡。
探针的**中转产物**（如 zip 路径文件）要写进 `os.tmpdir()`，别落探针目录 —— 靠 ignore 兜底不如根本别落进去。

⚠️ **CJS bundle 是全量求值的**：`--external:electron` 只把 `require('electron')` 留成外部调用，
纯 node 跑到它照样抛 `Cannot find module 'electron'` ⇒ 含 `nativeImage` 的模块要**独立 entry**（合并过一次，`read` 段直接挂）。

⚠️ `run.sh` 里的 `env -u ELECTRON_RUN_AS_NODE` 是**真知识不是胶水**
（漏了就退化成纯 Node、不跑窗口；**重复 8 份，应收成 1 个共享 runner**）。

⚠️ **改 naive-ui 定位属性时连带清 `transform`**（2026-10-04 抓到）：
`left:50% + translateX(-50%)` 改成 `left:0;right:0` 后不一起去掉 transform ⇒ 整条左移半屏，
**静态读 CSS 看不出来，只有真排版现形**。同理：被 teleport 到 body 的 DOM **`<style scoped>` 够不到**
⇒ 要非 scoped 块 + **前缀多一层祖先**（cssr 是运行时注入的单类选择器，同特异性先后不可控；
加祖先成 (0,2,1) 对 (0,1,0) ⇒ 不必写 `!important`）。

---

## 二、当前状态长清单（原 §五 全文）

> 头部结论（2026-10-03，详见 `VERDICT-2026-10-03.md` 第四版）

### 2.1 增量对账 Q1 已落地
⭐ **2026-10-03 23:40 增量对账（Q1）已落地** —— `electron/server/index.ts` 9 处、约 25 行，零入口/零前端改动；
探针 `docs/probes/reconcile/` **13 PASS / 0 FAIL**（再扫一次 0 抽帧、新增只抽 1 张、删除 0 抽帧）。
闸门**只加在唯一读取点 `readFolder`**，三条抽帧路径（文件 / 目录的脸 / 收敛封面）共用同一判据。
⇒ **待主人重启 dev 目视**（`wire()` 在下发路径，探针够不到）。方案见 `docs/IMPLEMENT-reconcile-2026-10-03.md`。

### 2.2 唯一真缺口 = 全局搜索
`index.vue:466` `filterByName` 只过滤当前层；`data[].name` **1471/1471 全在内存**（`nedb.ts:229`）
⇒ 纯前端可搜、零读盘（**投影**下发即可；**绝不能下发原始 `data[]`**，会冻界面）。
⚠️ **10-03 实测**：投影 `{name,dir,size,type,serial}` = **163 KB**（原文 ~100KB）；原始 `data[]` = **69.0 MB**
（原文 78MB，疑取自根目录备份文件）。见 `probes/handover-audit/`。

### 2.3 已完成 / 伪缺口 / 漏项
- **exe 图标早已完成**（10-02 22:50 打包）；10-03 真 PE 解析器复核：两个 exe 各 **7 条 RT_ICON**、PNG 尺寸恰 16/24/32/48/64/128/256。
- **伪缺口**：`create_at` 刷新年龄（`HistoryTable:317` 已可排序列）；抽帧失败率 0.5%；**ffprobe 泄漏已修**（`BATCH2-ffprobe` §七）。
- **性价比最高漏项**：cover-blur A 档（`scan.ts` 的 `e.avatar` 放宽成"脸够不够大"）。
  ⚠️ **10-03 实测**：真收益 = **113 个目录**（cover 模式 114 − 1 分类目录）；**116 是统计口径错**（含 2 条非 cover、scanner 不读）。
  判据 `:263`+`:472`（不是 238）；**"抽共享函数"待复核**——第三处 `:632`（换封面）用同一谓词的反向。
- **该删 7 项**（曾 8，撤回 `parseSize`）；4 项有连带（`printTree`→`interface file`/`getSpace()`/`level_stack`；注释块→`index.vue:65-67`；`getFileTree`→`index.ts:419-427`）。❌ **`flexible.ts` 绝不能删**。
- 根目录 `searchCache.db` = **主人主动备份**（09-24·78.6MB，已过期）⇒ 保留；真库在 `%USERPROFILE%\.file-finder\`（10-02·92MB）。基线 `5 盘 · 218 记录(216 cover) · 1471 条目`。
- 视频扩展名单一真相源 `electron/server/videoExt.ts`；改它要同步 `index.vue` 的 `VIDEO_EXT_RE` 并重启 dev。

### 2.4 各期已落地 + 待目视（原文照录）
- **已落地**：面板 A/B/C · P0+P1+P2 · 加密备份还原 · 离线只读浏览(待目视) · 头部+导航(待目视) · 助手 Phase1+2A+5(未全验) ·
  **缓存面板盘筛选 下拉→盘条 chips**（2026-10-04，见 `docs/DESIGN-DISK-FILTER-2026-10-04.md`；只显示有缓存的盘 + `stats.disks` 同改 + 「打开存放文件夹」移入「备份与迁移」；`n-tooltip` 真机观感待目视）·
  **预览层 上一条/下一条 + 定位到网格**（2026-10-04，见 `docs/DESIGN-PREVIEW-NAV-2026-10-04.md`；`n-image-group` srcList 模式 + `provide(imageContextKey)`；探针 `docs/probes/preview-nav/` 9 断言全过；顺手修掉"预览图双击被处理两次"的既有缺陷）。
- **待重启 dev 后目视**：文件夹 size · 预览抢点击 · 四条（窗口/右键去后缀/角标/标题）· 盘条 chip 悬浮提示 · 预览层定位与名称排版 · 网格 384 观感/停住换清晰的手感/离线看大图/zip 备份还原。
- **2026-10-04 已落地**：**缓存大图 + 缩略图出库**（`docs/DESIGN-PREVIEW-CACHE-2026-10-04.md`；探针 `probes/thumb-tier`、`probes/bin-migrate`）。

### 2.5 2026-10-05 已落地：多文件弹层重做 + 返回后滚动串屏修复
见 `docs/FIX-2026-10-05-popup-and-scroll.md`；探针 `probes/popup-visual/`。
- ⚠️ 弹层丑的根因＝**网格的 CSS 漏进弹层**（`.image-box-item, .file-item` 同选择器）
  ⇒ 已按「谁的属性谁持有」**拆成三块**（`.file-item` 现在一个 `!important` 都没有）；
- 串屏根因＝`onBack` 那句 `if (to.scrollY)` ⇒ **记 0 时整段被跳过、容器不自己归零** ⇒ 改成**无条件恢复**。
- 另：`返回` 扩成 `>1 返回 / ==1 清空`（`clearNav = setRoot('')`，**只换文案不加图标** ⇒ 头部宽度不动；
  ⚠️ **绝不挂 Backspace** —— 「门槛 ∝ 不可逆 × 波及面」）；`emptyTip` 补"还没选文件夹"（原来无栈时返回空 ⇒ 清空后纯空白）。
- n-space 重复 key 已修；`.toolbar{flex-wrap:nowrap}` + `.header-bar .n-input{width:200px}` **两条不许删**。

---

## 三、脱敏提交前检查清单（原 §三.7 细节）

**仓库**：`github.com/xxxace/file-finder`，标准由 `fff69a0` 立。

**入库文本不许出现**：真实番号 / 演员名 / 作品名 / 真机目录名 / 盘序列号 / 用户名。
**占位风格**：`TST-xxx`、`示例演员A…H`、`示例作品标题`、`D:/sample/videos/…`。

⚠️ **最容易复发的是"我脱敏了"这类复盘文** —— 只写**类别与风格**，**别抄原值**
（手法见 user skill `desensitize-audit`）。

⚠️⚠️ **最容易漏的一类：探针的输出文件**（`docs/probes/*/out*.txt`）：它们是**机器生成**的，
会把临时目录 / 库路径连同**当前用户名**一起打出来（2026-10-04 抓到 4 处）。
**根治不是事后手改证据文件，而是改探针让它别打绝对路径**（删掉那个字段，或换成 `%USERPROFILE%` 占位），然后重跑。

**提交前必扫三样**（务必取**动态值** —— ⚠️ 别把字面值写进规则，否则规则自己成泄漏源）：
1. 当前用户名（`echo $USERNAME` / `%USERNAME%`）
2. `<盘符>:\Users`
3. `AppData`

⚠️ 扫描必须 `git status --porcelain **-uall**` —— 默认把未跟踪**目录**列成一项，目录里的文件会全漏。

⚠️ **遗留未清（等他定）**：`HEAD` 12 个文件含真实标识、都不是当轮新增
（最重 `PRD-manager-assistant-2026-09-25.md`、`CODE-REVIEW.md`）。**不擅动别的会话的文档。**

---

## 四、各期产出文档索引（原 §四 细节）

| 期 | 文档 |
|---|---|
| 开工先读 | `PROJECT-MEMO-2026-09-24.md`（契约/特性/缓存全文）· `DESIGN-CONVERGED-2026-09-24.md` §六 · `UX-DESIGN-INPUT-2026-09-24.md`（**§二事实不许推翻／§四神圣清单／硬要求**） |
| UI/交互 & PM | `DESIGN-UIUX-2026-09-24.md` · `DESIGN-PM-2026-09-24.md` |
| 管理助手（权威） | `PRD-manager-assistant-2026-09-25.md` |
| 缓存面板 | `DESIGN-CACHE-PANEL-2026-09-30.md` · `PLAN-CACHE-PANEL-2026-09-30.md` |
| 头部/导航（**待真机目视**） | `DESIGN-HEADER-2026-09-30.md` · `DESIGN-NAV-2026-09-30.md` · `PLAN-nav-header-2026-10-01.md`（§十一 回归清单） |
| 10-02 变更 | `CHANGES-2026-10-02.md`（§五 网格贴边／§六 文件夹 size／§七 图标／§八 预览抢点击）+ `ANALYSIS-folder-size-2026-10-02.md` · `ANALYSIS-cover-blur-2026-10-02.md` |
| 权威结论（第四版） | `VERDICT-2026-10-03.md` |
| 历史留档（**已推翻**） | `BACKLOG-2026-10-03.md` · `CLEANUP-AUDIT-2026-10-03.md` · `ASSESSMENT-2026-10-03.md` |
| 独立审阅 | `HANDOVER-2026-10-03.md`，已由 `REVIEW-handover-2026-10-03.md` 审查 |
| 磁盘筛选 / 预览导航 / 预览缓存 | `DESIGN-DISK-FILTER-2026-10-04.md` · `DESIGN-PREVIEW-NAV-2026-10-04.md` · `DESIGN-PREVIEW-CACHE-2026-10-04.md` |
| 10-05 弹层与滚动 | `FIX-2026-10-05-popup-and-scroll.md` · `AUDIT-BACKUP-RESTORE-2026-10-05.md` · `IMPLEMENT-BACKUP-RESTORE-V2-2026-10-05.md` |
| 布局坑 | `LAYOUT-GOTCHAS.md` |

⚠️ **`docs/` 的结论可能是错的**（实锤多次，含 `CHANGES-2026-10-02.md:346` 标着「真根因（静态证据）」）
⇒ **这类标签不会让结论变真**；引用前先问「有没有被后来的实测推翻过」。

---

## 五、本次迁移记录

| 时间 | 动作 | 原因 |
|---|---|---|
| 2026-10-05 | §四 探针细则 + §五 长清单 → 本文件；MEMORY.md 压到 ~9KB | MEMORY.md 实测 **18.7KB**，注入被截断（尾部 §十三 从未进过上下文） |
