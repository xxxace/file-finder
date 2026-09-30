# 「缓存记录」面板改造 · 实施计划

> **给执行者**：这是分阶段、可独立回退的实施计划。**本项目的执行者就是写这份计划的人（同一会话，持有全部上下文）**，
> 所以这里只对"容易做错的地方"给完整代码，机械性改动给精确指令 + 验收标准 —— 这是对 skill 默认"每步都给完整代码"的**有意偏离**，理由见 §9。
>
> 配套文档：`docs/DESIGN-CACHE-PANEL-2026-09-30.md`（v3 方案，含用户四条硬约束）·
> mockup `docs/cache-panel-mockup-2026-09-30.html`

---

## 执行状态

| 阶段 | 状态 | 证据 |
|---|---|---|
| **A 纯渲染层**（7 任务） | ✅ **已落地；已完成 1 轮真机反馈修正（7 条）** | `npm run typecheck` 0 error · `node docs/probes/cache-panel-sfc-smoke.mjs` 两个文件均 0 问题 |
| B 只读聚合（4 任务） | ✅ **代码已完成，待重启 dev 复验** | `npm run typecheck` 0 error · SFC 冒烟 0 问题 · 期望数值由只读探针给出（见下） |
| C 结构与交互 | ✅ **本轮做了 4 项（见下），3 项有意不做** | `npm run typecheck` 0 error · SFC 冒烟 0 问题 · 竞态有对照探针 |

### 阶段 B 落地（只读聚合，**零新增读盘**）

