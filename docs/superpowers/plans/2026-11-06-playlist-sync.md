# 收藏夹（清单）信息同步与状态对齐实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 解决收藏夹影片信息脱节问题，实现零读盘前提下基于本地 NeDB 缓存与助手写盘联动的元数据对齐、路径自愈及已失效（missing）状态提示。

**Architecture:** 
1. 存储层（`playlistStore.ts`）提供精准定位 patch 与批量快照对齐方法；
2. 读端路由（`playlist.ts`）在 `GET /playlists` 和 `GET /playlistItems` 装配条目时，根据 `(serial, relPath)` 向上查父级 NeDB 内存缓存，动态对齐最新 `sig`、`files` 与代言卡类型，并异步回写；确认条目丢失且盘在线时标记 `missing: true`；
3. 助手写盘（`apply.ts`）在单视频整理入文件夹或换封面后，主动调用存储层更新对应条目；
4. 前端卡片（`index.vue` / `openDecision.ts`）渲染 `[已失效]` 徽标并在双击/回车时拦截提示。

**Tech Stack:** Node.js, TypeScript, Electron, Vue 3, Naive UI, NeDB.

**Spec:** `docs/superpowers/specs/2026-11-06-playlist-sync-design.md`

## Global Constraints

- **零读盘铁律**：打开收藏夹货架与详情屏严禁进行任何外置硬盘读写，仅允许读系统 C 盘的 `playlists.json` 与 NeDB 内存缓存。
- **离线友好**：外置硬盘未连接（`drive === ''`）时保留最后已知快照，绝对不标记为 `missing`。
- **代言卡契约**：单视频整理为文件夹后，升级为影片封面代言卡（`type: 'image'` + `files: [...]`），保证 100% 满幅海报展示且双击直接播放视频，不得转为 `type: 'folder'`。
- **向后兼容**：不破坏已有的 `playlists.json` 结构，未缓存的冷目录回落保留原有快照。

## Review Focus

1. 盘离线（`drive === ''`）且该条目在缓存中不存在时：必须保持原有快照并展示离线，绝不能标为 `missing: true`。
2. 单文件视频被助手整理打包成同名文件夹后：收藏条目的 `relPath` 变为 `layerDir/query`，`type` 保持 `'image'`，`files` 补全分卷，主网格星标不脱落。
3. 封面文件更换后：`item.sig` 必须更新为新图片的指纹，货架拼格与详情屏即刻渲染新图。
4. 硬盘在线但父目录已被扫描且确认文件已被删除：卡片显示右上角 `[已失效]` 徽标，双击和回车均弹窗提示且不报错。
5. 多次连续进入收藏夹触发对齐时：串行写队列保障 `playlists.json` 原子落盘，无文件损坏与并发竞争。

---

### Task 1: 存储层扩展（精准修改与快照回写）

**Files:**
- Modify: `electron/server/playlistStore.ts`
- Create: `docs/probes/playlist-sync/probe-store.cjs`

**Interfaces:**
- Produces: 
  - `patchItemByLocation(dataDir: string, serial: string, relPath: string, name: string, patch: Partial<PlaylistItem>): Promise<boolean>`
  - `reconcileItemSnapshots(dataDir: string, reconciler: (item: PlaylistItem) => { changed: boolean; item: PlaylistItem }): Promise<number>`

- [ ] **Step 1: 编写探针测试 `docs/probes/playlist-sync/probe-store.cjs`**
  测试 `patchItemByLocation` 能精准按 `(serial, relPath, name)` 命中并修改条目，非目标条目不受影响；测试 `reconcileItemSnapshots` 能够批量处理并正确统计更新数。

- [ ] **Step 2: 运行探针验证失败**
  `node docs/probes/playlist-sync/probe-store.cjs`
  预期：FAIL（方法未定义）

- [ ] **Step 3: 在 `electron/server/playlistStore.ts` 中实现两项新方法**
  - `patchItemByLocation`：遍历所有清单，找到 `serial === s && relPath === r && name === n` 的条目并合并 `patch`，有变动则触发 `persist` 并返回 true。
  - `reconcileItemSnapshots`：遍历所有条目传入 `reconciler`，若有变动合并回清单并触发 `persist`，返回变更条目总数。

- [ ] **Step 4: 运行探针验证通过**
  `node docs/probes/playlist-sync/probe-store.cjs`
  预期：PASS

- [ ] **Step 5: 提交代码**
  `git add electron/server/playlistStore.ts docs/probes/playlist-sync/probe-store.cjs`
  `git commit -m "feat(playlist): add patchItemByLocation and reconcileItemSnapshots"`

---

### Task 2: 读端 NeDB 投影与自愈（零读盘对齐）

**Files:**
- Modify: `electron/server/playlist.ts`
- Create: `docs/probes/playlist-sync/probe-reconcile.cjs`

**Interfaces:**
- Consumes:
  - `findCache` from `./nedb`
  - `reconcileItemSnapshots` from `./playlistStore`
- Produces:
  - 纯函数 `reconcileItemWithCache(item: PlaylistItem, cache: SearchCache | null, drive: string): { item: PlaylistItem; changed: boolean; missing: boolean }`
  - `wireItem` 支持 `missing?: boolean` 下发
  - `listItems` 和 `listPlaylists` 在装配前执行内存对齐

