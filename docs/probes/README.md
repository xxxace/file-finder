# 只读探针索引

> 这里全部是**只读探针**（不写盘、不改仓库、输出已脱敏）。
> 本项目**没有测试框架** ⇒ 验证 = `typecheck` 0 error + 这里的探针 + 真机目视。
> 本文件存在的理由：**146 个文件里哪些是活证据、哪些是一次性脚手架，一眼可见。**
> ⚠️ **别按文件名猜** —— `run.sh` 里藏着真陷阱（见下），`cover-blur` 还分了两代目录。

## 运行约定（照抄，别自己发明）

- 带 `run.sh` 的目录：`bash docs/probes/<名>/run.sh` —— 它会 `cd` 到仓库根、跑 `run.cjs`、把输出写进 **`out.txt`**。
- ⚠️ **`env -u ELECTRON_RUN_AS_NODE` 不能省**：本机 shell 注入了这个变量，不删掉的话 electron 会**退化成纯 Node、根本不跑窗口**。
  （这条知识原本在 8 份 `run.sh` 里各抄了一遍 —— 收在本文件一处即可。）
- ⚠️ 证据写 **`.txt` 而不是 `.log`**：`.gitignore` 挡 `*.log` ⇒ 写 log 会让文档引用变**死链**（2026-09-30 踩过四次）。
- 本机**无任何 SVG 光栅化器** ⇒ 要光栅化走**无头 Electron**（`icon-render/` 是先例）；必带 `force-device-scale-factor=1`、**别提前 `win.destroy()`**。
- ⚠️ `@media (max-width)` 看的是 **viewport** ⇒ 改 `#stage.style.width` **不触发断点**，测响应式必须 `win.setSize()`。

## 入库判据（将来新增探针照这个来）

三问，**全否 ⇒ 脚本别入库**（数字写进文档就够）：

1. 这条结论**还会被再问一次**吗？（数字已进文档 + 场景一次性 ⇒ 不留脚本）
2. 它是**回归护栏**吗（代码改了得重跑）？
3. **重建成本**高吗？（无头 Electron / 真编译 scoped CSS / PE·JPEG 二进制解析 ⇒ 贵；`node -e` 能算的 ⇒ 便宜）

> ⇒ **结论进文档；脚本默认一次性。**

## 目录清单

`git` = 已跟踪文件数（`0` = 未入 git）；`引用` = 引用了它的文档。

