# 女优目录头像回收（基于 Gfriends）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 file-finder 新增独立的「女优头像回收」功能：零读盘定位当前浏览目录下的直属无头像女优子文件夹，自动通过 Gfriends 开源头像库与多 CDN 镜像进行秒级名称匹配，在独立弹窗中提供可视化预览与手动修正，并在确认后对在线盘安全写入 `avatar.jpg` 并使缓存即时生效长脸。

**Architecture:** 
- 后端在 `electron/server/assistant/` 下扩展三个轻量独立模块：`gfriends.ts`（Gfriends 索引拉取/缓存与简繁别名归一）、`avatarScan.ts`（直属子目录筛选与番号目录自动剔除）、`avatarApply.ts`（在线盘强校验、受控下载、备份、原子写盘与缓存失效）。
- 前端实现全新的独立弹窗组件 `src/views/FileFinder/AssistantAvatarModal.vue`，在 `FileFinder/index.vue` 顶部操作菜单中无缝挂载，杜绝修改已有 `AssistantCoverModal.vue` 带来的回归风险。

**Tech Stack:** Electron 44, Vue 3, TypeScript 5.9, Naive UI 2.45, Node 22 (fetch, fs/promises, crypto).

**Spec:** `docs/superpowers/specs/2026-10-29-actress-avatar-recovery-design.md`

## Global Constraints

- **在线盘闸门（用户强约束）**：仅允许对当前在线挂载盘写入头像并失效缓存；离线盘禁止任何写盘与缓存失效。
- **少读盘铁律**：扫描与匹配阶段磁盘 I/O 必须为 0（全部由内存缓存 `searchCache.db` 完成）。
- **契约对齐**：写入目标固定为 `<女优目录>/avatar.jpg`，严格匹配 `dirCover.ts` 中 `DIR_COVER_FILES`。
- **架构解耦**：不侵入改动 `AssistantCoverModal.vue`，保持封面助手完全独立。
- **验证标准**：`npm run typecheck`（`vue-tsc` + `tsc`）0 error + Node 只读探针全部通过。

## Review Focus

1. **影片番号目录误报**：目录名是 `SSNI-001` 等片子时，被当作女优送去匹配导致大面积未找到。`avatarScan` 必须前置调用 `parseTitle(name).id` 过滤。
2. **离线盘写入安全**：在离线锚点（`#<serial>/...`）或已拔盘状态下触发写入。后端与前端均必须根据 `getDrives()` 强制拦截并提示。
3. **网络与 CDN 容灾**：jsDelivr 等单个 CDN 节点在国内超时或失败。`gfriends.ts` 必须支持多镜像列表按序回退（jsDelivr -> FastGit/Cloudflare -> GitHub Raw）。
4. **女优名称中的噪声符号**：目录名常含 `[S1] 三上悠亚 (2020)` 或包含多空格。清洗引擎必须去除方括号、圆括号及纯数字后进行匹配。
5. **写盘原子性与旧图备份**：写入 `avatar.jpg` 若已存在旧图，先备份至 `~/.file-finder/backups/`，写入走目标目录内 `tmp -> rename`。

---

### Task 1: Gfriends 索引管理与名称清洗匹配引擎

**Files:**
- Create: `electron/server/assistant/gfriends.ts`
- Test: `docs/probes/avatar/gfriends-test.mjs`

**Interfaces:**
- Produces:
  ```ts
  export interface GfriendsIndex {
      version: string;
      updatedAt: number;
      actors: Record<string, string>; // normalizedName -> relativePath (e.g. "Content/A/三上悠亜.jpg")
  }
  export function cleanActressName(raw: string): string;
  export function normalizeChineseKana(name: string): string;
  export function matchGfriends(name: string, index: GfriendsIndex): { matchedName: string; avatarPath: string } | null;
  export function getAvatarUrl(avatarPath: string, mirrorIndex?: number): string;
  export async function ensureGfriendsIndex(dataDir: string, forceUpdate?: boolean): Promise<GfriendsIndex>;
  ```

- [ ] **Step 1: 编写 Gfriends 引擎测试脚本**

创建 `docs/probes/avatar/gfriends-test.mjs`，测试：
1. `cleanActressName('[S1] 三上悠亚 (2020)') === '三上悠亚'`；
2. `cleanActressName('SSNI-001') === ''`（纯番号应被剔除）；
3. 繁简与别名比对：输入 `三上悠亚` 命中 `三上悠亜`；
4. 多 CDN 镜像 URL 生成。

- [ ] **Step 2: 运行测试验证失败**

运行：`node docs/probes/avatar/gfriends-test.mjs`  
预期：FAIL（模块尚未创建）

- [ ] **Step 3: 实现 `electron/server/assistant/gfriends.ts`**

