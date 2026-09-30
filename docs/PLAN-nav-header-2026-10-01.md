# 头部布局 + 导航语义 · 实施计划

> 承接：`docs/DESIGN-HEADER-2026-09-30.md`（布局：分区/有界/折叠）＋ `docs/DESIGN-NAV-2026-09-30.md`（导航语义：绝对链/返回/历史）
> 状态：**待一句"开工"**。阶段 1 **不依赖任何待裁决项**；阶段 2 依赖 §七 的四条决策。
> ⚠️ **本项目的验证方式不是 TDD**（`package.json` 只有 `dev`/`typecheck`/`build`，没有测试框架）——
> 统一用三件套：**`npm run typecheck` 0 error ＋ `docs/probes/` 只读探针 ＋ 真机目视**。
> （已按此改写 `writing-plans` 的 TDD 步骤模板，保留它的结构与粒度。）

**目标**：让「头部高度是常量」＋「位置由路径推导、历史是唯一状态」，从而修掉"从缓存跳转后返回体验怪"。

**架构**：三层分工 ——
① **纯函数层**（`src/utils/`，可用探针断言，零 UI 依赖）；
② **状态层**（`src/views/FileFinder/index.vue` 的 `history`，单一职责）；
③ **呈现层**（CSS 分区 + 折叠）。

**技术栈**：Vue 3 `<script setup>` + naive-ui 2.45.3 + TypeScript。**主进程不动 ⇒ 全程不需要重启 dev。**

---

## 一、先回答「是否真的都成立、都要处理」

**自查 12 条 → 只有 6 条进计划。**

| # | 是否成立 | 是否要处理 | 处置 |
|---|---|---|---|
| S-1 `emptyTip` 判 `dir` 会回归 | **成立**（代码路径清晰） | **必须** | → 阶段 2 Task 2.4 |
| S-2 折叠规则不完备（`…` 只代表 1 段） | 成立 | **要**（零成本） | → 阶段 1 Task 1.2 |
| S-3 面包屑点段：截断→压栈 | 成立 | **必须**（模型决定） | → 阶段 2 Task 2.3（文档已写明这是行为变化） |
| S-4 chip 点击回根放大 `×` 误点 | 成立 | **不处理** | 已决定"不做 chip 点击"⇒ 副作用随之消失，成本 0 |
| S-5 `ancestorsOf` 无 UNC/非盘符兜底 | 成立（低频但可达） | **要**（成本低） | → 阶段 1 Task 1.1 |
| S-6 加载中 vs 失败后状态没分开 | 成立 | ⚠️ **撤出计划** | **核实后：这是既有行为，不是本方案引入**（今天 `handleDirChange` 也会先换面包屑、后到内容）。我上一版把它写成"升级点⑤"是**夸大**了 ⇒ 移入观察项，阶段 2 目视时若觉得刺眼再单独立项 |
| S-7 键盘遍历面包屑 | 成立 | **不处理** | 明确不做（`n-tag` 不可聚焦，成本/收益不划算） |
| S-8 `离线()` 标签会被复制第二份 | 成立 | **要**（成本低） | → 阶段 1 Task 1.1（抽共享函数） |
| S-9 `mode` 收敛 | — | **我撤回** | `folder` 是服务端真实能力，删它是删能力不是删死代码 |
| S-10 跨盘跳转的信息负荷 | 无法单靠推理判定 | **只做最低成本缓解** | → 阶段 3 Task 3.4（chip 加一句 tooltip），其余目视决定 |
| S-11 "根的范围感消失" | 无法判定 | **观察，不阻塞** | 需你一句话；不改也不影响正确性 |
| S-12 盘符复用 | 成立 | **范围外** | 全应用既有（服务端每次 `stat` 复核盘身份），面包屑只是把它显示出来 |

> **真正不可省的三条**：S-1（会引入回归）、S-3（不这么做面包屑会显示假路径）、以及它俩背后的"位置/历史"拆分。
> 其余都是低成本顺带或明确不做。**没有一条是"为了完整而做"。**

---

## 二、顺序为什么必须是「先布局、后语义」

**一个耦合事实**：面包屑从"相对用户选的根"改成"绝对路径链"之后，会**比今天更深**
（多出盘符 + 用户根之上的层级）⇒ 段数变多 ⇒ 在 `flex-wrap: wrap` 的容器里**更容易换行**。

> ⇒ **若先做 NAV，头部会临时变得更矮不下去**（把网格挤得更狠）。
> ⇒ 所以顺序是：**先让"头部不可能变高"（阶段 1），再让面包屑变深（阶段 2）。**

---

## 三、文件地图（谁负责什么）

