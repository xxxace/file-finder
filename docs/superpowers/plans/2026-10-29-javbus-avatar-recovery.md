# JavBus 官方女优大头照数据源升级实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将女优头像回收功能的数据源升级为 JavBus 官方正规摄影棚大头照，支持简繁日汉字自动归一化搜索、本地持久化缓存（0ms 重复命中）、防盗链自动穿透，以及前端界面在 JavBus 与 Gfriends 之间无缝切换。

**Architecture:** 新建 `electron/server/assistant/javbus.ts` 演员检索与解析模块，结合 `siteFetch` / `net.request` 与持久化本地 JSON 缓存；在 `apply.ts` 的 `download` 通道中注入 JavBus Referer 避免 403；在 `avatarScan.ts` 与路由中支持 `source: 'javbus' | 'gfriends'`；在 `AssistantAvatarModal.vue` 中提供数据源切换与来源标识。

**Tech Stack:** TypeScript, Node.js, Electron `net.request` / `session`, Naive UI, Vue 3, NeDB.

**Spec:** `docs/superpowers/specs/2026-10-29-javbus-avatar-recovery-design.md`

## Global Constraints

- **严禁向离线盘写文件**：仅对当前在线（已挂载）磁盘执行头像落盘与缓存失效，离线盘必须抛出错误并阻止操作。
- **只针对当前浏览目录的直属子目录**：不进行深度递归，保留精准单层范围控制。
- **保留番号目录自动剔除逻辑**：严禁把影片番号目录误认为女优目录。
- **零破坏性升级**：原有 Gfriends 匹配逻辑完好保留，作为备选兜底数据源。
- **类型安全**：每次改动必须保持 `npm run typecheck` 0 错误。

## Review Focus

1. **JavBus 搜索结果多演员选取**：当搜索返回多位相似名称女优时，优先完全匹配演员名，次选包含匹配，避免张冠李戴。
2. **简化字与日文汉字差异**：如目录名为「三上悠亚」，需通过 `KANJI_MAP` 自动按「三上悠亜」在 JavBus 检索。
3. **图片防盗链 403**：JavBus CDN 图片如果缺少 `Referer: https://www.javbus.com/` 会报 403，必须在所有下载与预览通道中统一带上。
4. **并发控制与本地缓存**：目录中若有数十个女优，批量向 JavBus 请求需限制并发池（5 并发），且已查到的演员信息必须落地本地缓存，避免频繁出网。
5. **网络不可达容灾**：当用户在无代理网络环境下访问 JavBus 失败时，需友好降级提示或自动回退至 Gfriends，保证功能不彻底不可用。

---

### Task 1: 实现 JavBus 演员搜索与 HTML 解析引擎及本地缓存

**Files:**
- Create: `electron/server/assistant/javbus.ts`
- Create: `docs/probes/avatar/javbus-test.mjs`

- [ ] **Step 1: 编写 JavBus 解析与缓存的单元测试探针**
  在 `docs/probes/avatar/javbus-test.mjs` 中编写测试：
  - 测试 `parseJavBusSearchHtml(html, cleanName)`：能正确从 JavBus HTML 中的 `.avatar-box` 提取头像 URL、演员名与 starId；
  - 测试汉字归一化搜索词转换；
  - 测试本地缓存持久化（`readJavBusCache` / `writeJavBusCache`）。

- [ ] **Step 2: 运行测试确保测试能够执行并暴露待实现方法**
  运行 `node docs/probes/avatar/javbus-test.mjs`。

- [ ] **Step 3: 实现 `electron/server/assistant/javbus.ts`**
  - 定义 `JavBusActressResult` 接口；
  - 实现 `parseJavBusSearchHtml(html, targetName)` 解析函数；
  - 实现 `searchJavBusActress(name, dataDir, timeoutMs)`，包含本地缓存、网络请求与候选 URL 回退；
  - 导出缓存读写方法。

- [ ] **Step 4: 运行探针测试确认全部通过**
  运行 `node docs/probes/avatar/javbus-test.mjs`，确保测试全绿。