实现：
- 静态简繁替换表与别名字典；
- 目录名正则清洗（去掉前后中括号 `[...]`、圆括号 `(...)`、常见前缀）；
- Gfriends `Filetree.json` 的下载、本地缓存（`~/.file-finder/gfriends/filetree.json`）与读取；
- 多 CDN 镜像源配置（`https://fastly.jsdelivr.net/gh/gfriends/gfriends@master/`、`https://cdn.jsdelivr.net/gh/gfriends/gfriends@master/`、`https://raw.githubusercontent.com/gfriends/gfriends/master/`）。

- [ ] **Step 4: 运行测试验证通过**

运行：`node docs/probes/avatar/gfriends-test.mjs`  
预期：PASS，所有清洗和匹配用例输出 0 error。

- [ ] **Step 5: 提交代码**

```bash
git add electron/server/assistant/gfriends.ts docs/probes/avatar/gfriends-test.mjs
git commit -m "feat(assistant): add gfriends index and name matching engine"
```

---

### Task 2: 直属子目录零读盘扫描器与番号过滤

**Files:**
- Create: `electron/server/assistant/avatarScan.ts`
- Test: `docs/probes/avatar/scan-test.mjs`

**Interfaces:**
- Consumes:
  - `loadMeta` from `electron/server/nedb.ts`
  - `parseTitle` from `electron/server/assistant/match.ts`
  - `cleanActressName`, `matchGfriends`, `getAvatarUrl`, `ensureGfriendsIndex` from `./gfriends`
- Produces:
  ```ts
  export interface AvatarCandidate {
      relDir: string;
      folderName: string;
      cleanName: string;
      matchedName: string | null;
      avatarUrl: string | null;
      status: 'matched' | 'unmatched';
  }
  export async function scanActressFolders(
      serial: string,
      relPath: string,
      dataDir: string
  ): Promise<AvatarCandidate[]>;
  ```

- [ ] **Step 1: 编写直属目录扫描探针测试**

创建 `docs/probes/avatar/scan-test.mjs`，模拟缓存条目：
1. 包含直属子文件夹 `三上悠亚`（无 avatar）-> 应被扫描命中并清洗为 `三上悠亚`；
2. 包含直属子文件夹 `SSNI-001`（无 avatar）-> `parseTitle` 判定为番号，被自动排除；
3. 包含深层非直属文件夹 `三上悠亚/SSNI-001` -> 校验其只扫描 `relPath` 下第一级直属目录；
4. 包含已有头像的文件夹 `带头像女优`（`avatar` 有值）-> 自动排除。

- [ ] **Step 2: 运行测试验证失败**

运行：`node docs/probes/avatar/scan-test.mjs`  
预期：FAIL（`scanActressFolders` 未定义）

- [ ] **Step 3: 实现 `electron/server/assistant/avatarScan.ts`**

实现：
- 从 `loadMeta(serial, 'cover')` 检索文档；
- 精准定位目标层文档（`relPath` 对应文档）；
- 遍历其条目：过滤出 `type === 'folder' && !item.avatar`；
- 使用 `parseTitle(item.name).id` 排除番号目录；
- 调用 `cleanActressName` 提取清洁女优名，并经 `matchGfriends` 预计算匹配结果与 CDN 头像 URL。

- [ ] **Step 4: 运行测试验证通过**

运行：`node docs/probes/avatar/scan-test.mjs`  
预期：PASS。

- [ ] **Step 5: 提交代码**

```bash
git add electron/server/assistant/avatarScan.ts docs/probes/avatar/scan-test.mjs
git commit -m "feat(assistant): implement direct subfolder avatar scanner with code filtering"
```

---

### Task 3: 在线盘安全写盘、备份与缓存失效及后端路由挂载

**Files:**
- Create: `electron/server/assistant/avatarApply.ts`
- Modify: `electron/server/assistant/index.ts`
- Test: `docs/probes/avatar/apply-test.mjs`

**Interfaces:**
- Consumes:
  - `getDrives` from `electron/utils/driveIdentity.ts`
  - `removeCache` from `electron/server/nedb.ts`
- Produces:
  ```ts
  export interface AvatarApplyItem {
      relDir: string;
      avatarUrl: string;
  }
  export interface AvatarApplyResult {
      total: number;
      succeeded: number;
      failed: number;
      logs: { relDir: string; status: 'ok' | 'error'; message?: string }[];
  }
  export async function applyActressAvatars(
      serial: string,
      items: AvatarApplyItem[],
      dataDir: string
  ): Promise<AvatarApplyResult>;
  ```

- [ ] **Step 1: 编写在线校验与写入测试**

创建 `docs/probes/avatar/apply-test.mjs`，验证：
1. 当 `serial` 对应的盘不在线时，`applyActressAvatars` 立即抛出或返回离线拒绝错误，不创建任何文件；
2. 在线时：下载测试图片，通过临时文件转为 JPEG，写入目标 `${targetDir}/avatar.jpg`；
3. 验证存在旧图时先将其拷贝备份至 `~/.file-finder/backups/`。

- [ ] **Step 2: 运行测试验证失败**

运行：`node docs/probes/avatar/apply-test.mjs`  
预期：FAIL。

- [ ] **Step 3: 实现 `avatarApply.ts` 并在 `assistant/index.ts` 注册路由**