**加了什么**
- `src/utils/index.ts`：新增 `formatBytes()`（KB/MB/GB/**TB**，0 → `—`）；主界面 `getSize` 改成它的薄封装
  —— 顺带修掉老的 `parseSize` 把 TB **取模截断**的静默错数字（1.83 TB 会显示成 `850.xxGB`）。
- `electron/server/nedb.ts`：`loadMeta(q)` 扩展为可选算 `bytes`（= `data[].size` 内存求和）+ 可选排序。
  **默认参数与老行为逐字一致**（`create_at` 倒序）⇒ `listDisksController` 一行都不用改。
- `electron/server/index.ts`：`/getHistory` 返回 `bytes` 并支持 `sort`/`dir`；`/getDisks` 返回体加 `stats`。
- `src/components/HistoryTable/index.vue`：顶部**总览句**、「**大小**」列、表头**服务端排序**（受控 + 幂等守卫）。

**期望数值**（只读探针 `docs/probes/cache-panel-stats.mjs` 给的对照值，重启 dev 后逐项核对）
`5 块盘 · 213 个目录 · 1247 个条目 · 已读到 3.35 TB · 库 81.7 MB · 最近扫描 2026-09-27 22:32`

**⚠️ 顺手修掉探针自己的一个 bug（正是备忘里警告过的那个）**
`cache-panel-stats.mjs` 原来**没跳过 nedb 的 `$$indexCreated` 索引行**，于是目录数报 **214**、盘数报 **6**
（真实是 213 / 5），死行报 2（真实 0）。已修：跳过索引元数据行，并把死行算式也减掉它。
**如果不修，我给你的对照数字就是错的** —— 服务端的 `loadMeta()` 走 `find()`，返回的是真文档，没有那一行。

**排序为什么在服务端**：只有服务端知道全量（213 条）。前端排只能排当前页 = **假排序**
（"第 1 页最大的在最上面"，翻页又是另一批）。列 key 与 `/getHistory` 的 `sort` 参数同名，
不维护映射表。受控 `:sorter` 配一个**幂等守卫**：目标排序与当前相同就直接 return ⇒
万一 prop 同步再回调一次也不会变成死循环（结构上不可能，不是赌它不回调）。

### 第 1 轮真机反馈（7 条，已全部处理）

用户判词：**"目前没有太大的问题"**。7 条里 5 条是我改过了头（体验微调），2 条是真问题。

| # | 反馈 | 处理 |
|---|---|---|
| 1 | 目录要用蓝色字体、和之前一样 | 还原成蓝字（`#2080f0`）。**链接的外观本身就是可发现性**，不需要额外提示。 |
| 2 | 行内「离线 · 只读」多余 | 删掉（「盘」列已显示「离线」）；"只读"这层意思挪进标签的 `title`。 |
| 3 | 日期为什么没有年月 | 我为了省列宽省略了年份 —— 自作聪明。改成 `YYYY-MM-DD HH:mm`，列宽 150。 |
| 4 | 滚动条应落在表格内，不是整个弹窗 | 卡片内容 + `.n-spin-container` + `.n-spin-content` 全部"纵向 flex + `min-height:0`"，只有 `.table-wrap` 是 `flex:1 + overflow:auto`，表头 CSS sticky。 |
| 5 | 悬停「双击打开」多余 | 删掉（配合第 1 条）。 |
| 6 | 搜索要加节流 / 防抖 | 原已有 debounce；**新增输入法守卫** —— `n-input` 在 composition 期间照样发 `update:value`，拼字中途会排出多条请求。现 debounce 300ms + 拼字中不发请求、上屏后立刻查。 |
| 7 | **插上盘后只读层双击资源还是打不开** | ⭐ 设计缺陷，见下。 |

### 第 2 轮反馈（1 条，已修）—— 表头仍然跟着滚走

用户复验：「其它都没问题，表格的 header 为什么还是会跟着滚动消失在可视区域？」

**我第 1 轮的修法是错的**，而且错在"以为给它一个 overflow 就行"。实测见
`docs/probes/table-scroll/out.log`（真 Chromium + 真 naive-ui）：

| 变体 | 卡片 CSS | 表格实测高 | 滚的是谁 | 滚到底后表头 |
|---|---|---|---|---|
| old（第 1 轮） | `max-height:86vh` + `.table-wrap{overflow:auto}` + `thead{sticky}` | **4235 px** | `table-wrap` | **相对表格 −3562 → 滚走了** ❌ |
| new（现在） | `height:86vh` + `.table-wrap{display:flex}` + DataTable `flex-height` | **672 px** | DataTable 自己的 body | **相对表格顶部 1 px → 钉住** ✅ |

**根因**：`max-height` **只封顶、不给确定高度** ⇒ 容器高度仍是内容高度 ⇒
`flex:1 1 auto` 的表格**没有剩余空间可分**，按内容长到 4235px，压根没被约束；
于是那层 `overflow:auto` 变成"整张表"的滚动容器，表头是表格的一部分，必然跟着滚。
`thead` 的 sticky 也救不回来（祖先的 overflow 把参照系换成了整张表，而表头从没离开过那张表）。

**正确做法**：① 卡片给**确定高度**（`height:86vh`）让 flex 链有东西可分；
② 用 DataTable 自己的 `flex-height` —— 它会把表头渲染成**独立的一块**
（`.n-data-table-base-table-header`），滚动只发生在 body 里。

**代价**：卡片从"最小 86vh"变成"**恒定 86vh**"（只有几行数据时下方留空白）。列表页这样更合适（翻页不跳）。

### ⭐ 第 7 条：根因与修复（用正确的方式，不是打补丁）

**根因**：判"能不能打开原文件"用的是 `target.startsWith('#')` —— **地址长什么样**。
而地址形态是"当初扫描那一刻盘在不在"的**历史快照**：盘插回来，地址不会变 ⇒ 那一层被**永久**判成只读。
**正确的问题不是"地址是不是锚点"，而是"这块盘此刻在不在"。**

**修复**
- 新增只读接口 `route('/resolveAnchor')`（`electron/server/index.ts:1038`，注册在 `:1111`）：
  `parseAnchor` → `getDrives()`（**进程内缓存，不扫盘**）→ 查不到才 `getDrives(true)` 重试一次 →
  返回 `{ path }`；盘不在则 `404 + kind:'offline'`。
- 渲染层 `openFile()`：锚点不再无条件拦掉，而是**当场问服务端**；拿到实时路径继续走 IPC `shell.openPath`。
- 分工一行没变：**懂锚点的只有服务端**（它才有 serial→盘符），**系统能力仍走主进程**。
- 只读横幅文案同步改成"插上盘后可以直接双击打开原文件"（原文案描述的是修复前的行为）。

**⚠️ 关于"少读盘"的如实报告（对应硬约束 3）**
这条修复在"盘不在已知列表里"时会做**一次 26 个盘符的 stat**（代码注释里量过 ≈2ms）。
触发点只有"用户主动要打开一个文件" —— 而那个文件**马上就要读这块盘**，
所以这次探测的开销被后面的动作完全盖住，不是净新增的读盘。


**执行中自查抓到 1 个真 BUG（已修，值得记一笔）**
空态第一版把判据写成"模板 `v-if=\"emptyText\"` + computed 里只排除 loading"——
而 `emptyText` 在"没搜词 + 不在加载"时**恒等于**"还没读过任何目录"，
于是**列表里有 213 行时，表格下面照样挂着那句空态**。
`vue-tsc` 和 SFC 冒烟**都抓不到它**（编译和类型都是对的，错的是"条件写得不够全"）。
修法不是给模板补一个 `&& !tableData.length`，而是把"有没有数据"收进 `emptyText` 这个 computed ——
**判据只有一处**，以后不会再出现"模板忘了带条件"。

**阶段 A 改动清单**
- `src/components/HistoryTable/index.vue`：模板重排为 G1/G2/G3/G4；`closable` + 卡内滚动；
  列拆成「盘 / 目录 / 条目 / 上次扫描」+ 双击可发现性；搜索即时化 + 请求序号；
  空态；批量区挪底部恒定高度；折叠「备份与迁移」+ 两个备份合一 + 删除/还原文案；
  新增 `<style>`（**非 scoped**，用 `.cache-panel` 前缀隔离 —— 理由见该 style 块的注释）。
- `src/views/FileFinder/index.vue`：入口按钮补 tooltip（旁边的 `n-badge` 未动）。
- `docs/probes/cache-panel-sfc-smoke.mjs`：新增（覆盖改过的两个 `.vue`）。

---

**目标**：把「缓存记录」面板从"索引管理台"改成"目录黄页"——查/逛/去是主路径，管理动作收进底部与折叠区；
且**不新增任何读盘动作**。

**架构**：阶段 A 只改渲染层（1 个组件 + 1 处主界面改动），阶段 B 加只读聚合（2 个接口 + 1 个工具函数），
阶段 C 动结构与写入路径（本轮不做）。每阶段结束都能独立验收、独立回退。

**技术栈**：Vue 3 `<script setup>` + naive-ui 2.45.3 + Electron 主进程 HTTP 服务（`route()` 咽喉点）+ nedb。

---

## 0. 开工前置（三条，必须先确认）

### 0.1 ⚠️ 工作区已经是脏的

`git status` 实测：**4 个已跟踪文件被改过但未提交** ——
`electron/main/index.ts` · `electron/server/index.ts` · `electron/utils/thumbnail.ts` · `src/views/FileFinder/index.vue`，
另有 28 项未跟踪（管理助手模块、09-24/09-25 的落地、本轮的探针与文档）。

**里面的 `electron/server/index.ts` 和 `src/views/FileFinder/index.vue` 正是本计划要改的两个文件。**
⇒ 如果现在开工，**回退点不干净**：出问题没法只回退本次改动。

**处理（需用户决定，我不擅自提交别人的在制品）**：
- 选 1：先由用户把现状提交一版（推荐）→ 之后每阶段一个提交，回退点清晰；
- 选 2：用户接受"不带提交、靠文件备份回退"→ 我在每阶段前把目标文件复制一份到 `.tmp-backup/`（每次改前 1 秒），阶段验收通过后删除。

### 0.2 本项目的验证手段（没有测试框架）

实测 `package.json` scripts 只有三个：`dev` · `typecheck` · `build`。**没有测试脚本。**
所以每个任务的验证 = 三者之一 + 目视：

| 手段 | 命令 / 动作 | 用在 |
|---|---|---|
| 类型检查 | `npm run typecheck`（= `vue-tsc --noEmit` + `tsc -p tsconfig.electron.json`） | 每次改完 TS/Vue 都跑，**必须 0 error** |
| 只读探针 | `node docs/probes/xxx.mjs` | 只验证"数据算得对不对"，不验证 UI |
| 真机目视 | 用户：改渲染层 → 按 **↻ 刷新**；改主进程 → **重启 dev** | 每阶段结束 |

**铁律（项目级）**：**改主进程 → 必须重启 dev 才生效**；改渲染层 → 用户按 ↻ 刷新即可。

### 0.3 不许越界的四条硬约束（用户 2026-09-30 原话）

1. **不加「操作」列** —— 打开方式固定为双击目录名。
2. **只汇总已有缓存的文件大小，不读盘**。
3. **尽量不加扫盘功能**；有就告诉他。
4. 交付前自查：合理自洽 / 有没有误解 / 有没有把握。

---

## 1. 文件结构（改哪些、各自负责什么）

| 文件 | 阶段 | 职责 |
|---|---|---|
| `src/components/HistoryTable/index.vue` | A + B | 面板本体：布局 G1/G2/G3/G4、列、搜索、批量区、折叠区、消费 `stats`/`bytes` |
| `src/views/FileFinder/index.vue` | A | 只两处：入口按钮加 tooltip；`getSize` 改为调用共享格式化函数 |
| `src/utils/index.ts` | B | 新增 `formatBytes()`（KB/MB/GB/**TB**，0 → `—`），修掉 `parseSize` 的 TB 截断 |
| `electron/server/nedb.ts` | B | 扩展 `loadMeta()`：可选算 `bytes` + 可选排序（**唯一聚合点**） |
| `electron/server/index.ts` | B | `/getDisks` 加 `stats`；`/getHistory` 传排序参数、返回 `bytes` |

**不动的文件**：`electron/utils/driveIdentity.ts`（阶段 C 才动）· `electron/main/index.ts` ·
`CACHE_VERSION` / `CACHE_KEY` / `CACHE_IV` ✅ 一律不动。

---

## 2. 阶段 A · 纯渲染层（7 个任务，**不用重启 dev**）

> 改完用户按 ↻ 刷新即可看到。全程不碰服务端、不碰数据、不新增读盘。

### Task A1：面板壳 —— 关得掉 + 装得下

**Files:** Modify `src/components/HistoryTable/index.vue:2-3, 66`

**为什么**：现在没有 ✕（只能点遮罩/Esc）；`width:900px` + `margin-top:10px` + 表格无 `max-height`，
pageSize 选 100 时 100 行 ≈ 3200px **直接顶出屏幕**。

```vue
<n-card
    class="cache-panel"
    title="缓存记录"
    closable
    :bordered="false"
    size="huge"
    role="dialog"
    aria-modal="true"
    :content-style="{ overflow: 'auto', flex: '1 1 auto', minHeight: '0' }"
    style="width: min(1040px, 92vw); max-height: 86vh; display: flex; flex-direction: column"
    @close="setShowModal(false)"
>
```

- [ ] **Step 1**：按上面替换 `n-card` 开标签；`</n-card>` 前的 `</n-modal>` 结构不动。
- [ ] **Step 2**：`npm run typecheck` → 期望 **0 error**。
- [ ] **Step 3**：用户按 ↻ 刷新，检查：面板右上角出现 **✕** 且能关；把每页改成 100 条，**表格在卡片内滚动、分页条不消失**。

### Task A2：布局重排为 G1/G2/G3/G4 四组

**Files:** Modify `src/components/HistoryTable/index.vue:5-14`（头部）, `:26-46`（工具条）, `:53-64`（footer）

**目标结构**（顺序即视觉顺序）：

```
n-card
├─ #header-extra  → G1：搜索框(全宽) + 「↻ 刷新」
├─ body
│   ├─ G2-a 总览句（占位，阶段 B 填真数）
│   ├─ G2-b 盘条（阶段 C 才从下拉换成 chips；A 阶段先把 n-select 挪到这一行，宽度自适应）
│   ├─ [克隆盘 n-alert —— 保持整块，不藏 tooltip：危险提示必须显眼]
│   └─ 表格
└─ #footer → G4：左 批量区（恒定高度）/ 右 分页
+  折叠区「备份与迁移」（Task A6）
```

**为什么拆四组**：日常「查/逛/去」和低频高风险「管理」混在一行是主次颠倒的根因（方案 P0-1/P0-2）。

- [ ] **Step 1**：把 `#header-extra` 里的 `n-space` 内容改成**裸 flex 容器**（`.g1-row`）：
  `n-input`（`flex:1`，最新布局约束见 `docs/FIX-2026-09-24-nspace-duplicate-keys.md`）+ 「刷新」按钮。
  ⚠️ **不要用 `n-space`** —— 它的子元素个数在本面板会变（盘选项、批量区），会重复 key。
- [ ] **Step 2**：把 5 个迁移按钮**整体**从工具条位置挪到 Task A6 的折叠区，工具条位置留空。
- [ ] **Step 3**：`#footer` 改成 `.foot-row`（`display:flex; justify-content:space-between`）：左侧批量区（Task A5）、右侧分页。
- [ ] **Step 4**：`npm run typecheck` → 0 error。
- [ ] **Step 5**：用户目视：搜索框占满、分页仍在右下、迁移按钮**不再**出现在工具条。

### Task A3：表格列 —— 列名说实话 + 双击可发现性 + 离线不再 `??`

**Files:** Modify `src/components/HistoryTable/index.vue:105-140`（`columns`）

**为什么**：
- `count = data.length`（`server/index.ts:620`）= 该层**条目数**，列头却写「封面」（方案 P1-3）；
- 列头「日期」实际是 `create_at` = **写入时刻**（P1-7）；
- 目录名被渲染成 `NButton quaternary`（**看着像单击链接**），而打开方式是双击（**C1：不加操作列**）；
- 离线行的盘符是 `'??'`（P1-8）。

**拆列**（盘符从目录列里独立出来，这样"全部盘"视图能一眼看出归属）：

```ts
/** 时间显示：今年 → MM-DD HH:mm，往年 → YYYY-MM-DD */
function fmtScanTime(t?: string) {
    if (!t) return '—';
    const today = dayjs().format('YYYY-MM-DD');
    return t.slice(0, 4) === today.slice(0, 4) ? t.slice(5, 16) : t.slice(0, 10);
}