| 文件 | 阶段 | 改动 |
|---|---|---|
| `src/utils/index.ts` | 1 | **新增** `offlineLabel()` / `ancestorsOf()` / `foldPath()` / `foldCrumbList()` 四个纯函数（+ 在文件末尾放探针可导入的导出） |
| `docs/probes/crumbs/run.mjs` | 1 | **新建**：喂假路径断言四个纯函数（**不读盘**） |
| `src/views/FileFinder/index.vue` | 1 | 模板加 `.nav-zone` 包裹层；`<style>` 加分区与有界规则 |
| `src/components/FolderSelector/index.vue` | 1 | tag 内文本用 `foldPath()` + `title`/tooltip |
| `src/components/HistoryTable/index.vue` | 1 | `diskLabel()` 改用共享 `offlineLabel()`（S-8） |
| `src/views/FileFinder/index.vue` | 2 | **状态层重写**：`openStack`+`searchStack`+`scrollY` → `history: NavEntry[]`；面包屑改 `ancestorsOf(currentPath)`；`onBack`/`handleJump`/`handleDirChange`/`openHistory`/`onRefresh`/`startScan` 随动；**`emptyTip` 判据改 `history.length > 0`（S-1）** |
| `src/views/FileFinder/index.vue` | 3 | `Backspace` 快捷键、可点/不可点视觉区分、`›` 分隔符、当前段 spinner、chip tooltip |

---

## 四、阶段 1 · 零件 + 布局（**行为零变化**，不依赖待裁决项）

> **产出**：头部行数恒定 = 1；面包屑超长折叠；chip 与 tag 文本有界。
> **行为**：面包屑仍是"相对根"的链，返回/跳转语义**一行不改** ⇒ 出问题只是不好看，不会错。
> **回退**：只动 CSS + 一处模板包裹 + FolderSelector 显示，`git revert` 单文件即可。

### Task 1.1 四个纯函数（`src/utils/index.ts`）

**Files:** Modify `src/utils/index.ts`（追加）；参考已存在的 `formatBytes`

- [ ] **Step 1：追加 `offlineLabel`（S-8：与缓存面板共用一份格式）**

```ts
/**
 * 离线盘的显示名。**唯一实现** —— 原来只写在 HistoryTable 的 `diskLabel()` 里（本地实现），
 * 面包屑首段也要用同一个格式，所以收上来（否则以后改文案要改两处）。
 * 为什么用序列号后 4 位：`DriveInfo.label` 从来没被赋值（`driveIdentity.ts` 的 probe() 写死 ''），
 * 只能靠序列号区分"是哪一块盘"。
 */
export const offlineLabel = (serial: string) => `离线(${String(serial || '').slice(-4)})`
```

- [ ] **Step 2：追加 `ancestorsOf`（位置：由路径纯推导，不存状态）**

```ts
/** 面包屑的一段。`kind: 'root'` = 首段（盘符 / 离线锚点），**永远不可点** */
export interface PathCrumb { name: string; path: string; kind: 'root' | 'dir' }

const ANCHOR_PREFIX = '#'

/**
 * 把一条路径拆成"从起点到当前"的完整链。**纯函数、零查询、零读盘**。
 *
 * 三种形态（都实测于现有数据来源）：
 *   E:/videos/a     → E: / videos / a            （在线）
 *   #CD72/videos/a  → 离线(CD72) / videos / a     （离线只读锚点，见 server 的 ANCHOR_PREFIX）
 *   \\server\share\x → server / share / x          （UNC / 网络位置的兜底，S-5）
 *
 * 为什么要它：跳转之后"我在哪"必须能算出来。如果靠导航栈记，跨盘跳转就会拼出一条
 * **物理上不存在的路径**（详见 docs/DESIGN-NAV-2026-09-30.md §12.3 的推演）。
 */
export function ancestorsOf(fullPath: string): PathCrumb[] {
    const raw = String(fullPath || '')
    if (!raw) return []

    // ① 离线只读锚点
    if (raw.startsWith(ANCHOR_PREFIX)) {
        const segs = raw.slice(1).split('/').filter(Boolean)
        const serial = segs.shift() || ''
        const root = `${ANCHOR_PREFIX}${serial}`
        const out: PathCrumb[] = [{ name: offlineLabel(serial), path: root, kind: 'root' }]
        let acc = root
        for (const s of segs) { acc += `/${s}`; out.push({ name: s, path: acc, kind: 'dir' }) }
        return out
    }

    // ② 盘符路径
    const m = /^([A-Za-z]):[\\/]?(.*)$/.exec(raw)
    if (m) {
        const drive = m[1].toUpperCase()
        const out: PathCrumb[] = [{ name: `${drive}:`, path: `${drive}:/`, kind: 'root' }]
        let acc = drive
        for (const s of (m[2] || '').split(/[\\/]+/).filter(Boolean)) {
            acc += `/${s}`
            out.push({ name: s, path: acc, kind: 'dir' })
        }
        return out
    }

    // ③ UNC / 网络位置 / 虚拟盘：没有盘符，首段就是第一段
    const unc = /^[\\/]{2}/.test(raw)
    const out: PathCrumb[] = []
    raw.split(/[\\/]+/).filter(Boolean).forEach((s, i) => {
        const p = i === 0 ? (unc ? `\\\\${s}` : s) : `${out[i - 1].path}/${s}`
        out.push({ name: s, path: p, kind: i === 0 ? 'root' : 'dir' })
    })
    return out
}
```

- [ ] **Step 3：追加 `foldPath`（单条字符串有界，给 chip 用）**