- [ ] **Step 5: 提交 Task 1 代码**
  `git add electron/server/assistant/javbus.ts docs/probes/avatar/javbus-test.mjs && git commit -m "feat(assistant): add javbus actress search engine with html parsing and local cache"`

---

### Task 2: 注入防盗链 Referer 支持

**Files:**
- Modify: `electron/server/assistant/apply.ts:395-430`

- [ ] **Step 1: 在 `download` 中添加防盗链请求头判断**
  在 `download(url: string, signal: AbortSignal)` 中，检测如果 `url` 包含 `javbus`、`buscdn` 或 `/pics/`，自动设置 `req.setHeader('Referer', 'https://www.javbus.com/')`。

- [ ] **Step 2: 验证现存 apply 探针无回归**
  运行 `node docs/probes/avatar/apply-test.mjs` 确认既有探针全部通过。

- [ ] **Step 3: 提交 Task 2 代码**
  `git add electron/server/assistant/apply.ts && git commit -m "fix(assistant): add referer header in download for javbus anti-hotlinking"`

---

### Task 3: 服务端扫描与匹配端点支持数据源切换

**Files:**
- Modify: `electron/server/assistant/avatarScan.ts`
- Modify: `electron/server/assistant/index.ts`
- Modify: `docs/probes/avatar/scan-test.mjs`

- [ ] **Step 1: 扩展 `avatarScan.ts` 支持多源分发**
  - 在 `scanActressFolders` 中增加入参 `source?: 'javbus' | 'gfriends'`；
  - 若 `source === 'javbus'`，使用受控并发池（5 并发）逐项调用 `searchJavBusActress`，若 JavBus 未命中可自动尝试 Gfriends 兜底；
  - 若 `source === 'gfriends'`，保持纯离线 Gfriends 匹配。

- [ ] **Step 2: 更新路由适配 `source` 参数**
  - `/assistant/avatar/scan` 接收 `req.body.source` 并传入 `scanActressFolders`；
  - `/assistant/avatar/match` 接收 `req.body.source`，若为 `javbus` 优先调用 `searchJavBusActress`。

- [ ] **Step 3: 运行并更新 `scan-test.mjs` 验证**
  运行 `node docs/probes/avatar/scan-test.mjs`，确保单元测试通过。

- [ ] **Step 4: 提交 Task 3 代码**
  `git add electron/server/assistant/avatarScan.ts electron/server/assistant/index.ts docs/probes/avatar/scan-test.mjs && git commit -m "feat(assistant): integrate javbus actress source into scan and match endpoints"`

---

### Task 4: 前端界面增设数据源切换与来源展示

**Files:**
- Modify: `src/views/FileFinder/AssistantAvatarModal.vue`

- [ ] **Step 1: 增加数据源选择器**
  在顶部操作栏增加 `n-select` 或 `n-radio-group` 数据源切换：
  - `JavBus 官方高清 (推荐)`（值 `'javbus'`，默认选中）
  - `Gfriends 社区库`（值 `'gfriends'`）

- [ ] **Step 2: 调整扫描与单项匹配请求**
  在 `runScan` 和 `recheckName` 中传递当前选中的 `source: activeSource.value`。

- [ ] **Step 3: 表格展示数据源标签**
  在「状态」列中，若匹配成功，展示来源标签（如 `JavBus 官方` 或 `Gfriends`）。

- [ ] **Step 4: 执行静态类型检查**
  运行 `npm run typecheck`，确保 0 错误。

- [ ] **Step 5: 提交 Task 4 代码**
  `git add src/views/FileFinder/AssistantAvatarModal.vue && git commit -m "feat(ui): add datasource selector and javbus actress matching to avatar modal"`

---

### Task 5: 整体集成验证与交付

- [ ] **Step 1: 运行所有探针**
  依次执行：
  - `node docs/probes/avatar/gfriends-test.mjs`
  - `node docs/probes/avatar/javbus-test.mjs`
  - `node docs/probes/avatar/scan-test.mjs`
  - `node docs/probes/avatar/apply-test.mjs`

- [ ] **Step 2: 运行全局构建与类型检查**
  执行 `npm run typecheck`，确认全部通过。

- [ ] **Step 3: 最终汇总与回复用户**