const columns = ref<DataTableColumns<RowData>>([
    { type: 'selection' },
    {
        title: '盘', key: 'disk', width: 100,
        render(row) {
            // 离线盘不再渲染 '??' —— 那是纯噪音，看不出是"盘符未知"还是"出错了"
            const txt = row.online && row.path ? row.path.slice(0, 2) : '离线';
            return h('span', { class: row.online ? 'disk-on' : 'disk-off' }, txt);
        },
    },
    {
        title: '目录', key: 'path', minWidth: 260,
        render(row) {
            // C1：仍然是双击打开。去掉 quaternary 按钮的"像链接"假暗示，
            // 换成纯文本 + 手型 + 悬停出现「双击打开」。
            return h('div', { class: 'dir-cell' }, [
                h('span', { class: 'dir-name', ondblclick: () => openDir(row) }, row.relPath || '/'),
                row.online ? null : h('span', { class: 'dir-ro' }, '离线 · 只读'),
                h('span', { class: 'dir-tip' }, '双击打开'),
            ]);
        },
    },
    { title: '条目', key: 'count', width: 68, align: 'right' },
    { title: '上次扫描', key: 'create_at', width: 120, align: 'right', render: row => fmtScanTime(row.create_at) },
]);
```

⚠️ **A 阶段不显示「大小」列** —— 那需要阶段 B 的 `bytes`。阶段 B 会在这两列之间插入。

样式（加到组件 `<style>` 或与其它样式同处）：

```css
.dir-cell { display: flex; align-items: center; gap: 8px; min-width: 0; }
.dir-name { cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dir-tip { opacity: 0; font-size: 11.5px; color: #999; white-space: nowrap; }
.dir-cell:hover .dir-tip { opacity: 1; }
```

- [ ] **Step 1**：替换 `columns` 为上面版本；`openDir` 不动（它已带"没有地址"守卫 + 离线可进的注释）。
- [ ] **Step 2**：确认 `dayjs` 已在该组件 import（没有就加 `import dayjs from 'dayjs'`）。
- [ ] **Step 3**：`npm run typecheck` → 0 error。
- [ ] **Step 4**：用户目视：①表头是「盘 / 目录 / 条目 / 上次扫描」；②鼠标移到目录名上出现「双击打开」；③离线行的盘列显示「离线」而不是 `??`；④**双击仍能打开**（在线进实时层、离线进只读层）。
- [ ] **Step 5**（可选，用户若嫌提示不够明显）：把 `.dir-tip` 的默认 `opacity` 改成 `0.55` 常驻。

### Task A4：搜索即时化 + 两个空态 + 修「翻到空白页」

**Files:** Modify `src/components/HistoryTable/index.vue:9-11`（去「查询」按钮）, `:213-226`（`getHistrotyList`）, `:244-254`, `:284-287`

**为什么**：主界面是**输入即过滤**（`index.vue:318` 的 computed）+ 空态（`:354-360`），面板两样都没有（P1-4 / P1-15）；
且改每页条数不重置页码 → 第 10 页 × 100 条 = 第 901~1000 条 > 213 → **空表但分页器还写"共 213 项"**（P1-11）。

**`getHistrotyList` 改成"请求序号丢弃过期响应"**（比原来的 `if (loading) return` 守卫更对：守卫会**丢掉**后发的搜索，
留一个"输了词但列表是旧的"的空窗）：

```ts
/**
 * 请求序号 —— 只让"最后一次发出的请求"写表格。
 *
 * 为什么不用 `if (loading.value) return` 守卫：搜索变即时之后（debounce 250ms），
 * 守卫会**丢掉**用户最新那次输入，界面停在上一轮结果上（"输了词但列表没变"）。
 * 序号法在结构上保证"旧的响应永远覆盖不了新的" —— 不依赖调用方记得加守卫。
 */
let listReqSeq = 0;

const getHistrotyList = () => {
    const my = ++listReqSeq;
    loading.value = true;
    getAction(`${API_BASE}/getHistory${toQueryStr(model.value)}`)
        .then(async (data: BrowseHistoryWithPagination) => {
            if (my !== listReqSeq) return;      // 过期响应：丢弃
            tableData.value = data.records;
            model.value.total = data.total;
        })
        .catch(err => {
            if (my !== listReqSeq) return;
            notify('error', '错误', `获取历史数据列表错误！${err}`);
        })
        .finally(() => {
            if (my === listReqSeq) loading.value = false;
        });
};
```

搜索改为即时：

```ts
/** 输入即过滤（debounce 250ms，和主界面"输入即过滤"保持一致）。回车仍然可用（立即查）。 */
let searchTimer: number | undefined;
watch(() => model.value.path, () => {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => onSearch(), 250);
});
```

`onSearch` 去掉 `if (loading.value) return`（序号法已接管）；`handlePageSizeChange` 里加 `model.value.pageNo = 1`。

空态（**判据必须先排除 loading/失败**，照抄主界面写法）：

```ts
const emptyText = computed(() => {
    if (loading.value) return '';               // 加载中不判空 —— 否则会闪一下"还没读过任何目录"
    if (model.value.path) return `没有匹配「${model.value.path}」的目录`;
    return '还没读过任何目录';
});
```
模板里表格下方：`<div v-if="emptyText && !tableData.length" class="empty-tip">{{ emptyText }}</div>`
（"还没读过任何目录"时补第二行小字：`在主界面选个文件夹，点「补全这一片」`）

- [ ] **Step 1**：删除模板里的「查询」按钮；`n-input` 的 `@keyup.enter` 保留。
- [ ] **Step 2**：按上面替换 `getHistrotyList`；加 `listReqSeq`。
- [ ] **Step 3**：加 `searchTimer` + `watch`；`onSearch` 去掉 loading 守卫；`handlePageSizeChange` 加 `pageNo = 1`。
- [ ] **Step 4**：加 `emptyText` computed + 模板空态（**不要**用 `n-empty`，主界面是朴素一行小字，保持一致）。
- [ ] **Step 5**：`npm run typecheck` → 0 error。
- [ ] **Step 6**：用户目视：①敲字后列表自己变（不用点按钮）；②搜一个不存在的词 → 出「没有匹配…」；③**关键回归**：翻到第 10 页 → 把每页改成 100 → 表格**不能是空的**。

### Task A5：批量区挪到底部、恒定高度、跨页说清

**Files:** Modify `src/components/HistoryTable/index.vue:26-28`（删除按钮移位）, `:53-64`（footer）

**为什么**：`删除(N)` 用 `v-if` → 一出现就把后面按钮整体推右（P1-5）；
且表格选择是**内部态**（只监听 `@update:checked-row-keys`，没传受控 prop，`:48-50`）→ 跨页勾选后"删除(3)"可能含**当前页看不见的行**。

**不改成受控**（受控要自己管清理时机，而"跨页多选"在这个规模本身就是陷阱）；**只让状态透明**：

```vue
<div class="foot-left">
    <n-button size="small" type="error" :disabled="!checkedRowKeysRef.length" @click="handleRemove">
        删除记录
    </n-button>
    <span class="sel-hint">
        {{ checkedRowKeysRef.length
            ? `已选 ${checkedRowKeysRef.length} 项（其中 ${checkedOnOtherPages} 项不在本页）`
            : '未选中任何记录' }}
    </span>
    <n-button v-if="checkedRowKeysRef.length" text size="small" @click="handleCheck([])">清空选择</n-button>
</div>
```

```ts
/** 选中的行里，有多少不在当前这一页 —— 跨页多选必须让用户看见，否则"删了什么"是黑箱 */
const checkedOnOtherPages = computed(() => {
    const onPage = new Set(tableData.value.map(r => rowKey(r)));
    return checkedRowKeysRef.value.filter(k => !onPage.has(k as string)).length;
});
function rowKey(row: RowData) { return row._id || row.serial + '/' + row.relPath; }
```

⚠️ 同时把 `n-data-table` 的 `:row-key` 改成复用 `rowKey`（**一处定义**，原来那个内联箭头函数会和这里漂移）。

- [ ] **Step 1**：按上面加 `.foot-left`；删除按钮与选择提示移进去；`handleCheck([])` 的"清空选择"**常驻与否都行但不能改布局高度**（用 `v-if` 会改行宽但**不改行高**，可接受）。
- [ ] **Step 2**：加 `rowKey` + `checkedOnOtherPages`；`:row-key="rowKey"`。
- [ ] **Step 3**：`npm run typecheck` → 0 error。
- [ ] **Step 4**：用户目视：①什么都没选时按钮**变灰但位置不动**；②跨页勾选后提示里出现"N 项不在本页"；③点「清空选择」勾选消失。

### Task A6：折叠「备份与迁移」+ 危险分级 + 还原文案

**Files:** Modify `src/components/HistoryTable/index.vue:29-46`（5 个按钮）, `:295-306`（删除文案）, `:404-418`（还原文案）

**三件事**：
1. **两个「备份」合一**（方案 P0-3）：删掉「备份」按钮（`handleDriveBackup` / `onDriveBackup` 一并删）。
   **`/backup` 接口保留不动**（零成本，将来"退出时自动快照"可复用）。
2. 5 个按钮收进 `<n-collapse>`「备份与迁移」，默认收起；「从文件还原…」用 `type="error"`。
3. 文案按方案 §5 重写。

```vue
<n-collapse class="migrate-collapse">
    <n-collapse-item title="备份与迁移" name="migrate">
        <n-space vertical size="small">
            <div class="mi-row">
                <n-button size="small" @click="handleBackupToFile">备份到文件…</n-button>
                <span class="mi-hint">默认文件名带你今天的日期，位置自己挑 —— 不会被任何东西覆盖</span>
            </div>
            <div class="mi-row">
                <n-button size="small" type="error" @click="handleRestoreFromFile">从文件还原…</n-button>
                <span class="mi-hint warn">整份替换当前缓存</span>
            </div>
            <div class="mi-row">
                <n-button size="small" @click="handleMergeCache">合并缓存…</n-button>
                <span class="mi-hint">只增不删（新增 / 覆盖 / 跳过 会报给你）</span>
            </div>
            <div class="mi-row">
                <n-button text size="small" @click="openDataDir">打开存放文件夹</n-button>
            </div>
        </n-space>
    </n-collapse-item>
</n-collapse>
```
（`n-collapse` 里子元素恒定 → 用 `n-space` 安全，符合项目铁律 4）

删除确认文案（P0-4，**说清删的是什么 + 后果**）：
```
只删掉这 N 条记录，硬盘上的文件一个都不动。
删掉后，下次打开这些目录会重新读一遍硬盘（要碰移动硬盘）。
其中 M 条在那块没插的盘上 —— 删了就看不到了，除非把盘插回来重扫。
```
（N = 选中数，M = 选中里离线的条数 —— 从 `tableData` 取，取不到就省略后半句）

还原确认文案（**语气修正**：缓存可重建，代价是重扫不是丢数据）：
```
会用你选中的文件整体替换当前缓存。
替换后，本机独有的 213 个目录 / 1247 个条目要重新读一遍移动硬盘才能回来
（数字取 stats；A 阶段没有 stats 就写"本机独有的记录"）。
还原前会自动留一份快照，还原后立即生效，不用重启。
```

- [ ] **Step 1**：删「备份」按钮 + `handleDriveBackup` + `onDriveBackup`（**接口不删**）。
- [ ] **Step 2**：5 个按钮搬进 `n-collapse`；「打开存放文件夹」保持 `text` 按钮（它是唯一的安全出口，位置在这一组里合理）。
- [ ] **Step 3**：改写两处 `dialog.*` 文案（删除 / 还原）。
- [ ] **Step 4**：`npm run typecheck` → 0 error；确认 `deletAction` 不再导出未使用的 `onDriveBackup`（会报 unused，删掉即可）。
- [ ] **Step 5**：用户目视：①工具条下方只有一个「备份与迁移」，点开才是 4 个动作；②「从文件还原…」是红的；③点删除看到新文案。

### Task A7：入口按钮补 tooltip

**Files:** Modify `src/views/FileFinder/index.vue:53-57`

**为什么**：打开发面板的是**只有脚印图标、无文字、无 tooltip** 的按钮（P0-7）—— 面板做得再好，找不到入口等于零。

```vue
<n-tooltip>
    <template #trigger>
        <n-button size="small" @click="showHistory">
            <template #icon>
                <FootstepsOutline />
            </template>
        </n-button>
    </template>
    缓存记录（读过的目录）
</n-tooltip>
```

⚠️ **不动**第 58 行那个 `n-badge`（它是"当前目录条目数"，与脚印按钮无关 —— 位置是否误导**等用户裁决**，见方案 P2 待确认项）。

- [ ] **Step 1**：包 tooltip。
- [ ] **Step 2**：`npm run typecheck` → 0 error。
- [ ] **Step 3**：用户目视：鼠标悬停脚印按钮 → 出现「缓存记录（读过的目录）」。

### 阶段 A 验收 + 回退

| 验收 | 动作 |
|---|---|
| 类型 | `npm run typecheck` → **0 error** |
| 功能 | 用户按 ↻ 刷新，逐条走 Task A1–A7 的目视清单 |
| 回归（最要紧 3 条） | ①双击仍能打开（在线+离线）②第 10 页改 100 条不空 ③删除/还原文案看一遍 |
| 回退 | 阶段 A 只碰 2 个 `.vue` 文件 → 把那两个文件还原即回到今天的状态 |

---

## 3. 阶段 B · 只读聚合（4 个任务，**要重启 dev**）

> 全部是只读改动；**零读盘**（已实测：nedb 整库常驻内存，聚合一趟 0.07 ms）。

### Task B1：`formatBytes()` —— 并修掉 TB 截断

**Files:** Modify `src/utils/index.ts`（新增函数）· `src/views/FileFinder/index.vue:408-417`（`getSize` 改为薄封装）

**为什么**：现有 `parseSize` 是 `gb = bytes/1G % 1024`（`src/utils/index.ts:3`）—— **取模**。
1.83 TB 会渲染成 `850.xxGB`，2 TB 会渲染成 **`0.00GB`**。这是**静默输出错误数字**。
当前单条最大 492.55 GB 侥幸没过界，但「大小」列一上，迟早说谎。

```ts
/**
 * 人类可读的字节数。0/空 → '—'。
 *
 * ⚠️ 必须支持 TB：老的 parseSize 里 `gb = bytes / 1G % 1024` 是**取模**，
 * 1.83 TB 会被渲染成 850.xxGB、2 TB 直接变 0.00GB —— 先例见 docs/DESIGN-CACHE-PANEL-2026-09-30.md §3.4。
 */
export function formatBytes(bytes: number | undefined | null): string {
    if (!bytes || bytes <= 0) return '—';
    const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
    let n = bytes, i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i += 1; }
    return `${i <= 1 ? n.toFixed(0) : n.toFixed(2)} ${units[i]}`;
}
```

`index.vue` 的 `getSize` 改为调用它（**保留函数名**，"别动他的结构"）：

```ts
const getSize = (size: number | undefined) => formatBytes(size);
```

⚠️ **行为变更**：0 字节文件在悬浮提示里从 `0` 变成 `—`（更合理，但属于可见变化 —— 一并让用户看一眼）。

- [ ] **Step 1**：`src/utils/index.ts` 加 `formatBytes`；`parseSize` **保留不删**（万一别处引用；实测只有 `index.vue:410` 用）。
- [ ] **Step 2**：`index.vue` 删掉 `getSize` 原实现，改成一行封装；`parseSize` 的 import 若不再用则移除。
- [ ] **Step 3**：`npm run typecheck` → 0 error。
- [ ] **Step 4**：用户目视：主界面网格悬停文件 → 大小显示正常（如 `1.20GB`）。

### Task B2：`loadMeta()` 扩展 —— 唯一聚合点

**Files:** Modify `electron/server/nedb.ts:360-380`

**为什么**：`/getHistory` 现在用 `loadMeta()`，而它是 `projection({ data: 0 })` —— **拿不到 size**。
必须在这一层算 `bytes`（**唯一聚合点**），不能让调用方各自去读 `data`。

```ts
export interface MetaQuery {
    /** 是否顺带算出这条记录的字节总量（= data[].size 之和，纯内存） */
    withBytes?: boolean;
    /**
     * 排序键。
     *   'path'      = (serial, relPath)：黄页默认 —— 同盘相邻，老盘的记录不会被时间冲底
     *   'create_at' = 旧的默认（最近扫描在前）
     */
    sortBy?: 'path' | 'count' | 'create_at' | 'bytes';
    dir?: 1 | -1;
}