```ts
/**
 * 把长路径压成"首段 + … + 末 N 段"。给**单个字符串**用的（chip），
 * 与 `foldCrumbList`（给**面包屑整条**用的）是两件事，别混。
 * ⚠️ 不用 CSS 的 `direction: rtl` 反向截断 —— 它会把 `E:/` 里的 `/` 排到错位置。
 */
export function foldPath(fullPath: string, keepTail = 2): string {
    const crumbs = ancestorsOf(fullPath)
    if (!crumbs.length) return ''
    if (crumbs.length <= keepTail + 1) return crumbs.map(c => c.name).join('/')
    return [crumbs[0].name, '…', ...crumbs.slice(-keepTail).map(c => c.name)].join('/')
}
```

- [ ] **Step 4：追加 `foldCrumbList`（层级折叠，含 S-2 的修正）**

```ts
export interface CrumbFold { head: PathCrumb; hidden: PathCrumb[]; tail: PathCrumb[] }

/**
 * 面包屑的折叠决策。返回 `null` = 全显。
 *
 * 规则：超过 `max` 段就折中间，**保首段 + `…` + 末 2 段（父 + 当前）**。
 * ⚠️ S-2 修正：**`…` 至少代表 2 段才折** —— 否则 5 段路径会渲染成
 * `E: › … › 父 › 当前`，白白多一次点击（而它本来可以直接显示那一段）。
 */
export function foldCrumbList(crumbs: PathCrumb[], max = 4): CrumbFold | null {
    if (crumbs.length <= max) return null
    const head = crumbs[0]
    const tail = crumbs.slice(-2)
    const hidden = crumbs.slice(1, crumbs.length - 2)
    if (hidden.length < 2) return null
    return { head, hidden, tail }
}
```

- [ ] **Step 5：`npm run typecheck`** ⇒ 期望 `0 error`（新增导出不影响任何调用方）
- [ ] **Step 6：提交** `feat(utils): 面包屑纯函数 ancestorsOf / foldPath / foldCrumbList + 共享 offlineLabel`

### Task 1.2 探针（`docs/probes/crumbs/run.mjs`，**只读、零读盘**）

**Files:** Create `docs/probes/crumbs/run.mjs`（输出必须是 **`out.txt`** —— `.gitignore` 挡 `*.log`）
参照既有探针手法：`docs/probes/table-scroll/`、skill `real-module-probe`

- [ ] **Step 1：写探针**（用 `esbuild` 把真实源文件打成 bundle，喂**假路径**断言；不碰 `searchCache.db`、不碰盘）

用例清单（**全部是假数据**）：

| 输入 | 期望 |
|---|---|
| `E:/videos` | `['E:', 'videos']`，首段 `kind==='root'` |
| `E:/` | `['E:']`（尾斜杠不产生空段） |
| `E:/a/b/c/d/videos` | 6 段；`foldCrumbList` 折成 `E: / … / d / videos` |
| `F:/a/b/c` | 4 段；`foldCrumbList` 返回 `null`（全显，边界） |
| `#CD72/videos/示例演员A` | 首段名 `离线(CD72)`；`kind==='root'` |
| `\\\\server\\share\\x` | 首段 `server`；不抛异常（S-5） |
| 中文名 / 含空格 / 含 `&` | 段名原样保留（它们在 URL 里由 `encodeURIComponent` 处理） |
| `''` / `'E:/'` / `'/'` | 不抛异常 |

- [ ] **Step 2：跑探针** ⇒ `node docs/probes/crumbs/run.mjs | tee docs/probes/crumbs/out.txt`，期望 **全绿**（逐条打印 `PASS/FAIL`）
- [ ] **Step 3：提交** `test(probes): crumbs 纯函数探针（8 组假路径，含 UNC 与锚点）`

### Task 1.3 头部三分区（CSS + 一处模板包裹）

**Files:** Modify `src/views/FileFinder/index.vue:10-20`（模板）与 `:1055-1134`（`<style>`）

- [ ] **Step 1：模板 —— 把左区包成 `.nav-zone`**（⚠️ **不要改 `.hstack` 本身**：函数里的两个 popover 也在用它）

```html
<div class="header-bar">
    <!-- 导航区：头部唯一的弹性槽位。子元素个数会变（面包屑 v-for + 返回 v-if），
         所以继续保持裸 flex（naive-ui 2.45.3 的 n-space 会给每个子项写死同一个 key）。 -->
    <div class="nav-zone">
        <FolderSelector ref="folderSelector" v-model="dir" label="请选择文件夹(D)" @change="handleDirChange" />
        <template v-for="(folder, index) in openStack">
            <n-tag v-if="!!folder.name" :key="folder.path" @click="handleJump(folder, index)" style="cursor:pointer">
                <span>{{ folder.name }}</span>
                <n-spin v-if="loading" :size="12" style="margin-left: 8px;" />
            </n-tag>
        </template>
        <n-button v-if="dir" size="small" @click="onBack">返回</n-button>
    </div>
    <div class="toolbar" style="align-self: flex-end">…（原样不动）…</div>
</div>
```

- [ ] **Step 2：CSS —— `.header-bar` 补 `flex-wrap: nowrap`；新增 `.nav-zone`；`.toolbar` 补 `flex: 0 0 auto`**

