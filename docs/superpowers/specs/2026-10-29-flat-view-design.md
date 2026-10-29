# 设计文档 · 根缓存目录 Flat 视图（平铺视图）

> 日期：2026-10-29  
> 状态：待用户审批（Approved Gate）  
> 关联：`src/views/FileFinder/index.vue` · `electron/server/index.ts` · `electron/server/nedb.ts`

---

## 1. 背景与目标（Intent & Goals）

### 1.1 背景
用户使用 file-finder 浏览移动硬盘中的收藏。常规层级下，根目录下包含大量女优文件夹或分类父文件夹（例如 `H:/JAV/三上悠亚/`、`H:/JAV/河北彩花/`），用户需逐个双击点进女优文件夹才能看到具体作品。
用户希望在**根缓存目录**提供一种「Flat 视图（平铺视图）」，跳过中间的女优文件夹/父文件夹，单纯将该根目录下所有子孙条目（作品卡片/视频封面）像 `[1,2,[3,[4]]].flat(Infinity)` 一样在网格中直接摊开浏览。

### 1.2 目标（Goals）
1. **纯内存零读盘**：Flat 模式完全基于现有 NeDB 内存缓存（`searchCache.db`），根据当前根路径前缀递归汇总其下所有子目录中的非目录项（`!isDirectory && type !== 'folder'`），不读取、不扫描移动硬盘。
2. **模式切换与交互**：在顶部工具栏常驻「正常视图 / 平铺视图」切换按钮。仅当处于根缓存目录（`history.length === 1 && !playlistLevel`）时允许切换，其余子层级或无效层级禁用并提示。
3. **极简复用既有能力**：扁平化后的条目统一经服务端 `toWire()` / `toAnchor()` 处理，缩略图懒加载、预览大图、双击播放视频、名称拼音搜索等既有能力 100% 保持无缝工作。
4. **状态与边界自洽**：换根或清空导航历史时自动复位模式；支持离线只读锚点（`#serial/...`）下的 Flat 展开。

### 1.3 明确不做（Non-Goals）
1. 不对未缓存的磁盘目录执行递归读盘（未缓存的子目录不强行物理扫描，严格恪守零读盘原则）。
2. 不做多层分组小标题（按用户明确裁决，单纯打平成统一一维数组网格）。

---

## 2. 备选方案与选型（Approaches）

| 方案 | 数据获取与聚合方式 | 优势 | 劣势 | 结论 |
|---|---|---|---|---|
| **方案 A（已选）：服务端 `/openFolder` 加 `flat=true`** | 服务端在 NeDB 内存中按前缀查出当前根下所有子条目，滤掉中间文件夹拍平，统一走 `toWire()` 下发 | 改动极小（后端约 30 行，前端加一按钮），缩略图/大图与 `toWire` 机制 100% 统一，零读盘 | 无明显劣势 | **采用（用户确认）** |
| **方案 B：独立新增 `/openFolderFlat` 接口** | 单独起一个新路由并拆分数据管道，前端根据模式切换请求不同地址 | 接口职责分离 | 逻辑与 `/openFolder` 大量重复，增加维护成本 | 放弃 |

---

## 3. 详细设计与边界规范（Specifications）

### 3.1 后端接口与 NeDB 查询（`electron/server/`）
1. **NeDB 子树条目查询**（`electron/server/nedb.ts`）：
   - 新增 `findSubtreeLeafItems(serial: string, baseRel: string, mode: OpenMode = 'cover'): Promise<FileInfo[]>`。
   - 纯内存查询该 `serial` 下所有以 `baseRel` 为前缀的缓存记录。
   - 提取所有文档中的 `data`，筛选过滤掉 `item.type === 'folder' || item.isDirectory`，保留作品封面和视频文件。
   - 按相对路径 `joinRel(item.dir, diskNameOf(item))` 去重。
   - 默认按名称自然序排升序（Natural Sort）。
2. **`/openFolder` 控制器**（`electron/server/index.ts`）：
   - 解析参数 `flat === 'true'`。
   - 若 `flat` 为真：
     - 若为只读锚点（`parseAnchor`）：从 `findSubtreeLeafItems(anchor.serial, anchor.relPath, mode)` 获取条目，经 `toAnchor` 返回。
     - 若为实时盘符：直接从 `findSubtreeLeafItems(serial, relPath, mode)` 获取条目，经 `toWire` 返回。
     - **不触发任何磁盘 readdir 或 stat 操作**。

### 3.2 前端视图与交互（`src/views/FileFinder/`）
1. **状态定义**：
   - `const isFlatView = ref(false)`。
   - `const canToggleFlat = computed(() => history.value.length === 1 && !playlistLevel.value && !!currentPath.value)`。
2. **工具栏按钮**：
   - 在顶部 `toolbar`（刷新按钮旁或搜索框旁）增加平铺视图切换按钮。
   - 按钮显示当前模式状态（高亮 / 图标变换），悬停提供 Tooltip 说明。
   - 当 `!canToggleFlat` 时处于 `:disabled` 状态。
3. **数据请求**：
   - `requestFolder(path, noCache, flat)` / `loadScreen(entry, flat)`：在 `isFlatView.value` 为 true 时向 `/openFolder` 传递 `&flat=true`。
   - 切换按钮点击后即时触发当前屏重新拉取（内存响应 <10ms）。
4. **导航与重置边界**：
   - `setRoot` / `clearNav`：切根或清空时将 `isFlatView.value = false`。
   - 离线/在线切换（`onDisksChanged`）：保持当前 flat 状态并重新以新地址拉取。
