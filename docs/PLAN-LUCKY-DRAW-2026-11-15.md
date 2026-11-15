# 手气不错 · 随机抽取（CD 专辑版）实施计划

> **给执行者：** 本项目**没有测试框架**。每个任务用项目既定的验证三件套：`npm run typecheck`（0 error）+ `docs/probes/` 只读探针（纯逻辑）+ 真机目视（视觉/交互）。
> **不要写 TDD 式假测试**，不要引入测试框架。
>
> **Design（spec）:** `docs/DESIGN-LUCKY-DRAW-2026-11-15.md` —— 本计划的每个值与裁决都来自它，执行时必须两份一起读。
> **参考形态（只读、不复制代码与素材）:** `D:\code\holo-reverse\src\styles.css`（185 行）、`src/app.js`。

**Goal:** 在左轨新增一级入口「手气不错」，从全库已缓存封面里随机抽 5 张，以一个未拆封 CD 盒的拆封动画爆开成 5 张 3:4 竖版专辑内页，双击任意一张用系统播放器打开；全程零读盘。

**Architecture:** CSS 3D（`perspective` + `preserve-3d`）+ Canvas 2D 彩带 + Web Audio 合成音效，不引 three.js。随机池与在线判定全部走已有接口（`/getAllCovers`、`/getDisks`），封面走已缓存的 bin。质感分两类层：**光照层**（清漆 + 眩光）压在整个封面之上，**色相层**（彩虹箔）只给装饰件。

**Tech Stack:** Vue 3 `<script setup>` + TypeScript + Less + naive-ui（`NSwitch`/`NCheckbox`/`useNotify`）+ 项目 `tokens.css` 令牌 + 项目 `playfx` 音效引擎。

## Global Constraints

- **零读盘**：不新增扫描、抽帧、缓存写入。不调 `/getDisks?refresh=true`。
- **样式**：业务 `.vue` 内**禁止** `#hex` / `rgba()` 字面量，一律 `var(--ff-*)`；新语义色先进 `src/styles/tokens.css`。护栏：`node docs/probes/tokens/no-raw-color.mjs`。
  - 例外仅限 `docs/probes/lucky-texture/spike.html`（探针工件，不在 `src/`，不参与构建）。
- **文件规模**：单个新建文件 ≤ ~250 行；纯逻辑必须抽 `.ts`，不埋在 SFC 里。
- **同一件事共用一份实现**：卡片→播放只允许一个实现（`src/views/FileFinder/openCover.ts`）。
- **不改** `SearchCache` 结构、`CACHE_VERSION`、`wire()` 出口、`server/videoExt.ts` 的视频扩展名真相源。
- **视频扩展名**：渲染层**不能** import `electron/server/videoExt.ts`（那个目录会把 `node:fs`/`http`/`nedb` 拖进渲染 bundle —— 该文件头已写明）。新代码一律用渲染层副本 `src/utils/videoExt.ts` 的 `RENDER_VIDEO_EXT_RE`，它的名单以服务端那份为唯一真相源。
  - ⚠️ 原计划这里写"一律 import server/videoExt"，是错的，实现时已纠正。`FileFinder/index.vue` 自己的 `VIDEO_EXT_RE` 属既有行为，本次不碰。
- 提交信息风格：`feat(lucky): lowercase english`，一任务一提交。

## Review Focus

这些是 spec 没写、但一定会咬人的地方，每个都在下面的任务里配了对应的验证：

1. **KeepAlive 下离页不触发 unmount** ⇒ RAF/Canvas/计时器必须显式停（照抄 `Tunnel/index.vue` 的 idle dispose 模式），否则后台一直烧电。
2. **3D 深度导致点击穿透**：卡片被盒盖挡住时仍可点、或盒盖挡住后无法点卡 —— `pointer-events` 必须在每个 3D 层上显式给。
3. **封面加载失败**（bin 被清、sig 假）⇒ `<img>` 必须有 onerror 兜底灰底，不许留白洞。
4. **池子边界**：`< 5` 时不许补齐/越界；`= 0` 时必须给空态而不是空白舞台。
5. **离线条目**：双击必须给出「磁盘未在线」而不是静默失败；`resolveAnchor` 的错误 kind 要走 `notify`。
6. **浅色主题**：彩虹箔在 `#f1f2f3` 画布上最容易变成"塑料糖纸"，必须两套主题都目视。