```less
.header-bar {
    /* ⚠️ 这一行是"头部永远只有一行"的第一道保险 */
    flex-wrap: nowrap;
    /* …原有规则不动… */
}

/**
 * 导航区 —— 头部**唯一**的弹性槽位。
 * `min-width: 0` 是整套的地基：flex 子项默认 `min-width: auto`，
 * 不加它，哪怕写了 `overflow` 也**不会真的收窄**。
 * `max-width: 50%` 来自 Fluent 2 的宽度预算（面包屑占整体 30–50% 是安全的）：
 * 保证动作区永远拿得到 ≥50%。
 */
.nav-zone {
    flex: 1 1 auto;
    min-width: 0;
    max-width: 50%;
    display: flex;
    flex-wrap: nowrap;
    align-items: center;
    gap: 12px;
    overflow: hidden;
}

.toolbar {
    /* 动作区不参与压缩（原 `flex-wrap: nowrap` **不许删**） */
    flex: 0 0 auto;
    /* …原有规则不动… */
}
```

- [ ] **Step 3：单条有界** —— 给面包屑 tag 与 chip 加 `max-width` + 省略号（用 `:deep()`，因为 `n-tag` 是子组件根元素）

```less
.nav-zone {
    :deep(.n-tag) {
        flex: 0 0 auto;
        max-width: 160px;          /* 初值，真机目视定；中文不能用"30 字符"这种字符数规则 */
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
}
```

- [ ] **Step 4：`npm run typecheck`** ⇒ `0 error`
- [ ] **Step 5：真机目视（阶段 1 的核心验收）**
  - 选一个根 → 逐层下钻 5–6 层 → **把窗口拖窄到约 700px**
  - **期望**：头部**始终只有一行**；超长名字出现省略号；窄到极限时是**导航区被裁**而不是换行
  - ⚠️ **此时"当前层可能被裁掉"是已知代价** —— 它由阶段 1 Task 1.4 的折叠解决；**分步验收时不要把它当成 bug**
- [ ] **Step 6：提交** `feat(header): 头部三分区 + 导航区有界化（行数恒定，行为零变化）`

### Task 1.4 折叠上线（用 Task 1.2 的 `foldCrumbList`）

**Files:** Modify `src/views/FileFinder/index.vue`（模板 + script）

- [ ] **Step 1：加 computed**（此时数据源仍是 `openStack`，因为阶段 1 不改状态层）

```ts
/** 面包屑的折叠决策；`null` = 全显。纯函数在 utils，这里只做映射。 */
const crumbFold = computed(() => foldCrumbList(openStack.value.map(l => ({ name: l.name, path: l.path, kind: 'dir' as const }))))
```

- [ ] **Step 2：模板 —— 折叠时渲染 `首段 › … › 父 › 当前`；`…` 用 `n-popover` 列出被折的层（**每层可点跳转**）**

```html
<template v-if="crumbFold">
    <n-tag :key="crumbFold.head.path" @click="handleJump(openStack[0], 0)" style="cursor:pointer">
        <span>{{ crumbFold.head.name }}</span>
    </n-tag>
    <n-popover trigger="click" placement="bottom-start">
        <template #trigger>
            <n-tag style="cursor:pointer"><span>…</span></n-tag>
        </template>
        <!-- 被折的层**每一层都可点** —— 折叠只牺牲"常显"，不牺牲任何能力 -->
        <div class="hstack">
            <n-button v-for="c in crumbFold.hidden" :key="c.path" size="small"
                @click="handleJump(openStack.find(l => l.path === c.path)!, openStack.findIndex(l => l.path === c.path))">
                {{ c.name }}
            </n-button>
        </div>
    </n-popover>
    <n-tag v-for="c in crumbFold.tail" :key="c.path" style="cursor:pointer"
        @click="handleJump(openStack.find(l => l.path === c.path)!, openStack.findIndex(l => l.path === c.path))">
        <span>{{ c.name }}</span>
    </n-tag>
</template>
```

> ⚠️ **阶段 2 会把这里的"用 `path` 反查下标"整段删掉**（那时面包屑由 `ancestorsOf` 直接给出 path，不需要反查）。
> 阶段 1 之所以要多这一层丑陋的反查，是因为数据源还是 `openStack`。**这是刻意的临时形态，写在注释里。**

- [ ] **Step 3：真机目视** —— 造一条 ≥6 层的路径（或临时改 `openStack` 长度）⇒ 期望：`E: › … › 父 › 当前`，`…` 点开能看到被折的层且能跳
- [ ] **Step 4：提交** `feat(header): 面包屑折叠（保首尾、当前层永远可见、… 可点开）`

### Task 1.5 chip 显示有界（S-8 同批）

- [ ] **Step 1：`FolderSelector`** —— tag 内文本改 `foldPath(modelValue)` + `title` 显全路径；`离线()` 不动（那是另一个组件的事）
- [ ] **Step 2：`HistoryTable` 的 `diskLabel()`** 改用 `import { offlineLabel } from '@/utils'` 的共享实现（删掉本地那份）
- [ ] **Step 3：`npm run typecheck` + 真机目视**（选一条很深的根路径 ⇒ chip 显示 `E:/…/末段`，hover 出全路径）
- [ ] **Step 4：提交** `refactor: chip 路径有界化 + 离线盘标签收成共享函数`