1. 在 `avatarApply.ts` 中实现：
   - 在线盘强校验：`const drives = await getDrives(); const drive = drives.find(d => d.serial === serial && d.mounted);` 若未挂载抛错；
   - 并发限制下载（使用 `p-limit` 思想或 3 并发 chunk）；
   - 使用 Electron `nativeImage.createFromBuffer` 转成 JPEG buffer（Node 环境若无 nativeImage 可兜底原样写入或借助 ffmpeg）；
   - 安全落盘：写入 `<targetDir>/.tmp-avatar.jpg` 再 `rename` 至 `<targetDir>/avatar.jpg`；
   - 触发缓存失效：`removeCache(serial, relDir, 'cover')`。
2. 在 `electron/server/assistant/index.ts` 的 `createAssistantRoutes` 中注册：
   - `GET /assistant/avatar/index-status`
   - `POST /assistant/avatar/scan`
   - `POST /assistant/avatar/apply`

- [ ] **Step 4: 运行测试并验证通过**

运行：`node docs/probes/avatar/apply-test.mjs`  
预期：PASS。

- [ ] **Step 5: 提交代码**

```bash
git add electron/server/assistant/avatarApply.ts electron/server/assistant/index.ts docs/probes/avatar/apply-test.mjs
git commit -m "feat(assistant): add avatar apply with online drive gate and register routes"
```

---

### Task 4: 前端独立弹窗组件 `AssistantAvatarModal.vue`

**Files:**
- Create: `src/views/FileFinder/AssistantAvatarModal.vue`

**Interfaces:**
- Consumes:
  - `request.ts` (GET / POST)
  - Naive UI 组件 (`NModal`, `NCard`, `NDataTable`, `NButton`, `NImage`, `NTag`, `NInput`, `NAlert`, `NProgress`, `NPopconfirm`)
- Props / Emits:
  ```ts
  defineProps<{
      show: boolean;
      serial: string;
      relPath: string;
      isOnline: boolean;
  }>();
  defineEmits<{
      (e: 'update:show', val: boolean): void;
      (e: 'applied'): void; // 写入成功后通知主视图刷新
  }>();
  ```

- [ ] **Step 1: 创建 `AssistantAvatarModal.vue` 组件基础骨架**

编写 template 与 script setup：
- 接收 `show`, `serial`, `relPath`, `isOnline`；
- 若 `!isOnline`，显示 `n-alert` 警示“当前为离线盘，不可进行写盘操作”，禁用开始扫描和写入按钮；
- 状态机包含：`idle`（未扫描）、`scanning`（正在扫描匹配）、`ready`（表格展示）、`applying`（写入中）、`done`（完成）。

- [ ] **Step 2: 实现表格列与行内操作**

表格字段：
- 多选列（默认已勾选状态为 `matched` 的项）；
- 女优头像（`n-image`，带缩略图与点击查看大图）；
- 原始目录名；
- 识别女优名（支持直接行内编辑，失焦或回车触发重新匹配）；
- 状态 Tag（已匹配、未找到、已手动修改）；
- 行内“手动指定图片 URL”Popover/输入框。

- [ ] **Step 3: 实现批量写入与进度呈现**

点击 `[写入选中的 N 张头像]`：
- 弹出 `n-popconfirm` 确认；
- 调用 `POST /assistant/avatar/apply`；
- 展示写入进度条与结果统计；
- 完成后发出 `emit('applied')` 事件并提示用户。

- [ ] **Step 4: 运行 typecheck 验证组件类型安全**

运行：`npm run typecheck`  
预期：PASS（0 error）。

- [ ] **Step 5: 提交代码**

```bash
git add src/views/FileFinder/AssistantAvatarModal.vue
git commit -m "feat(ui): add AssistantAvatarModal component"
```

---

### Task 5: 集成至 `FileFinder/index.vue` 操作菜单与全量回归验证

**Files:**
- Modify: `src/views/FileFinder/index.vue`
- Test: 全流程真机联调与只读探针

- [ ] **Step 1: 在 `FileFinder/index.vue` 下拉操作菜单中新增入口**

在工具栏操作菜单 options 中新增：
```ts
{ label: '女优头像回收', key: 'avatar-recovery', icon: ... }
```
在操作处理函数中：
- 绑定点击事件，将 `showAvatarModal` 置为 `true`；
- 挂载 `<AssistantAvatarModal v-model:show="showAvatarModal" :serial="currentSerial" :rel-path="currentRelPath" :is-online="currentDriveOnline" @applied="refreshCurrentFolder" />`。

- [ ] **Step 2: 运行类型检查**

运行：`npm run typecheck`  
预期：PASS（0 error）。

- [ ] **Step 3: 运行全量构建验证**

运行：`npm run build`  
预期：打包成功，无未捕获异常。

- [ ] **Step 4: 提交代码**

```bash
git add src/views/FileFinder/index.vue
git commit -m "feat(ui): integrate actress avatar recovery into FileFinder menu"
```