---

## 文件结构

| 文件 | 职责 | 动作 |
|---|---|---|
| `docs/probes/lucky-texture/spike.html` | 质感标定（3 组配方，可拖入任意图片） | 新建 |
| `src/views/Lucky/drawModel.ts` | 纯逻辑：候选筛选、抽 5 张、格式化（零 IO） | 新建 |
| `src/views/Lucky/usePool.ts` | IO：拉 `/getAllCovers` + `/getDisks` | 新建 |
| `src/views/Lucky/discCase.ts` | 纯几何/物理：撕裂段、弹簧、扇形落点 | 新建 |
| `src/views/Lucky/index.vue` | 页面编排：状态机、勾选框、键盘、空态 | 新建 |
| `src/components/LuckyDiscCase/index.vue` | 未拆封盒 + 拆封动画 | 新建 |
| `src/components/LuckyDiscCase/confetti.ts` | Canvas 2D 彩带 | 新建 |
| `src/components/LuckyDiscCard/index.vue` | 单张内页：封面、信息栏、倾斜、光照层 | 新建 |
| `src/views/FileFinder/openCover.ts` | 卡片 → 播放（唯一实现） | 新建 |
| `src/views/FileFinder/file-meta.ts` | 复用 `thumbUrl` / `fileNameOf` | 只读引用 |
| `src/views/Tunnel/index.vue` | `handleSelect` 改为调用 `openCover` | 修改（行为不变） |
| `src/views/Shell/nav.ts` | 加 `lucky` 一级入口 | 修改 |
| `src/router/index.ts` | 加 `/lucky` 懒加载路由 | 修改 |
| `src/styles/tokens.css` | 加 CD 语义令牌 | 修改 |
| `src/utils/sfx/recipes.ts` + `index.ts` | 加 2 个音效事件 | 修改 |
| `docs/probes/lucky-draw/probe.cjs` | 数据层探针 | 新建 |

---

## Task 0: 质感标定 spike（先做，产物决定后面所有 CSS 参数）

**Files:**
- Create: `docs/probes/lucky-texture/spike.html`
- Create: `docs/probes/lucky-texture/README.md`

**Interfaces:**
- Consumes: 无（独立 HTML，file:// 直接打开）
- Produces: 一份**他选定的配方编号**（A/B/C）+ 他口头确认的强度（大概"太强/刚好/太弱"），写进本文件末尾的「标定结果」并回填 DESIGN 文档。

**为什么先做这个：** 质感不能靠我猜。三组配方并排、用他真实的封面看，30 秒就能定，比事后返工便宜一个量级。

- [ ] **Step 1: 写 `spike.html`**

要求（自包含，无外网、无依赖、file:// 可开）：
- 三张 3:4 卡并排（每张 ~240×320），同一张底图，三组不同叠加层：
  - **A 只光照**：`glaze`（`inset` 玻璃倒角高光 + 顶部亮线 + 两条斜向窗反射）+ `glare`（径向渐变跟随鼠标，`overlay`）
  - **B 光照 + 薄箔全身**：A + 彩虹 `repeating-linear-gradient(110deg,…)` 铺 400%、`color-dodge`、`opacity` 上限 0.28、`filter: brightness(.75) contrast(1.4) saturate(1.2)`
  - **C 光照 + 箔只在装饰件**：A + 只在底部编号条、右上贴纸、左下 6px 书脊上做箔
- 顶部一条拖入区：`<input type="file" accept="image/*">` + dragover，选中的图同时替换三张卡的底图（默认内置一张灰阶渐变占位）
- 鼠标在每张卡上移动 ⇒ 更新该卡的 `--px/--py`（0~100）与 `--hyp`（距中心的倾斜量）
- 每张卡下方一行小字标配方名与一句话说明
- 每个配方下各带一个**深浅两套**预览：页面用左右两半（左浅底 `#f1f2f3`、右深底 `#0e0e0e`）

- [ ] **Step 2: 打开给他看，只要一句话**

Run: `start docs/probes/lucky-texture/spike.html`（或直接双击）
让他拖一张真实封面进去，问："A/B/C 哪个对？"，不做无头截图、不写自动化。

- [ ] **Step 3: 把结果写回文档**