| 目录 | 验什么 | git | 引用 |
|---|---|---|---|
| `header-width/` | 头部行数/折叠/截断（真 Chromium + 真编译 scoped CSS，附截图） | 10 | DESIGN-HEADER · PLAN-nav-header · CHANGES-10-02 |
| `icon-render/` | 应用图标生成（svg → 七档 PNG + ico，真 Chromium 光栅化） | 15 | CHANGES-10-02 · CLEANUP-AUDIT · HANDOVER |
| `nspace-dup/` | `n-space` 重复 key（含 dom-shim / layout-measure） | 9 | FIX-nspace-duplicate-keys · PROJECT-MEMO |
| `grid-6col/` | 网格 6 列对齐（真 Chromium，前后截图） | 7 | CHANGES-10-02 |
| `folder-size/` | 文件夹 size 聚合成本与命中率（真库，含 17/17 的 `verify.mjs`） | 6 | ANALYSIS-folder-size · CHANGES-10-02 |
| `table-scroll/` | 表格"内部滚动 + 表头吸顶" | 5 | LAYOUT-GOTCHAS · PLAN-cache-panel · PLAN-nav-header |
| `narrow-layout/` | 小窗口布局（900×700） | 5 | LAYOUT-GOTCHAS · PLAN-cache-panel |
| `preview-fill/` | 预览图撑满视口 | 5 | ⚠️ 只有它自己的 README（无外部文档引用） |
| `win-size/` | 主窗口初始尺寸 / 最小尺寸（真 Electron） | 4 | CHANGES-10-02 · MEMORY-APPENDIX |
| `s1-cf/` | 站点抓取 spike（S1） | 4 | SPIKE-S1-runbook · spike-S1-result |
| `faces/` | 「换封面」目标收集（`collectFaces`） | 4 | IMPLEMENT-manual-pick |
| `cover-blur/` | 封面模糊/小头像统计（`scan.mjs` · `rename-overwrite.mjs`） | 4 | ANALYSIS-cover-blur · HANDOVER · VERDICT |
| `remove-race/` | 删除与扫描的竞态（"删了又回来"） | 4 | PLAN-cache-panel |
| `scan-rules/` | 扫描规则夹具（`fixture.json` + nedb 桩） | 3 | KICKOFF-assistant-ui · PRD-manager-assistant |
| `scan-real/` | 真库扫描（assistant，含 nedb 桩） | 2 | KICKOFF-assistant-ui · PRD-manager-assistant |
| `crumbs/` | 面包屑纯函数 | 2 | PLAN-nav-header |
| `icon-embed-verify/` | exe 内嵌图标字节比对 | **0** | HANDOVER · VERDICT |
| `cover-blur-verify/` | 缩略图恒等式 + 收益数复核 | **0** | HANDOVER · VERDICT |
| `search-readiness/` | 全局搜索就绪度（`name` 语义 / 类型分布） | **0** | HANDOVER · VERDICT |
| `dup-scan/` | 跨盘重复率 / 目录形态 | **0** | ASSESSMENT · BACKLOG · HANDOVER |
| `handover-audit/` | 交接件独立复核（投影体积 / PE 图标 / 116 复核） | **0** | REVIEW-handover |
| `popover-pick/` | 「多部组成」popover 点击归属（`markup.js` 是生成物） | **0** | CHANGES-10-02 |
| `parse-title/` | 番号解析回归 | 1 | KICKOFF-assistant-ui · PRD-manager-assistant |
| `reconcile/` | **增量对账**：同一层再扫时缩略图有没有被复用（计数桩，17 PASS） | 7 | IMPLEMENT-reconcile |
| `hotplug/` | **移动硬盘热插拔**：`hookWindowMessage(0x0219)` 收不收得到插拔事件（**需人插盘**） | — | PLAN-POLISH · IMPLEMENT-reconcile |

> **结论：23 个目录逐个查过，每一个都被至少一份文档引用 —— 目录级没有孤儿，没有可白删的。**

## ⚠️ 两处引用链问题（待处理，不是"删"能解决的）

1. **一批被文档引用的探针目录还没进 git**：
   - `popover-pick/` 被**已提交**的 `CHANGES-2026-10-02.md` 引用 ⇒ **真实死链**（别人 clone 后点不开）。
   - 另 5 个（`cover-blur-verify` · `dup-scan` · `handover-audit` · `icon-embed-verify` · `search-readiness`）
     只被**今天这批尚未提交的文档**引用 ⇒ 提交时一起 `git add` 即可解决。
   ⇒ **正解是 `git add`，不是删**（它们是 HANDOVER / VERDICT / REVIEW 的证据）。
2. **`docs/FIX-2026-09-24-nspace-duplicate-keys.md:4`** 把 `docs/probes/nspace-dup/out.log` 当"原始日志"引用，
   而 `*.log` 被 `.gitignore` 挡 ⇒ **该引用在仓库里必然无效**。要么改指 `out.txt`，要么把日志改存 `.txt`。

## 游离脚本（未收进子目录，21 个）

`docs/probes/*.mjs`：`cache-panel-{size,size2,size3,ghost,stats,agg-cost,sfc-smoke}` · `cache-v-audit` ·
`clickable-dirs` · `empty-record-audit` · `scan-cost` · `electron-stub` · `esm-stub-loader` ·
`ffprobe-{kill-leak,timeout-fix,timemark-branch}` · `p1-{scan-verify,sfc-smoke}` · `fc2-ctx` · `fc2-check.js` · `phase2a-selftest.js`

多为一次性取数/夹具。⚠️ `electron-stub.mjs`（根）与 `faces/electron-stub.mjs` 是**重复**的。