- [ ] **Step 1: 编写探针测试 `docs/probes/playlist-sync/probe-reconcile.cjs`**
  - Case 1: NeDB 存在新 `sig` -> 提取新 `sig`，`changed: true`，`missing: false`。
  - Case 2: 单视频在 NeDB 中收敛为同名文件夹封面卡 -> 升级为 `type: 'image'`、更新 `relPath` 并补齐 `files`。
  - Case 3: 盘在线（`drive !== ''`），父目录已缓存，但条目在 `cache.data` 中找不到 -> `missing: true`。
  - Case 4: 盘离线（`drive === ''`），父目录未缓存或已缓存但找不到 -> `missing: false`（安全降级）。

- [ ] **Step 2: 运行探针验证失败**
  `node docs/probes/playlist-sync/probe-reconcile.cjs`
  预期：FAIL

- [ ] **Step 3: 在 `electron/server/playlist.ts` 中实现纯对齐函数与路由集成**
  - 实现纯函数 `reconcileItemWithCache` 覆盖上述 4 类场景。
  - 更新 `wireItem(item, drive, missing)`：当 `missing` 为真时注入 `missing: true`。
  - 在 `listItems` 中：遍历条目查询父目录缓存 `findCache({ serial: it.serial, relPath: dirOf(it.relPath), mode: 'cover' })`，调用对齐函数；如有改动，异步调用 `persist` 回写系统盘；下发带 `missing` 的装配条目。
  - 在 `listPlaylists` 中：对每个条目按对齐后的 `sig` 提取 `covers`，按对齐后的 `dir/name` 提取 `keys`。

- [ ] **Step 4: 运行探针验证通过**
  `node docs/probes/playlist-sync/probe-reconcile.cjs`
  预期：PASS

- [ ] **Step 5: 提交代码**
  `git add electron/server/playlist.ts docs/probes/playlist-sync/probe-reconcile.cjs`
  `git commit -m "feat(playlist): add zero-io NeDB projection and missing status reconciliation"`

---

### Task 3: 助手写盘主动联动（入库即刻同步）

**Files:**
- Modify: `electron/server/assistant/apply.ts`
- Create: `docs/probes/playlist-sync/probe-apply-hook.cjs`

**Interfaces:**
- Consumes:
  - `patchItemByLocation` from `../playlistStore`

- [ ] **Step 1: 编写探针测试 `docs/probes/playlist-sync/probe-apply-hook.cjs`**
  模拟 `applyGroups` 执行后的回调过程，验证当裸视频打包为同名文件夹或换封面时，`playlists.json` 中的同名条目是否被精准同步。

- [ ] **Step 2: 运行探针验证失败**
  `node docs/probes/playlist-sync/probe-apply-hook.cjs`
  预期：FAIL

- [ ] **Step 3: 在 `electron/server/assistant/apply.ts` 中挂接同步逻辑**
  - 在 `applyGroups` 循环完成且 `bumpProgress` 之后：
    - 若 `g.kind === 'file'`（单文件打包进同名文件夹）：调用 `patchItemByLocation(config.userBasePath, driveSerial, g.layerDir, g.query, { relPath: joinRel(g.layerDir, g.query), type: 'image', sig: newSig, files: newFiles })`。
    - 若 `g.kind === 'dir' || g.overwrite`（补封面或换封面）：调用 `patchItemByLocation` 同步新 `sig`。

- [ ] **Step 4: 运行探针验证通过**
  `node docs/probes/playlist-sync/probe-apply-hook.cjs`
  预期：PASS

- [ ] **Step 5: 提交代码**
  `git add electron/server/assistant/apply.ts docs/probes/playlist-sync/probe-apply-hook.cjs`
  `git commit -m "feat(assistant): hook apply completion into playlist store"`

---

### Task 4: 前端交互与已失效（missing）展示

**Files:**
- Modify: `src/views/FileFinder/index.vue`
- Modify: `src/views/FileFinder/openDecision.ts`

**Interfaces:**
- Consumes:
  - `WiredFileInfo.missing?: boolean`

- [ ] **Step 1: 在 `src/views/FileFinder/openDecision.ts` 中增加失效拦截**
  - `decideOpen(card)`：若 `card.missing` 为真，返回 `{ kind: 'missing', title: card.name }`。
  - 既有 `handleOpen` 收到 `'missing'` 时直接弹 toast 提示「该文件已不在原路径或已被删除」，不触发任何磁盘调用。

- [ ] **Step 2: 在 `src/views/FileFinder/index.vue` 中渲染已失效徽标**
  - 卡片 template：在右上角渲染 `<span v-if="item.missing" class="missing-badge">已失效</span>`。
  - 增加样式：深红暗底 + 浅红字，小圆角，绝对定位，不破坏网格几何布局。
  - 确保键盘光标回车（`onCursorConfirm`）与双击共用 `openDecision`，同样受到失效拦截。

- [ ] **Step 3: 验证构建与静态类型**
  运行 `npm run typecheck` 确认 0 error。

- [ ] **Step 4: 提交代码**
  `git add src/views/FileFinder/index.vue src/views/FileFinder/openDecision.ts`
  `git commit -m "feat(ui): display missing badge and intercept open on missing items"`

---

### Task 5: 探针全量回归与真机验收

**Files:**
- Modify: `docs/probes/`

- [ ] **Step 1: 运行所有相关探针**
  - `node docs/probes/playlist-sync/probe-store.cjs`
  - `node docs/probes/playlist-sync/probe-reconcile.cjs`
  - `node docs/probes/playlist-sync/probe-apply-hook.cjs`
  - 既有探针检查：`npm run typecheck`

- [ ] **Step 2: 完整提交与文档归档**
  `git status` 确认工作区干净。