在 `docs/probes/lucky-texture/README.md` 记：选定配方编号、他的原话、日期；并在 `docs/DESIGN-LUCKY-DRAW-2026-11-15.md` 的 §3.3 加一行「标定结果：配方 X（YYYY-MM-DD）」。

- [ ] **Step 4: Commit**

```bash
git add docs/probes/lucky-texture
git commit -m "docs(lucky): texture calibration spike with three overlay recipes"
```

---

## Task 1: 令牌 + 路由 + 左轨入口（空壳能进能出）

**Files:**
- Modify: `src/styles/tokens.css`（在 L2 语义段末尾追加）
- Modify: `src/views/Shell/nav.ts:9`、`:26`、`:29`
- Modify: `src/router/index.ts`
- Create: `src/views/Lucky/index.vue`（此任务只放占位骨架）

**Interfaces:**
- Produces: 路由名 `lucky`、路径 `/lucky`；`RailKey` 联合类型新增 `'lucky'`；令牌名（后续任务只准用这些）：

```
--ff-disc-face       光盘面基色
--ff-disc-sheen      光盘径向反光
--ff-jewel-edge      塑料壳边缘高光
--ff-jewel-shadow    盒体投影
--ff-foil-a/b/c      箔的三段色（浅/中/深主题各一套）
--ff-inner-paper     内页纸基色
--ff-on-paper        内页纸上的文字色
```

- [ ] **Step 1: 加令牌**

在 `tokens.css` 的 L2 语义段末尾、`@media (prefers-color-scheme: dark)`（或项目现有的深色块）里各加一套。**浅色与深色都要有值**，不许只有一边。所有值必须是 `var(--ff-raw-*)` 或新的 L1 原始值，不直接写 `#hex` 在 L2 段（照抄该文件已有段的写法）。

- [ ] **Step 2: 加入口与路由**

- `nav.ts`：`RailKey` 加 `'lucky'`；`RAIL_ITEMS` 在 `'tunnel'` 之后加 `{ key: 'lucky', label: '手气不错', icon: ShuffleOutline }`（`@vicons/ionicons5`，导入同处）；`RAIL_PATHS` 加 `lucky: '/lucky'`。
- `router/index.ts`：`const LuckyPage = () => import('@/views/Lucky/index.vue')`，routes 加 `{ path: '/lucky', name: 'lucky', component: LuckyPage }`。
- `src/views/Shell/index.vue` 的 `active` computed 里，把 `'lucky'` 加进白名单（现在写死了四个名字，漏了会让左轨高亮错位）。

- [ ] **Step 3: 占位页**

`src/views/Lucky/index.vue`：一个全高容器 + 居中一行 `手气不错`。用 `var(--ff-canvas)` 背景。`<style scoped lang="less">`。

- [ ] **Step 4: 验证**

Run: `npm run typecheck` → 期望 0 error
Run: `npm run dev` → 左轨出现第 5 项，点击能进页、能切回文件页、左轨高亮正确
Run: `node docs/probes/tokens/no-raw-color.mjs` → 期望通过

- [ ] **Step 5: Commit**

```bash
git add src/styles/tokens.css src/views/Shell/nav.ts src/router/index.ts src/views/Lucky/index.vue src/views/Shell/index.vue
git commit -m "feat(lucky): add rail entry, route and cd tokens"
```

---

## Task 2: 数据层 `useDraw.ts` + 探针

**Files:**
- Create: `src/views/Lucky/drawModel.ts`（纯逻辑）
- Create: `src/views/Lucky/usePool.ts`（IO）
- Create: `docs/probes/lucky-draw/probe.cjs`、`README.md`、`out.txt`

**Interfaces:**
- Consumes: `TunnelCoverItem`（`electron/server/nedb.ts` 导出）、`/getAllCovers`、`/getDisks`
- ⚠️ **实现时拆成两个文件**（原计划一个 `useDraw.ts`，实施中判定必须拆）：
  - `drawModel.ts` —— 纯逻辑，**零依赖零 IO**，探针能直接 bundle
  - `usePool.ts` —— IO，经 `@/utils/request` 顶层碰 `ipcRenderer`，探针里 import 不了
  - 拆的理由就是探针：合成一个文件后纯逻辑永远测不到（手抄进探针的那份不会红）。
- Produces（后续任务只准用这些签名）：

