# 设计文档 · 收藏夹（清单）信息同步与状态对齐机制

> 日期：2026-11-06  
> 状态：待用户审批（Approved Gate）  
> 关联：`electron/server/playlistStore.ts` · `electron/server/playlist.ts` · `electron/server/assistant/apply.ts` · `src/views/FileFinder/index.vue` · `openDecision.ts`

---

## 1. 背景与目标（Intent & Goals）

### 1.1 背景与痛点
用户使用 file-finder 收藏影片至收藏夹（清单）后，影片后续可能会发生元数据变更（如管理助手抓取番号、更换封面、补全分卷信息、重新扫描目录等）。目前收藏夹条目在加入时仅保存了一次性的静态快照（`name`、`ext`、`size`、`sig`、`files` 等写入 `playlists.json`）。由于收藏模块完全独立于本地扫描缓存（NeDB `searchCache.db`）且不监听变更事件，导致：
1. **封面不同步**：影片换了新封面后，收藏夹中依旧显示旧缩略图；旧图若从 `bin/` 仓被清理，则直接呈现 404 破图。
2. **整理后断链**：助手将单视频打包为番号同名文件夹（`foo.mp4` -> `foo/foo.mp4`）后，收藏夹依然记录旧文件路径，导致双击打不开、主网格星标消失。
3. **失效无感知**：文件若被物理删除或彻底移走，收藏夹不显示任何异常，点击时直接弹红字报错。

### 1.2 核心原则
- **严格恪守“零读盘”**：移动硬盘可能拔出或休眠。浏览收藏夹货架与详情屏时，严禁读取或唤醒任何移动硬盘，所有信息对齐均基于系统盘（C 盘）已有的 NeDB 缓存与本地配置。
- **离线友好、软降级**：硬盘离线时保留最后已知有效快照并标注离线；文件若在线且确认丢失，标记为“已失效”，不粗暴静默删除用户数据。

### 1.3 目标（Goals）
1. **读时轻量投影（NeDB 联动）**：
   在获取收藏列表（`GET /playlists`）与清单详情（`GET /playlistItems`）时，根据条目的 `(serial, relPath)` 查验本地 NeDB 内存缓存。若 NeDB 中该条目的 `sig`（缩略图指纹）、`files`（代言卡分卷列表）、`size`（大小）发生变更，直接将最新元数据投影至前端下发对象，并在后台异步回写固化至 `playlists.json`。
2. **写端事件联动（助手写盘感知）**：
   管理助手完成刮削写盘（`apply.ts`）时（包括换封面、单视频打包成文件夹），主动触发对 `playlistStore` 的同步更新，使涉及条目的 `relPath`、`type`、`sig`、`files` 当场更新。
3. **失效态展示与交互**：
   当所属硬盘在线，且父目录在 NeDB 缓存中存在、但确认不再包含该条目时，条目下发 `missing: true`。前端网格卡片显示 `[已失效]` 徽标，双击或回车给予温和提示，右键保留“从清单移除”。
4. **星标与选单状态自洽**：
   收录索引的 `keys` 动态保持与主网格卡片计算出的 `keyOf(card)` 一致，确保信息更新或单文件转文件夹后，主网格卡片上的星标与选单 `✓` 依然准确高亮。

### 1.4 明确不做（Non-Goals）
1. 不在打开收藏夹时发起物理磁盘扫描（严格零读盘）。
2. 不进行全盘范围的模糊寻址猜测（避免多文件同尺寸误判路径）。
3. 不静默抹除用户的收藏条目（哪怕失效也必须保留卡片留给用户决定是否移除）。

---

## 2. 方案选型与对比（Approaches）