---

## 五、阶段 2 · 导航语义（**核心**，依赖 §七 的四条决策）

> **产出**：跳转可撤销、位置可见、**且不引入回归**。
> **回退**：本阶段只动 `index.vue` 一个文件。风险集中在状态重写 ⇒ **先做 Task 2.1（纯搬移，行为不变）再改语义**，两步分开验收。

### Task 2.1 状态搬移：`history: NavEntry[]`（**行为必须与改造前逐条一致**）

**Files:** Modify `src/views/FileFinder/index.vue:193, 328-329, 441-444, 487-502, 700-757, 973-976`

```ts
/**
 * 一屏的历史条目。原来这三样分散在**三个地方**（`openStack` 的元素 / `searchStack` 数组 /
 * 元素上的 `scrollY`），靠"两个数组长度必须差 1"这个**隐式不变量**对齐 ——
 * 本轮要拆语义，继续靠它只会更容易错，所以合并成一个对象数组。
 */
export interface NavEntry { path: string; searchText: string; scrollY: number }

const history = ref<NavEntry[]>([])
/** 当前这一屏的路径。**位置的一切都从它派生**（见 ancestorsOf）。 */
const currentPath = computed(() => history.value[history.value.length - 1]?.path ?? '')
```

随动点（**逐条对照，一条都不能漏**）：

| 位置 | 改动 |
|---|---|
| `isReadOnlyPath` / `readOnlyLevel`（`:380-383`） | 入参从 `openStack[top].path` → `currentPath.value` |
| `pushLevel`（`:487-493`） | 拆成 `pushScreen(path)`（写当前屏 scrollY/searchText，再 push 新屏） |
| `openFolderInCover`（`:495-502`） | 用 `pushScreen()` |
| `onBack`（`:700-714`） | `history.pop()` 后**从新栈顶读** `searchText`/`scrollY`（不再有两个数组要对齐） |
| `handleJump`（`:750-757`） | 阶段 2 只保留"跳转"部分，压栈（Task 2.3） |
| `handleDirChange`（`:727-748`） | 拆成 `setRoot(path)`（清 `history`）与 `jumpTo(path)`（**压** `history`） |
| `refreshAfterApply`（`:441-444`）/ `onRefresh`（`:716-725`） | 读 `currentPath.value` |
| `startScan`（`:891` root、`:975` 收尾刷新） | 读 `currentPath.value` |
| `openHistory`（`:773-775`） | 改为 `jumpTo(path)` |
| `levelName()`（`:474-477`） | **删掉** —— 它只被 `pushLevel` 用来算名字，而那名字以后由 `ancestorsOf` 提供 |

- [ ] **Step 1：按上表逐个改**（每改一处 `npm run typecheck` 一次，避免一次性红一片）
- [ ] **Step 2：真机逐条回归**（这是行为不变验收，**必做**）：选根 → 下钻 3 层 → 返回 2 次（**滚动位置与搜索词都要恢复**）→ F5 刷新 → 面包屑点中间层 → 批量「补全这一片」→ 点树状项开一次
- [ ] **Step 3：提交** `refactor(nav): openStack+searchStack+scrollY 合并为 history（行为不变）`

### Task 2.2 面包屑改绝对链（用 Task 1.2 的 `ancestorsOf`）

- [ ] **Step 1：加 computed**

```ts
/** 面包屑 = 从盘符/锚点到当前的**完整链**，由路径纯推导（不存状态 ⇒ 跳转后自动正确） */
const crumbs = computed(() => ancestorsOf(currentPath.value))
const crumbFold = computed(() => foldCrumbList(crumbs.value))   // 覆盖阶段 1 那版
```

- [ ] **Step 2：模板换成 `${crumbs}` 渲染**；**首段 `kind === 'root'` ⇒ 不可点**（`cursor:default`、无 `@click`）；当前段 ⇒ 纯文本、不可点
- [ ] **Step 3：删掉阶段 1 Task 1.4 里那段"用 path 反查下标"的临时代码**（注释里已标明）
- [ ] **Step 4：真机目视** —— 选根浏览到第 4 层 ⇒ 期望 `E: › videos › a › b`；从缓存跳到 **F 盘**的目录 ⇒ 期望 `F: › … › 父 › 当前`（**且不能是 `videos › a › y` 那种假链**）
- [ ] **Step 5：提交** `feat(nav): 面包屑改为绝对路径链（首段定位不可点，当前段纯文本）`

### Task 2.3 「返回」= 回上一屏 + 跳转可撤销

- [ ] **Step 1：模板条件** `v-if="dir"` → **`v-if="history.length > 1"`**
  （判据从 **`dir` = 曾经选过根** 这个**快照**，改成 **`history.length > 1` = 此刻真有上一屏** 这个**事实**）