```ts
// drawModel.ts —— 纯逻辑
export interface DrawCard { key: string; title: string; sig: string; serial: string;
                           letter: string; online: boolean; sizeText: string; src: TunnelCoverItem }
export function formatBytes(n?: number): string;
export function letterMapOf(disks: readonly DiskLike[]): Map<string, string>;
export function candidatesOf(sources, onlineSerials, opts: { includeOffline: boolean; exclude?: ReadonlySet<string> }): TunnelCoverItem[];
export function drawPack(sources, onlineSerials, opts: { includeOffline: boolean; count?: number; exclude?: ReadonlySet<string> }): TunnelCoverItem[];
export function cardOf(src, onlineSerials, letters): DrawCard;
export const RECENT_PACKS = 3;
export function rememberRecent(recent: readonly string[], pack: readonly DrawCard[]): string[];

// usePool.ts —— IO
export interface PoolSnapshot { sources: TunnelCoverItem[]; onlineSerials: Set<string>;
                                letters: Map<string, string>; onlineKnown: boolean; total: number }
export async function fetchPool(): Promise<PoolSnapshot>;
```

**关键判据（写进函数注释）：**
- 去重维度是 `sig`（`/getAllCovers` 服务端已按 sig 与作品名去重，前端只兜"一包内不重复"）。
- `exclude` 命中后若可用数不足 `count`，**放开 exclude 补足**（不能因为记得太多抽不出 5 张）。
- `includeOffline: false` 时，`onlineSerials` 里没有的 serial 直接排除。
- **`onlineKnown === false` 时页面必须强制 `includeOffline: true`** —— 否则 `/getDisks` 一失败，空集会把整个池子滤掉，表现成"没数据了"。
- 洗牌用 Fisher–Yates；`drawPack` 抽前 `slice()` 复制，不改入参。
- 在线判定只信 `disks[].online`；离线盘的 `drive` 一律不用（拔盘那刻旧盘符可能属于别人）。

- [ ] **Step 1: 写 `useDraw.ts`**（按上面的签名与关键判据）

- [ ] **Step 2: 写探针 `probe.cjs`**

照 `docs/probes/playlist/probe.cjs` 的范式：`esbuild` 打包**真源码**到临时 cjs，再断言。产物写同目录 `out.txt`。

必测（每条一个 `check(name, cond, detail)`）：
1. `drawPack` 跑 200 轮、池子 50 条 ⇒ 每轮长度 5 且 `sig` 互不相同
2. 池子 3 条 ⇒ 长度 3（不补齐、不重复）
3. 池子 0 条 ⇒ 长度 0
4. `includeOffline:false` + 5 条里 2 条离线 ⇒ 抽 100 轮，永远不出现离线 serial
5. `exclude` 表示最近 10 条、池子 12 条、`count 5` ⇒ 长度 5 且优先不含 exclude（允许因不足而放开）
6. `formatBytes(undefined)` ⇒ `''`；`formatBytes(2.4*1024**3)` ⇒ 含 `GB`
7. `cardOf` 对离线条目给 `online:false` 且 `letter === ''`

- [ ] **Step 3: 跑探针**

Run: `node docs/probes/lucky-draw/probe.cjs`
Expected: 终端 `pass N / fail 0`，`out.txt` 里有全部条目

- [ ] **Step 4: typecheck + Commit**

Run: `npm run typecheck` → 0 error

```bash
git add src/views/Lucky/useDraw.ts docs/probes/lucky-draw
git commit -m "feat(lucky): draw logic with de-dupe, offline filter and probe"
```

---

## Task 3: `openCover.ts` —— 卡片到播放的唯一实现

**Files:**
- Create: `src/views/FileFinder/openCover.ts`
- Modify: `src/views/Tunnel/index.vue:154-180`（`handleSelect` 换成调用）

**Interfaces:**
- Consumes: `ipcRenderer.invoke('openFile', path)`、`GET /resolveAnchor`、`API_BASE`/`getAction`、`notify`
- Produces:

```ts
export interface OpenableCover {
  serial: string; dir: string; name: string; ext?: string;
  files?: ReadonlyArray<{ name: string }>;
}
export type OpenCoverResult =
  | { ok: true }
  | { ok: false; reason: 'offline'; serial: string }
  | { ok: false; reason: 'error'; message: string };
export async function openCover(src: OpenableCover): Promise<OpenCoverResult>;
```