| 方案 | 同步时机与数据源 | 优势 | 劣势 | 结论 |
|---|---|---|---|---|
| **方案 A（已选）：本地缓存投影 + 助手写盘主动联动** | 1. 助手写盘（`apply.ts`）主动更新条目<br>2. 读收藏时查 NeDB 内存缓存动态对齐并异步回写 | **严格零读盘**；全场景闭环（助手刮削、手动换封面、F5 重扫皆能同步）；与现有架构 100% 契合 | 外部在 Windows 资源管理器手工改名且未重扫目录时，需等重扫才能同步 | **采用（用户确认）** |
| **方案 B：缓存投影 + 在线盘物理探测与模糊重定位** | 在方案 A 基础上，盘在线时对失效条目做 `fs.stat` 探测并在同级目录模糊寻找同大小文件 | 容忍外部随意改名 | 违反零读盘初衷；模糊匹配在分卷或同大小文件下存在误判风险 | 放弃 |
| **方案 C：仅纯事件通知** | 仅在 `apply.ts` 写盘时硬编码更新 `playlists.json`，读端不查 NeDB | 改动行数少 | 脆弱：若通过 F5 刷新重新提取封面，收藏夹依旧停在过去 | 放弃 |

---

## 3. 详细架构与技术设计（Specifications）

### 3.1 核心数据结构调整

#### `PlaylistItem`（`electron/server/playlistStore.ts`）
在快照属性基础上，保持结构向后兼容：
```ts
export interface PlaylistItem {
    id: string;
    serial: string;
    relPath: string;
    name: string;
    ext?: string;
    type: 'folder' | 'image' | 'video' | 'file';
    size: number;
    sig?: string;
    files?: { name: string; size: number }[];
    addedAt: number;
    /** 标记最后一次成功对齐的时间戳 */
    updatedAt?: number;
}
```

#### `WiredFileInfo`（`electron/server/index.ts` / 前端类型）
下发条目增加可选字段：
```ts
export interface WiredFileInfo {
    // ... 既有字段 ...
    missing?: boolean; // true 表示所属硬盘在线但文件未找到（已失效）
}
```

---

### 3.2 存储层扩展（`electron/server/playlistStore.ts`）

1. **批量更新快照方法**：
   新增 `updateItemsByScan(dataDir: string, reconciler: (item: PlaylistItem) => { changed: boolean; item: PlaylistItem }): Promise<number>`
   - 遍历所有清单中的条目，执行纯函数比对；
   - 若有变动，调用既有的 `queueWrite` + `atomicWrite` 串行回写 `playlists.json`。

2. **单条目/位置精准定向更新**：
   新增 `patchItemByLocation(dataDir: string, serial: string, relPath: string, name: string, patch: Partial<PlaylistItem>): Promise<boolean>`
   - 供助手写盘迁移时精准将旧路径指向新路径（匹配序列号 + 相对路径 + 文件名）。

---

### 3.3 读端动态对齐逻辑（`electron/server/playlist.ts`）

在现有架构中，封面代言卡（`type: 'image'` + `files: [...]`）是保存在**其父目录**的 NeDB 缓存记录中（例如 `movies/ABC-123` 的封面信息存在 `relPath = 'movies'` 的缓存文档里）。

在 `listPlaylists` 和 `listItems` 执行时，执行如下纯内存对齐：
1. **确定父层缓存路径**：
   - 提取 `parentRel = dirOf(it.relPath)`。
   - 调用 `findCache({ serial: it.serial, relPath: parentRel, mode: 'cover' })`（纯内存操作，耗时 <1ms）。
2. **在缓存中寻找匹配的目标条目**：
   - 若 `it.type === 'image'`（封面代言卡）：在 `cache.data` 中按 `item.name === it.name`（或 `item.dir === it.relPath`）匹配。
   - 若 `it.type === 'video' | 'file'`：
     - 先在 `cache.data` 中匹配 `item.name === it.name && item.ext === it.ext`。
     - 若未命中，检查 `cache.data` 中是否存在以 `it.name` 为名的封面代言卡（`type === 'image' && item.name === it.name`，即单视频被助手整理收敛为同名文件夹）。若命中，则自动升级为封面代言卡（`type: 'image'`，`relPath: joinRel(parentRel, it.name)`，并同步其 `files` 和 `sig`）。