export function loadMeta(q: MetaQuery = {}): Promise<(CacheMeta & { bytes?: number })[]> {
    assertUsable();
    return new Promise((resolve, reject) => {
        // 用 Cursor 形式（理由见原注释：find(query, cb) 那个重载把回调标成 any）。
        // 这里**不加 projection** —— 要算 bytes 就必须拿到 data；真库实测：
        // 整库本来就在内存里（node_modules/@seald-io/nedb/lib/datastore.js:416 getAllData()），
        // 多走一趟 data 是纯内存遍历（213 条 0.07 ms），零新增磁盘 I/O。
        nedb.find({}).exec((err, docs) => {
            if (err) return reject(err);
            const rows = (docs as SearchCache[]).map(({ data, ...m }) => ({
                ...m,
                ...(q.withBytes
                    ? { bytes: Array.isArray(data) ? data.reduce((n, it) => n + (it.size || 0), 0) : 0 }
                    : {}),
            }));
            resolve(sortMeta(rows as (CacheMeta & { bytes?: number })[], q) as (CacheMeta & { bytes?: number })[]);
        });
    });
}

function sortMeta<T extends CacheMeta & { bytes?: number }>(rows: T[], q: MetaQuery): T[] {
    const dir = q.dir ?? (q.sortBy === 'path' ? 1 : -1);
    const key = q.sortBy ?? 'create_at';
    const cmp = (a: T, b: T) => {
        if (key === 'path') {
            return a.serial === b.serial
                ? a.relPath.localeCompare(b.relPath, 'zh')
                : a.serial.localeCompare(b.serial);
        }
        if (key === 'count') return (a.count || 0) - (b.count || 0);
        if (key === 'bytes') return (a.bytes || 0) - (b.bytes || 0);
        return (a.create_at || '').localeCompare(b.create_at || '');
    };
    return rows.sort((a, b) => cmp(a, b) * dir);
}
```

⚠️ **默认值必须与老行为一致**：不传参 → `sortBy='create_at'`, `dir=-1`。
所以现有的 `listDisksController` **不用改一行**（它只是遍历统计，顺序无所谓）。
⇒ 去掉原来 `nedb` 的 `.sort({create_at:-1})`，排序改到内存做（213 条，无成本；且 `path` 排序 nedb 表达不了）。

- [ ] **Step 1**：按上面替换 `loadMeta`；加 `MetaQuery` + `sortMeta`。
- [ ] **Step 2**：`npm run typecheck` → 0 error（`tsc -p tsconfig.electron.json` 这一段）。
- [ ] **Step 3**：**重启 dev**，用户按 ↻ 刷新：面板列表**顺序不变**（仍是最近扫描在前）—— 证明默认值没破坏老行为。

### Task B3：`/getHistory` 返回 `bytes` + 支持排序参数

**Files:** Modify `electron/server/index.ts:830-863`

```ts
async function getHistory(req: Req, res: http.ServerResponse) {
    const serial = req.params?.get('serial') || '';
    const keyword = (req.params?.get('path') || '').trim().toLowerCase();
    const pageNo = Number(req.params?.get('pageNo')) || 1;
    const pageSize = Number(req.params?.get('pageSize')) || 10;
    // 排序：前端传 sort 才用；不传 = 老行为（create_at 倒序）
    const sortBy = (req.params?.get('sort') || 'create_at') as MetaQuery['sortBy'];
    const dir = req.params?.get('dir') === 'asc' ? 1 : -1;

    try {
        const drives = await getDrives();
        const letterOf = new Map<string, string>(drives.map(d => [d.serial, d.drive]));

        // withBytes=true：每行多一个 bytes（该层文件字节和）。纯内存，不读盘。
        let metas = await loadMeta({ withBytes: true, sortBy, dir });
        if (serial) metas = metas.filter(m => m.serial === serial);
        if (keyword) metas = metas.filter(m => m.relPath.toLowerCase().includes(keyword));

        const records: HistoryRow[] = metas.slice((pageNo - 1) * pageSize, pageNo * pageSize).map(m => {
            const drive = letterOf.get(m.serial);
            return {
                ...m,
                path: drive ? toFullPath(drive, m.relPath) : toAnchorPath(m.serial, m.relPath),
                online: !!drive,
            };
        });

        sendJson(res, { records, total: metas.length, current: pageNo, size: pageSize });
    } catch (e) {
        console.error('[getHistory] 查询失败:', e);
        sendJson(res, { code: 500, error: String(e) });
    }
}
```
⚠️ **过滤后再分页是对的**（保持原逻辑）；但排序是**在过滤前**做的 —— 与老的"过滤后再切片"顺序无关，结果一致。

- [ ] **Step 1**：按上面改；`import type { MetaQuery }` 从 `./nedb`。
- [ ] **Step 2**：`HistoryRow` 类型改成 `CacheMeta & { bytes?: number; path: string; online: boolean }`；`BrowseHistoryWithPagination` 里的 records 类型同步（`nedb.ts` 的 `BrowseHistory`）→ 若 TS 报错，把 `bytes` 加成可选即可。
- [ ] **Step 3**：`npm run typecheck` → 0 error。
- [ ] **Step 4**：**重启 dev** + 用户刷新，用浏览器/curl 抽查一次：
  `curl "http://127.0.0.1:3060/getHistory?pageNo=1&pageSize=3&sort=bytes&dir=desc" -H "t: <口令>"`
  期望：第一行的 `bytes` 与探针实测的 **528868593192**（`AAAA1111/示例分类目录/示例演员A`，492.55 GB）一致。

### Task B4：前端消费 `stats` / `bytes` / 排序

**Files:** Modify `electron/server/index.ts:780-814`（`/getDisks` 加 `stats`）·
`src/components/HistoryTable/index.vue`（总览句 / 大小列 / 表头排序）

**`/getDisks` 加 `stats`**（数据全在内存里，除库大小那次 `fs.stat` 是**本地文件**）：

```ts
const lastScanAt = metas.reduce((a, m) => (m.create_at > a ? m.create_at : a), '');
let dbBytes = 0;
try { dbBytes = (await fsasync.stat(CACHE_DB_PATH)).size } catch { /* 拿不到就不显示 */ }