**行为（照抄隧道页现有逻辑，一字不改）：**
1. `files` 里第一个命中视频扩展名的名字（用 `electron/server/videoExt.ts` 的判断）
2. 否则取 `files[0]?.name`，再否则 `${name}.${ext}` / `${name}`
3. 目标 = `#${serial}/${dir ? dir + '/' : ''}${filename}`
4. `resolveAnchor` 拿到实时路径 → `invoke('openFile', path)`；返回非空串即失败
5. 路径为空或抛错 ⇒ 按 `error.kind === 'offline'` 或消息含"不在"判离线

- [ ] **Step 1: 写 `openCover.ts`**
- [ ] **Step 2: 改 `Tunnel/index.vue` 的 `handleSelect`**

保留它原有的「找不到盘就提示」文案，只把内部换成 `openCover(...)` + 按 `result.reason` 分支 `notify`。**行为、文案、顺序都不许变** —— 这是既有功能，只做去重。

- [ ] **Step 3: 验证隧道页没坏**

Run: `npm run dev` → 进「3D 漫游」，点一张封面，确认仍然拉起播放器；拔掉一块盘再点它的封面，确认仍提示「磁盘未在线」（文案与改前一致）。

- [ ] **Step 4: typecheck + Commit**

```bash
git add src/views/FileFinder/openCover.ts src/views/Tunnel/index.vue
git commit -m "refactor(tunnel): extract cover-to-play into shared openCover"
```

---

## Task 4: 内页卡组件（质感在这里落地）

**Files:**
- Create: `src/components/LuckyDiscCard/index.vue`
- Create: `src/views/Lucky/discCase.ts`（本任务只放倾斜到 CSS 变量的纯函数）

**Interfaces:**
- Consumes: `DrawCard`、`thumbUrl`（`@/utils/thumb`）、Task 0 选定的配方
- Produces:

```ts
// discCase.ts
export interface Tilt { px: number; py: number; hyp: number }  // px/py 0~100，hyp 0~1
export function tiltOf(relX: number, relY: number): Tilt;      // relX/relY ∈ -1..1
export function fanOf(index: number, count: number): { rot: number; dy: number; z: number };
// 中间最高：rot = (i - mid) * 9deg，dy = Math.abs(i-mid) * 14，z = count - Math.abs(i-mid)
```

**Props：** `card: DrawCard`、`index: number`、`count: number`、`active: boolean`
**Emits：** `open(card)`、`focus(index)`

**视觉（按 Task 0 配方）三层结构，顺序不许乱：**
1. `.slab`×3 厚度层（`translateZ(-1.5/-3/-4.5px)`，色 `--ff-inner-paper` 加深）
2. `.face`：`<img>` 封面（`object-fit: cover`，3:4）+ 底部信息栏（标题 1 行 `text-overflow: ellipsis`、`03/05 · C盘 · 2.4 GB`）+ 右上贴纸（在线/离线两态）
3. `.glaze` + `.glare`（`pointer-events:none`，`border-radius: inherit`）

**硬要求：**
- 图片 `@error` ⇒ 换成 `--ff-inner-paper` 纯色底 + 居中 sig 前 6 位（不留白洞）
- 离线：整卡 `opacity:.42`、`filter: grayscale(.6)`，贴纸文字「离线」
- 倾斜用 CSS 变量驱动，不在 JS 里写 `style.transform` 字符串拼接（`--px/--py/--hyp` 由 `tiltOf` 写入）
- `will-change: transform` 只在 hover/active 时加

- [ ] **Step 1: 写 `discCase.ts`**
- [ ] **Step 2: 写 `LuckyDiscCard/index.vue`**（先用 Task 0 的配方，参数照抄 spike）
- [ ] **Step 3: 临时挂到 Lucky 页里看他目视**

`Lucky/index.vue` 里先写死 5 个假 `DrawCard`（用真实池子更好：直接 `loadPool(true)`），排成一行。**这一步就是为了 30 秒目视**：卡片像不像实体印品、浅色下箔会不会脏。

- [ ] **Step 4: 真机目视（浅色 + 深色各一遍）**

Run: `npm run dev` → 进「手气不错」，鼠标在卡上移动，确认：倾斜跟手、反光跟手、封面清晰不被色相污染、深浅两套都不"塑料"。

- [ ] **Step 5: typecheck + Commit**