- [ ] **Step 2：`openHistory` → `jumpTo(path)`**（**压**历史，不再清空）；`FolderSelector @change` → `setRoot(path)`（清历史，语义不变）
- [ ] **Step 3：tooltip** 加 `返回上一屏（Backspace）` —— 改造后它与面包屑**职责不再重叠**（面包屑 = 位置，返回 = 历史），必须说清
- [ ] **Step 4：真机验收（本计划的核心验收点）**
  1. 选根 `E:/videos` → 下钻两层
  2. 开「缓存记录」→ 双击**另一块盘**的一行 → 期望：面包屑是**新位置的绝对链**，且**「返回」可用**
  3. 点「返回」→ 期望：**回到第 1 步那一屏**（内容 + 滚动位置 + 搜索词都对）
- [ ] **Step 5：提交** `fix(nav): 「返回」判据改事实 + 跳转压历史（从缓存跳转可撤销）`

### Task 2.4 ⚠️ 回归防护（S-1，**必须与 Task 2.3 同批**）

- [ ] **Step 1：`emptyTip`（`:363-369`）的判据** `if (!dir.value) return ''` → **`if (!history.value.length) return ''`**
  理由：`dir` 只表示"用户选的根"；"是否已进入浏览"要用**当下事实**（有没有一屏）。
- [ ] **Step 2：全量过一遍 `dir.value` 的读取点**（`grep -n 'dir.value' src/views/FileFinder/index.vue`）⇒ 期望只剩 `emptyTip`（已改）与 `handleDirChange` 的写入。**多出任何一处都要停下来想清楚：它要的是"根"还是"已进入浏览"。**
- [ ] **Step 3：真机验收（回归场景）** —— **冷启动**（从没选过文件夹）→ 直接开「缓存记录」→ 跳进一个**空目录** ⇒ **期望显示"这个目录是空的"**（改之前会一片空白）
- [ ] **Step 4：提交** `fix(nav): emptyTip 判据改用 history（修"冷启动跳进空目录无提示"）`

---

## 六、阶段 3 · 收尾（小项，可整批做，也可延后）

| Task | 内容 | 文件 | 验收 |
|---|---|---|---|
| 3.1 | 加 `Backspace` 快捷键（在既有 `onKeyup` 的 `target === body` 守卫内；`S`/`D`/`F5` 一个都不动） | `index.vue:1030-1039` | 按 Backspace = 点「返回」；在搜索框里按**不触发** |
| 3.2 | **可点 / 不可点视觉可分**：可点段 = 链接色 + `cursor:pointer`；不可点段 = 普通文字色 + `cursor:default`（首段、当前段） | `index.vue` `<style>` + 模板 | 目视：一眼看出哪些能点 |
| 3.3 | 层级分隔符 `›` 用 **CSS `::before`**（**不加 DOM 子元素** —— 这一组的子元素个数是敏感量） | `index.vue` `<style>` | 目视：层级可读 |
| 3.4 | spinner 只在**当前段**显示；chip 加 tooltip 说明它是"起点/根"（S-10 的最低成本缓解） | `index.vue` 模板 | 目视 |
| 3.5 | 提交 `feat(nav): 收尾 —— Backspace / 可见性区分 / 分隔符 / 单 spinner` | | |

---

## 七、需要你点头的清单（阶段 2 的前置）

**四条决策**（都属"提交讨论"范畴，不是补丁）：

| # | 决策 | 我的定夺 |
|---|---|---|
| D1 | 面包屑从"相对用户选的根"→"**绝对路径链**" | 建议做（Apple HIG 官方模型；且它不需要状态） |
| D2 | 「返回」出现条件 `dir` → `history.length > 1`（**根层不再显示返回**） | 建议做（判据落在事实上） |
| D3 | 跳转**压历史**（⇒ 点面包屑的语义从"截断"变为"压栈"，**点完还能返回**） | 建议做（模型决定，且顺带修好第二处症状） |
| D4 | 面包屑**首段不可点**（点它会打开盘根＝**真读一次盘**） | 建议做（不引入新的读盘路径） |

**三个参数**（真机定，不阻塞）：折叠阈值 4 段 · `Backspace` vs `Alt+←` · tag `max-width` 的 160px 初值。

---

## 八、有把握开始没？

| 阶段 | 把握度 | 依据 | 最担心的一处 |
|---|---|---|---|
| **1** | **高** | 纯 CSS + 4 个纯函数 + 一个只读探针；**行为零变化**；不依赖 §七 任何一条 | 折叠的临时"path 反查下标"写法丑但安全；`max-width: 50%` 在窄窗口下的观感 `[未实测]` |
| **2** | **高** | 静态事实完备（`dir.value` 只有两个读取点，已核）；有明确的回归验收场景 | **Task 2.4（S-1）** —— 这是唯一会引入回归的地方，所以把它排在**同一批**且给了专门的验收步骤 |
| **3** | 高 | 全是局部小改，各自可目视 | `Backspace` 会不会和你别的习惯冲突（可换 `Alt+←`） |

**结论：可以开始。**
- **阶段 1 现在就能开工** —— 它不碰任何待裁决项、不改任何行为、不读盘、不动主进程（不用重启 dev）。
- **阶段 2 需要你先对 §七 的 D1–D4 说一句**（"四条都照做"或指出哪条要改）。