sendJson(res, {
    disks: [...],                 // 原样不动
    duplicated: findDuplicatedSerials(drives),
    stats: {
        disks: drives.length + offlineSerials(registry, drives).length,
        folders: metas.length,                                          // 实测 213
        entries: metas.reduce((n, m) => n + (m.count || 0), 0),         // 实测 1247
        dbBytes,
        lastScanAt,
    },
});
```

**前端**：
- 总览句：`5 块盘 · 213 个目录 · 1247 个条目 · 已读到 3.35 TB · 库 81.7 MB · 最近扫描 09-27 22:32`
  ⚠️「已读到 3.35 TB」的措辞**不许改成"当前"或"硬盘上"** —— 它是**扫描那一刻的快照**（方案 §3.4 规矩 2）。
  `3.35 TB` 从哪来：`/getHistory` 不带分页时 `total` 只有条数，**拿不到全库字节和** →
  在 `stats` 里加一项 `bytes: metas.reduce((n,m)=>n+(m.bytes||0),0)`（给 `loadMeta` 传 `withBytes:true` 即可）。
- 大小列：在「条目」「上次扫描」之间插入 `{ title: '大小', key: 'bytes', width: 96, align: 'right', render: r => formatBytes(r.bytes), sorter: true }`。
- 表头排序：给「条目 / 大小 / 上次扫描」加 `sorter: true`，在 `n-data-table` 上接 `@update:sorter` → 换算成 `sort`/`dir` 重新请求。
- 默认排序：`model` 里加 `sort: 'path'`、`dir: 'asc'`（**改默认值** → 见方案 P1-9；用户若不同意，改回 `'create_at'`/`'desc'` 就行）。

- [ ] **Step 1**：`/getDisks` 加 `stats`（含 `bytes`）；`DiskRow` 旁的 `stats` 类型定义。
- [ ] **Step 2**：前端读 `stats`，渲染总览句；「打开存放文件夹」文字链挪到总览句右侧。
- [ ] **Step 3**：加「大小」列 + 表头排序 + 默认 `sort:'path'`。
- [ ] **Step 4**：`npm run typecheck` → 0 error。
- [ ] **Step 5**：**重启 dev** + 用户目视：
  ①总览句数字与探针一致（**5 / 213 / 1247 / 3.35 TB / 81.7 MB / 09-27 22:32**）；
  ②最大那行显示 `492.55 GB`（不是 `0.00GB` 也不是负值）；
  ③`示例分类目录` 那行显示 `104 / —`；
  ④点「大小」表头 → 降序，最大在最上；
  ⑤默认列表同盘相邻。

### 阶段 B 验收 + 回退

| 验收 | 动作 |
|---|---|
| 类型 | `npm run typecheck` → 0 error |
| 数据 | 总览 5 个数字 + 每行大小与探针**逐一对得上** |
| 回归 | 阶段 A 的 3 条回归再走一遍（双击 / 翻页 / 折叠区） |
| **读盘** | 用任务管理器观察：打开面板 + 搜索 + 排序**不应**出现移动硬盘读活动 |
| 回退 | 改的是 `nedb.ts` + `server/index.ts` + `HistoryTable` + `utils` + `index.vue` 5 个文件 → 逐个还原 |

---

## 4. 阶段 C · 结构与交互（本轮做了 4 项；**故意不做** 3 项）

### 做了的 4 项

| # | 做了什么 | 为什么 |
|---|---|---|
| C1 | **打开面板不再强扫盘符**：`/getDisks` 默认走 `getDrives(false)`（进程内缓存，一次盘都不扫），只有前端传 `?refresh=true`（点「刷新」）才真重探。顺带：用缓存列表时**不再** `syncRegistry` 写 `disks.json`（没有新信息的写不该做，也免得把 `lastSeenAt` 刷成"刚刚见过"而那块盘早拔了） | 直接服务"减少读盘"这条最高优先级。⚠️ `stat('X:/')` 会不会唤醒休眠的移动硬盘 **我仍未实测** —— 不确定的事就不该每次打开都做几十遍。代价：启动后新插的盘要按一下「刷新」才出现（用户已接受） |
| C2 | **删除也进唯一写入链**：`nedb.ts` **删掉** `removeByIds`；`removeHistoryBatch` 先把 `_id` 翻译成主键，再让每条删除进各自 `queueCacheWrite` | 修"删了又回来"这个**真缺陷**。为什么是删口而不是加守卫 —— 见下 |
| C3 | **离线盘可辨认**：下拉里离线盘显示 `离线(CD72)`（序列号后 4 位）而不是笼统的「未插入」 | 卷标至今全空，两块盘都不在时原来只能靠目录数猜"哪个是哪个"。**零新端点、零写入** |
| C4 | **搜索也认盘符**（整词相等：`f` / `f:` = 那块盘的全部记录，**不做子串匹配**）+ **打开面板自动聚焦搜索框** | 键盘路径的第一落点；做成子串匹配会让搜一个含字母的词把整块盘捞进来，用户看不出为什么 |

### C2 为什么是"删掉那个 API"而不是"给调用方加守卫"

判据用用户定的那条：**以后同类场景还会不会复发？**
只要 `nedb.ts` 还导出"按 `_id` 批量删"，将来再有人要批量删，顺手拿到它就又开了一个口。
删掉之后，库里**没有**绕开主键的删除能力 ⇒ 任何删除只能走 `removeCache`（按主键），
而服务端只有一个地方调它 —— 那一处已经在链里了。责任放回**唯一的写入点**，不放在每个调用方。

**证据（实测）**：`docs/probes/remove-race/`（对照探针，可一键复算）
—— 版本 A（不进链）复现了"删了又回来"（记录仍在），版本 B（进链）记录确实没了。
⚠️ 它验的是**机制**（同主键上的写操作必须串行），**不是真服务端的端到端时序**，README 里写明了。

**顺带发现（未处理，记录在案）**：`electron/server/assistant/apply.ts:261-262` 也在链外直接调 `removeCache`。
性质更轻（它是"失效让它重建"，最坏是多扫一次，**不会留下陈旧记录**）。本轮没动它 —— 另一个模块的职责。

### 故意不做的 3 项（附理由）

| # | 不做 | 为什么 |
|---|---|---|
| ❌ | **盘条 chips 换掉下拉** | 用户刚验收过下拉这一版，而 chips 是"更好看"不是"更对"。真正的问题（离线盘认不出）已由 C3 **零成本**解决 —— 奥卡姆：不为审美去动刚验收的交互 |
| ❌ | **盘可改名**（`POST /setDiskLabel`） | 要新增一个写入端点 + 就地编辑交互，而 **C3 已解决 80%**（能分辨是哪块盘）。真想给盘起名说一声再做 —— 字段与唯一写入点都是现成的 |
| ❌ | **上下键选行 / 回车打开** | 表格行不是可聚焦元素，要自己管焦点 + 滚动跟随，复杂度高；而"打开"已有双击。**成本收益不划算** |
| ❌ | ~~「重读这一条」~~ | v3 就已按硬约束 3 砍掉（那是新开读盘入口） |

---

## 5. 用户在每个阶段要做的事（只有这些）

| 时点 | 你要做的事 |
|---|---|
| 开工前 | 决定 §0.1：先提交现状 / 还是让我每次改前备份文件 |
| 阶段 A 结束 | 按 **↻ 刷新**，走 A1–A7 的目视清单（约 3 分钟），回一句"过"或指出哪条不对 |
| 阶段 B 结束 | **重启 dev**，走 B1–B4 的目视清单；再抽查一次总览 5 个数字 |
| 阶段 B 之后 | 决定要不要进阶段 C（我建议：只把 **C2 删除竞态** 单独做） |

**我全程不会碰你的硬盘数据**：只改源码文件；所有数据库读取都是只读探针。

---

## 6. 自审（写完后自查）

**1. Spec 覆盖**：方案 v3 的 P0-1…P0-7 / P1-1…P1-16 / P2-6 逐条落到任务 ——
A1(P0-5,P1-6) · A2(P0-1 结构) · A3(P0-1 可发现性,P1-3,P1-7,P1-8) · A4(P1-4,P1-11,P1-15) ·
A5(P0-4,P1-5) · A6(P0-2,P0-3) · A7(P0-7) · B1(P2-6) · B2/B3/B4(P1-1,P1-2,P1-9,§3 大小) ·
C1(P1-16) · C2(P1-10) · C3(P0-6) · C4(P1-13,P1-14)。
**P1-12（count=0 的记录）在 A4 的空态/文案里体现**（指路，不加动作）—— 需在 A4 补一行：
对 `count === 0` 的行，目录名后加浅灰小字 `空目录，或上次没读到`。✅ 已列入 A3 的 `.dir-ro` 同款样式。

**2. 占位符扫描**：无 TBD/TODO；每个代码步骤都给了可粘贴内容。

**3. 类型一致性**：`formatBytes`（B1 定义 → B4 使用）· `MetaQuery`（B2 定义 → B3 使用）·
`rowKey`（A5 定义 → A5 用于 `:row-key` 与 `checkedOnOtherPages`）· `listReqSeq`（A4 定义/使用）✅ 一致。

**4. 与四条约束的复核**：不加操作列 ✓（A3 用双击+悬停提示）· 只汇总缓存 ✓（B2 内存聚合）·
不加扫盘 ✓（本轮新增读盘 = 0）· 自查已做 ✓。

---

## 7. 我没把握的地方（执行时会如实回报）

| # | 事项 | 状态 | 影响 |
|---|---|---|---|
| 1 | `stat('X:/')` 会不会唤醒插着的移动硬盘 | **未实测，不确定** | 只影响阶段 C1；不改就维持现状 |
| 2 | 删除与扫描的竞态 | **静态推理，未实测** | 阶段 C2 需要先造一次并发复现再改 |
| 3 | 2 条 `count=0` 是空目录还是被写空的 | **数据分不出来** | 只影响提示文案，绝不动数据 |
| 4 | 「双击 + 悬停提示」够不够可发现 | **要你试**（A3 Step 5 有兜底方案） | 不够就加一列（15 行） |
| 5 | nedb 全库常驻内存 | 静态（读依赖源码 `datastore.js:416`） | 真机若发现面板变慢，立即回报 |