```bash
git add src/components/LuckyDiscCard src/views/Lucky/discCase.ts
git commit -m "feat(lucky): disc inner-sleeve card with glaze, glare and tilt"
```

---

## Task 5: 未拆封 CD 盒 + 拆封动画

**Files:**
- Create: `src/components/LuckyDiscCase/index.vue`

**Interfaces:**
- Consumes: `discCase.ts` 的 `fanOf`、`confetti.ts`（Task 6，先留空实现：`burst(canvas, opts)` 直接 no-op）
- Produces: `<LuckyDiscCase :state="'sealed' | 'opening' | 'open'" @begin="…" @opened="…" />`

**结构（`perspective:1400px` 在舞台，盒子 `preserve-3d`）：**
1. `.stage`：`perspective:1400px; perspective-origin: 50% 40%`
2. `.case`：方形，`transform-style: preserve-3d`，初始轻微倾斜（`rotateX(6deg) rotateY(-8deg)`），鼠标跟随 ±6°
3. `.film`（收缩膜）：一层半透明白 + 右上角拉条（三角）+ 两条折痕；拆封时沿 12 段折线裂开、向两侧飘散淡出
4. `.front`（封面纸，`translateZ(8px)`）：匿名封面（同心圆 = 光盘轮廓 + 中心孔 + 一圈极淡的 `--ff-foil-*`），底部窄信息条 `随机一包 · 5 discs`
5. `.spine`（左侧 6px，`rotateY(-90deg)`）：书脊，写 `5 DISCS`
6. `.lid`（盒盖铰链，`transform-origin: right center`）：拆封时 `rotateY(-105deg)`，用 `linear()` 弹簧

**时间轴（`opening` 状态）：**
- 0ms 膜裂开（12 片，随机角度 ±6°，`380ms` 淡出）
- 180ms 盒盖翻开（`520ms`，过冲一次回弹）
- 320ms 起，5 张内页依次飞出（间隔 60ms，从盒心到 `fanOf(i,5)` 的落点，弹簧 `620ms`）
- 900ms 触发 `opened`

**硬要求：**
- `prefers-reduced-motion: reduce` ⇒ 跳过全部，直接 `opened`
- 每一层显式 `pointer-events: none`，只有「盒体 + 拉条」是 `auto`（Review Focus 第 2 条）
- 拆封动作两种入口：点击拉条（立即整段跑）/ 向下拖动拉条（跟手，超过 40% 阈值即自动完成后半段）

- [ ] **Step 1: 写组件（含两种拆封入口）**
- [ ] **Step 2: 接进 Lucky 页，真机目视**

确认：点一下能拆、拖也能拆、拆完 5 张落位；盒盖翻开时没有卡片穿模；减少动态效果下直接到位。

- [ ] **Step 3: typecheck + Commit**

```bash
git add src/components/LuckyDiscCase
git commit -m "feat(lucky): sealed jewel case with tear-open and lid animation"
```

---

## Task 6: 彩带 + 音效

**Files:**
- Create: `src/components/LuckyDiscCase/confetti.ts`
- Modify: `src/utils/sfx/recipes.ts`、`src/utils/sfx/index.ts`

**Interfaces:**
- Produces:

```ts
export interface ConfettiOptions { count?: number; spreadDeg?: number; power?: number }
export function burst(canvas: HTMLCanvasElement, opts?: ConfettiOptions): () => void;
// 返回 stop()：取消 RAF、清空画布。调用方必须在离页/重抽时调它。
```

- `sfx`：`SfxEvent` 加 `'lucky-tear'`、`'lucky-burst'` 两项，`EVENT_RECIPE` 各配一个配方（在 `recipes.ts` 里按已有 `SfxRecipe` 结构写：`lucky-tear` = 高通噪声爆发 + 120ms 指数衰减；`lucky-burst` = 低频撞击（~80Hz）+ 上行泛音 + 短混响）。

**硬要求：**
- 单 canvas 承载全部粒子（不同帧 100+ 个 DOM）
- DPR 感知：`canvas.width = cssW * dpr`
- `count` 默认 110；`prefers-reduced-motion` 时 `burst` 直接 no-op 返回空函数
- 音效只在拆封开始与爆开两个时刻各响一次，不逐卡响

- [ ] **Step 1: 写 `confetti.ts`**
- [ ] **Step 2: 加音效配方**
- [ ] **Step 3: 接进盒子组件，真机目视 + 听**