**读盘**：三阶段合计 **零新增端点 / 零扫盘 / 主进程不动**。
唯一被**主动避免**的新读盘路径 = 面包屑首段（D4）—— 如果 D4 改成"首段可点"，就必须在这里申报"点首段会打开盘根、通常未缓存 ⇒ 真读一次盘"。

---

## 九、明确不做（本计划范围内外）

| 不做 | 理由 |
|---|---|
| chip 点击回根（S-4） | 唯一一处"为便利而加"，且会放大 `×`（清空视图）的误点后果；替代方案已存在（面包屑中间段 + 返回） |
| 键盘遍历面包屑（S-7） | `n-tag` 不可聚焦，要自管焦点；本项目是"鼠标 + 单键"习惯，无先例 |
| `mode` 收敛（S-9） | `folder` 是服务端真实能力，删它是删能力 |
| 网格加载态（S-6） | **既有行为，非本方案引入**（我上一版把它当"升级点"是夸大）⇒ 移入观察项 |
| 路线 B（路径下沉）/ C（左侧树）/ 可编辑路径 / 「前进」 | 见 `docs/DESIGN-HEADER-2026-09-30.md` §8、§14 |
| 「范围感」（S-11） | 观察项，需你一句话；不改也不影响正确性 |
| 盘符复用（S-12） | 全应用既有问题（服务端每次 `stat` 复核），不在本次范围 |

---

## 十、自检（对着两篇方案逐节过）

1. **覆盖**：头部方案的"分区/单条有界/折叠/首段 vs 当前段/`…` 可点" → 阶段 1 + 2 + 3；导航方案的"位置推导/历史单一职责/返回判据/跳转压栈/首段不可点/UNC/共享 label" → 阶段 1 Task 1.1 + 阶段 2 全部。**无遗漏**。
2. **占位符扫描**：无 TBD / "适当处理"类措辞；每个改变代码的步骤都给了代码或明确的对照表。
3. **命名一致性**：`ancestorsOf` / `foldPath` / `foldCrumbList` / `offlineLabel` / `NavEntry` / `currentPath` / `history` 在全文与两篇方案里**同名同义**；`levelName` 已明确要**删**（不是重命名）。
4. **与项目铁律核对**：不读盘 ✓ · 六条神圣项一条不动（见导航方案 §7）✓ · 不写 TDD 式假测试 ✓ · 探针证据用 `.txt` ✓ · 不进 `n-space` 加元素（`.nav-zone` 是裸 flex）✓ · 缓存层/`CACHE_*` 完全没碰 ✓。

---

## 十一、实施结果（2026-10-01 已落地，**待真机目视**）

**四个提交**（每个都过了 `typecheck` 0 error）：

| 提交 | 内容 |
|---|---|
| `aed80ed` docs | 两篇方案 + 本计划 + 记忆整理 |
| `68d189c` feat(utils) | 四个纯函数 + 探针 |
| `f1f2390` feat(header) | chip 有界化 + 离线标签共享实现 |
| `bc45048` feat(nav) | 状态模型 + 绝对链 + 折叠 + 返回/跳转 + S-1 防护 + 收尾 |

### 11.1 与计划的偏差（都写出来，别藏）

| # | 偏差 | 理由 |
|---|---|---|
| D-1 | **阶段 1 的"折叠"没有单独做，与阶段 2 合并** | 计划里 阶段 1 的折叠要配一段"用 path 反查下标"的临时代码，而它在阶段 2 必被删。既然 1、2 连做，**不为中间态写一次性代码**；合并后也不会出现"nowrap 已上、折叠未上导致当前层被裁"的中间态 |
| D-2 | **S-2 的准确性质被修正** | 探测后确认：在 `max=4` 下 `hidden` 恒 ≥2，所以 `if (hidden.length < 2) return null` 这条守卫**不可达**，它是**防御性不变量**而不是活缺陷。真正修掉 S-2 的是"末 3 段 → **末 2 段**"（旧规则在 5 段路径下会让 `…` 只代表 1 段）。探针里两个用例分别覆盖这两点 |
| D-3 | **S-10 的缓解降级为"chip 的 `title`"** | 计划说给 chip 加 tooltip 说明它是"起点/根"。落地时判断：`title` 放**完整路径**比一句"起点"信息量更大，再引一个 naive tooltip 会和它抢 —— 所以合成一句：`完整路径 + （这是你的起点；点 × 可清除）`。**不新增浮层** |
| D-4 | **`.crumb` 从 `flex: 0 0 auto` 改成 `flex: 0 1 auto`** | 探针暴露：若每段都不可收缩，窄窗口下"当前层"会被挤到屏幕外裁掉 —— 那正是我批评"一行版①"的毛病。改成**可收缩** + `.crumb-current { flex: 0 0 auto }`（当前层永不被压掉） |

### 11.2 探针抓到的两个真问题（这正是建探针的价值）

1. **`ancestorsOf` 盘符分支漏了冒号** —— 拼出 `E/videos` 而不是 `E:/videos`。**点面包屑就会跳到一个不存在的路径**。探针一跑就红。
2. **`.crumb` 不可收缩 ⇒ 窄窗口裁掉当前层**（见 D-4）。这条是布局探针（真 Chromium）发现的，纯静态读代码看不出来。