3. **差异检测与投影**：
   - 若匹配到缓存条目：
     - 若 `target.sig !== it.sig` 或 `target.size !== it.size` 或 `target.files` 有更新：
       将最新的 `sig`、`size`、`files`、`type`、`relPath` 投影到下发对象中，并标记需要持久化回写。
   - **已失效判定（`missing: true`）**：
     - 满足以下条件时标记 `missing: true`：
       1. 所属硬盘在线（`drive !== ''`）；
       2. 父目录缓存存在（`cache !== null`，证明该目录已知且被扫描过）；
       3. 在 `cache.data` 中既找不到原文件，也找不到升级后的同名代言卡。
4. **异步回写**：
   - 若本轮有条目元数据对齐变更，在向前端 `sendJson` 后，异步触发 `persist(dataDir, list)`，无需等待 I/O 阻塞前端响应。

---

### 3.4 助手写盘联动（`electron/server/assistant/apply.ts`）

在 `apply.ts` 执行完 `applyGroups`（写盘与 rename 完成）的最后阶段：
- **当单文件视频被 rename 入新建的番号文件夹 `<query>/` 并生成封面**：
  调用 `patchItemByLocation`，精准匹配 `serial === driveSerial && relPath === layerDir && name === query`：
  更新为封面代言卡：`relPath: joinRel(layerDir, query)`，`type: 'image'`，`name: query`，`sig: newSig`，`files: newFiles`。
  （注意：保持 `type: 'image'` 使得双击行为依然是直接播放视频，符合影片卡片契约）。
- **当仅更新封面（换封面/补封面）**：
  更新该条目的 `sig` 为最新缩略图指纹。

---

### 3.5 前端展示与交互（`src/views/FileFinder/`）

1. **已失效徽标（`missing`）**：
   - 网格卡片（`index.vue`）：当条目 `item.missing === true` 时，在卡片右上角显示暗红背景的 `[已失效]` 徽标。
   - 在清单详情屏下，换封面模式禁用，右上角无冲突，排布清晰。
2. **交互拦截（双击与回车）**：
   - 在 `openDecision.ts` 中感知 `item.missing`：双击或按下 Enter 时均进行拦截，不调用 `openFile`，直接弹出 toast 提示「该文件已不在原路径或已被删除」。
3. **右键操作**：
   - 清单视图下，右键依然提供「从清单移除」，允许用户单条清理失效条目。
4. **星标联动**：
   - `buildMemberMap` 基于实时纠偏后的 `keys`，主网格卡片在助手刮削完成后，星标不会脱落。

---

## 4. 边界与异常处理

1. **硬盘离线时的行为**：
   - 若硬盘未插入（`drive === ''`），条目标记为既有的离线状态（`dir` 为 `#serial/rel` 锚点），绝对不标记为 `missing`（盘都不在，不妄判文件丢失）。
   - 离线时若 NeDB 有缓存记录，依然正常从 NeDB 提取最新 `sig`（缩略图在系统盘 `bin/` 仓）。
2. **NeDB 缓存未收录/未扫描**：
   - 若父目录尚未被软件浏览或扫描过（NeDB `findCache` 返回 null），保留 `playlists.json` 的原有快照展示，不误标为 `missing`。
3. **回写冲突与原子性**：
   - 依赖 `playlistStore.ts` 既有的 `WRITE_CHAINS` 串行写队列与 `tmp -> rename` 原子替换，多次并发读对齐绝不会写坏文件。

---

## 5. 验证与测试方案

1. **类型检查**：`npm run typecheck` 0 error。
2. **单元探针验证（`docs/probes/playlist-sync/`）**：
   - 探针 1：模拟条目存在旧 `sig`，NeDB 注入新 `sig`，验证读取时是否正确投影并回写 `playlists.json`。
   - 探针 2：模拟单视频单文件被移入同名文件夹，验证路径与类型自愈升级为封面代言卡。
   - 探针 3：模拟盘在线且父目录存在、但条目不在 NeDB 中，验证 `missing: true` 标记生成；模拟盘离线，验证不误标 `missing`。
3. **真实场景验收**：
   - 收藏某部单文件影片 -> 运行管理助手对其刮削并应用封面 -> 返回收藏夹，确认封面已变更新图、双击能直接播放影片。
   - 模拟删除该文件并在主网格 F5 重扫 -> 进入收藏夹，确认呈现 `[已失效]` 徽标，双击和回车均温和提示。