确认：彩带有重力与自旋、不糊成一条线；声音与画面同拍（膜裂 = 撕裂声，卡片飞出 = 爆开声）；关掉音效设置后无声。

- [ ] **Step 4: typecheck + Commit**

```bash
git add src/components/LuckyDiscCase/confetti.ts src/utils/sfx
git commit -m "feat(lucky): confetti burst and tear/burst sfx"
```

---

## Task 7: 页面编排（状态机、勾选框、键盘、空态、离页释放）

**Files:**
- Modify: `src/views/Lucky/index.vue`（主体）

**Interfaces:**
- Consumes: `loadPool`/`drawPack`（Task 2）、`openCover`（Task 3）、`LuckyDiscCard`、`LuckyDiscCase`、`NCheckbox`、`useNotify`

**页面要素：**
- 右上角：`NCheckbox` 「包含离线盘缓存」**默认勾选**；切换 ⇒ 重抽（不是过滤现有 5 张）
- 舞台中央：`LuckyDiscCase`（`sealed`）或 5 张 `LuckyDiscCard`（`open`）
- 底部：`再来一包`（仅 `open` 状态出现，`@starting-style` 淡入）
- 键盘：`空格` 拆封 / 再来一包，`←/→` 移动焦点，`Enter` 打开，`Esc` 回文件页
- 右上角小字：`池中 N 部`（`loadPool` 返回的 `total`）

**状态机：** `idle → loading → sealed → opening → open`；`再来一包` 回到 `sealed`

**硬要求（Review Focus 第 1 条）：**
- `onDeactivated` 起 2 分钟计时，到点：`confetti.stop()`、清空 `cards`、回到 `loading`（照抄 `Tunnel/index.vue:65-90` 的 dispose 注释与写法）
- `onActivated` 时若已释放则重载
- 任何一次重抽前必须先 `stop()` 上一轮的彩带（否则两条 RAF 同时跑）

- [ ] **Step 1: 写状态机与加载**
- [ ] **Step 2: 空态与边界**：`total === 0` ⇒ 空态卡（文案照 DESIGN §四），按钮「前往文件浏览」跳 `/`
- [ ] **Step 3: 接打开**：`open(card)` ⇒ `openCover(card.src)` ⇒ `ok` 时 `notify('success','已交给播放器')`；`offline` 时 `notify('warning','磁盘未在线', ...)`；`error` 时 `notify('error', ...)`
- [ ] **Step 4: 真机回归**

逐条走：拆一包 → 开一张 → 再来一包 → 取消勾选 → 再勾上 → 切到文件页待 2 分钟后回来 → 键盘全套。**每条都亲眼看**。

- [ ] **Step 5: typecheck + Commit**

```bash
git add src/views/Lucky/index.vue
git commit -m "feat(lucky): page orchestration with offline toggle, keyboard and idle release"
```

---

## Task 8: 收尾验收

**Files:**
- Modify: `docs/DESIGN-LUCKY-DRAW-2026-11-15.md`（补「实现记录」小节）

- [ ] **Step 1: 全量检查**

```bash
npm run typecheck
node docs/probes/lucky-draw/probe.cjs
node docs/probes/tokens/no-raw-color.mjs
```
Expected: 三样全过

- [ ] **Step 2: 体量检查**

Run: `wc -l src/views/Lucky/*.ts src/views/Lucky/index.vue src/components/LuckyDiscCase/* src/components/LuckyDiscCard/* src/views/FileFinder/openCover.ts`
Expected: 单文件 ≤ 250 行；超了就说明职责没拆干净，拆完再回来

- [ ] **Step 3: 真机全量目视（浅色 + 深色各一遍）**

清单：入口高亮 · 拆封动画完整 · 5 张落位不穿模 · 悬停倾斜与反光 · 双击拉起播放器 · 离线卡标记与提示 · 空态 · 再来一包 · 键盘 · 离页 2 分钟后回来 · 内存里没有残留 RAF（DevTools Performance 看一次）

- [ ] **Step 4: 写实现记录 + Commit**

```bash
git add docs/DESIGN-LUCKY-DRAW-2026-11-15.md
git commit -m "docs(lucky): record implementation decisions and acceptance"
```

---

## 标定结果（Task 0 完成后回填）

- 配方：待定
- 他的原话：待定
- 日期：待定