### 11.3 硬证据（`docs/probes/header-width/out.txt`，真 Chromium + 真 naive-ui + **真 scoped CSS**，零读盘）

```
new 头部高：640→36px  800→36px  1280→36px  1920→36px     ← 常量 ✓
old 头部高：640→196px 800→196px 1280→116px 1920→76px      ← 内容的函数 ✗
new 截断段数：3/3/3/2 · 当前段可见 四档全 true · 工具条未溢出 四档全 true
new 分隔符 ::before content：["›","›","›","›"]             ← scoped 规则命中
new 导航区宽：640→12px  800→172px  1280→616px  1920→936px
```

⇒ 原始诊断（"头部高度是用户数据的函数"）**实测成立**，且已被改成常量。

### 11.4 补做的一处验证缺口：真 scoped CSS（这是"下一步"里我自己不信的那一条）

**问题**：11.3 的第一版探针用的是**手抄的等效 CSS**。手抄只能证明"这套写法在普通 CSS 下成立"，
**证明不了 `:deep(.n-tag__content)` 与 `.crumb:not(.crumb-root)::before` 在 scoped 转换之后是否还命中** ——
而这两条恰好是我新写的、最容易在转换后失效的规则。这是本轮唯一一处"**声明了却没验证**"的地方。

**补法**：新增 `docs/probes/header-width/build-css.mjs`，用 `vue/compiler-sfc` 的 `compileStyleAsync`
把两个 SFC 的 `<style scoped>`（less + scoped）**真实编译**成 `css-real.generated.css`，
探针的 `new` 变体改用它（并给元素打上 `data-v-probe`）；`old` 变体保持手写复刻（它代表旧代码）。
`run.sh` 会先重建 CSS 再跑。

**结果**：编译出的选择器与我预期完全一致 ——

```
.nav-zone .crumb[data-v-probe] .n-tag__content      ← :deep() 命中（属性在 .crumb 上、内层不带）
.nav-zone .crumb .crumb-text[data-v-probe]          ← 插槽内容属于父作用域
.nav-zone .crumb[data-v-probe]:not(.crumb-root)::before   ← 分隔符规则生成成功
```

而且**运行期有独立证据**：`::before` 的 computed `content` 在四档宽度下都是 `"›"`（不是 `none`）——
假若 scoped 转换没命中，这里必然是 `none`。**至此"CSS 规则在真实编译下生效"从推理变成了实测。**

### 11.5 已知局限（含实测数字）

> ⚠️ 本节在 2026-10-01 后续评测中**被修正过一次**：原来写"窗口 ≲900px 时面包屑被压成「…」"，
> 属于**推理**；实测（并且修掉了探针漏打 scoped 属性、把输入框量小 25px 的保真 bug 之后）发现
> **情况比那更严重**，完整数据与瘦身方案见 `docs/DESIGN-HEADER-2026-09-30.md` §18。

- **约 650px 以下，工具条会溢出头部、导航区被压到 0** —— **实测**：

  | 窗口 | 工具条 | 导航区 | 工具条是否溢出 |
  |---|---|---|---|
  | 1280 | 605 | 616 | 否 |
  | 800 | 605 | 147 | 否 |
  | **640** | 605 | **0** | **是（约 13px）** |

  根因：本轮把 `.toolbar` 设成 `flex: 0 0 auto`（不参与压缩），而导航区可收缩到 0
  ⇒ 需求宽度超过容器时**溢出**。**这是本轮引入的**（改造前 `flex-wrap: wrap` 会换行、不溢出）。
  ⇒ 修法与用户提的"工具条瘦身"是同一件事（见 HEADER §18）。
- **未实测**：真机观感（颜色、`›` 位置、当前层加粗）· 真机五条导航路径回归 · 祖先段"通常已缓存"。
- **列名 `顶边簇数(仅参考)` 不是"行数"**（详见探针 README）。

### 11.6 探针自身的两处误报（已修，记下来别再犯）

1. **行数不能用"直接子元素顶边去重"**：`align-items: center` 下同一行里高度不同的元素顶边本来就不同 ⇒ 那个量法**恒为 2 行**（第一版就错了，把 `new` 判成不合格）。
2. **不能把"没有 `<script setup>`"当问题**：`FolderSelector` 是合法的 Options API 组件（`defineComponent` + `<script lang="ts">`），探针第一版在它身上误报过一次。

### 11.7 明确没做（与计划一致）

- **没做**：chip 点击回根（S-4，§八 已说明理由）· 键盘遍历面包屑（S-7）· `mode` 收敛（S-9）· 网格加载态（S-6，既有行为、非本方案引入）
- **真机回归清单（下一步）**：选根 → 下钻 3 层 → 返回 ×2（**滚动位置与搜索词都要恢复**）→ F5 → 点面包屑中间段（**点完要还能返回**）→ 批量「补全这一片」→ 「缓存记录」跳到**另一块盘** → **点「返回」回到刚才那屏**（本轮核心验收）
