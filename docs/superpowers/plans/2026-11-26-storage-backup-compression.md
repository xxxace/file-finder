# 存储、缓存数据库与导入导出全面瘦身实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将扫描缓存库迁至 `node:sqlite` + Zstd 紧凑存储以大幅降内存、将图片仓迁至 `bin.sqlite` + `sharp` WebP 管线提升速度并消除小文件碎片、以流式 `.ffbak` 固实单文件替代 `.zip` 导出，并在设置页提供可预览的孤儿图与冗余备份清理面板。

**Architecture:** 保留既有对外模块边界与 HTTP/URL 契约（`electron/server/nedb.ts` 与 `electron/utils/binStore.ts` 作为稳定门面，`t-<sig>.enc` / `p-<sig>.enc` 作为逻辑接口键），内部底层分别切换至 Node 24 原生 `node:sqlite`（`cache.sqlite` 与 `bin.sqlite`）、`node:zlib` 原生 Zstd 及 `sharp` 异步图像管线；启动时通过双源透明回落与后台分片事务完成历史数据零重扫无损迁移。

**Tech Stack:** Electron 44.4.5, Node 24.12 (`node:sqlite`, `node:zlib`, `node:test`), `sharp`, Vue 3 + Naive UI, TypeScript (`npm run typecheck`)

**Spec:** [2026-11-26-storage-backup-compression-design.md](file:///d:/code/file-finder/docs/superpowers/specs/2026-11-26-storage-backup-compression-design.md)

## Global Constraints

- **零二次降质**：导出/导入过程严禁对图片做有损重编码；存量旧版 `bin/*.enc` JPEG 原样无损迁入 `bin.sqlite`，绝不重编码；仅新扫描/懒生成图像使用 `sharp` 单次编码为 WebP（`t-` q78、`p-` q86），且若转化后字节 ≥ 原字节（原图长边 ≤ 2048 且 ≤ `PREVIEW_VERBATIM_MAX`）则保留原字节。
- **内存最小化**：`loadMeta()` 及列表/统计接口只能读取 SQLite 元数据列，绝不读取或解压 `data_zstd`；全量条目数组严禁常驻 JS 堆。
- **启动无阻塞**：`app.listen(3060)` 绝不等大批量 `bin/*.enc` 迁移完才放行；必须支持双源读取与后台分片迁移。
- **安全与兼容**：导入同时兼容 `.ffbak`（魔数 `FFBK`）与历史 `.zip`（魔数 `PK\x03\x04`）；还原与合并均对 `playlists.json` 与 `assistant-hits.jsonl` 执行只增不删合并；孤儿图计算必须在 `cache.sqlite` 正常打开且记录数 > 0 时才放行，且带 1 小时近期写入保护窗。
- **样式与验证纪律（`AGENTS.md`）**：`.vue` / `.ts` 严禁出现 `#hex` 或 `rgba(...)` 字面量，一律使用 `src/styles/tokens.css` 的 `var(--ff-*)`；每次代码改动后必须通过 `npm run typecheck`。

## Review Focus

1. 截断或字节损坏的 `.ffbak` 在还原/合并时必须在校验 `Magic` / `CRC32` / `FEND` 阶段立即报错中止，绝不触碰主库或快照覆盖。
2. `cache.sqlite` 损坏或为空库（0 条记录）时，设置页孤儿盘点与 `.ffbak` 打包绝不能误判全量 `bin.sqlite` 图片为孤儿而删库。
3. 首次冷启动携带数千个历史 `bin/*.enc` 时，HTTP 服务必须立即监听 3060 端口并通过双源回落无缝服务尚未迁入的 `.enc` 图像，后台迁移按 80 张/批平滑推进且断电可续。
4. 通过 `restoreFromFile` / `mergeCache` 导入旧版 `.zip`（含 v2 内嵌 `thumbData` base64 或 AES 密文 `bin/*.enc`）时，必须完整解密/剥离并写入 `bin.sqlite` 与 `cache.sqlite`。
5. `sharp` 遇到极小/已极限压缩的源图时绝不能存入更大的 WebP，遇到 `sharp` 不支持格式（如 `.psd` / 损坏文件头）时必须无缝回落至现有 `ffmpeg` `transcodeImage` 链路。

---

### Task 1: 引入 `sharp` 并升级 `thumbnail.ts` 为 WebP 异步管线

**Files:**
- Modify: `package.json`
- Modify: `electron-builder.json5:11-15`
- Modify: `electron/utils/thumbnail.ts:1-155`
- Create: `tests/thumbnail.test.mjs`

**Interfaces:**
- Consumes: `@ffmpeg-installer/ffmpeg`, `sharp`
- Produces:
  - `imageRenditions(filepath: string): Promise<{ thumb: Buffer | null; preview: Buffer | null }>`（输出 WebP Buffer 或体积更小时保留源 JPEG/WebP Buffer）
  - `scaleToThumb(input: Buffer): Promise<Buffer>`
  - 保留既有导出常量与函数签名：`THUMB_WIDTH = 384`, `THUMB_QUALITY = 78`, `PREVIEW_LONG_EDGE = 2048`, `PREVIEW_QUALITY = 86`, `PREVIEW_VERBATIM_MAX`, `videoRenditions`, `frameJpeg`, `frameJpegAt`, `probeVideoSeconds`, `secondsOf`, `transcodeImage`, `COVER_JPEG_QUALITY`, `FRAME_LONG_EDGE`

- [ ] **Step 1: 安装 `sharp` 并在 `electron-builder.json5` 配置 `asarUnpack`**

Run: `npm install sharp`
Expected: `package.json` 与 `package-lock.json` 新增 `sharp`，且 `node -e "const s = require('sharp'); console.log(Boolean(s))"` 输出 `true`。

在 `electron-builder.json5` 的 `asarUnpack` 数组中追加：
`"node_modules/sharp/**"`, `"node_modules/@img/**"`

- [ ] **Step 2: 编写失败测试 `tests/thumbnail.test.mjs`**

覆盖以下断言：
1. 生成一张 2400×1600 合成 PNG 临时文件，调用 `imageRenditions(file)`：返回的 `thumb` 与 `preview` 前 4 字节为 `RIFF` 且 8..12 字节为 `WEBP`；`sharp(thumb).metadata()` 宽度为 384；`sharp(preview).metadata()` 长边为 2048。
2. 生成一张极小高压缩 JPEG（长边 ≤ 2048、字节数 < WebP 输出），调用 `imageRenditions(file)`：验证 `preview.equals(sourceJpegBuf)` 为 `true`（触发绝不变大兜底闸）。
3. 传入不存在的文件路径，验证返回 `{ thumb: null, preview: null }` 且不抛异常。
4. 传入带非标准扩展名或触发 `ffmpeg` 兜底路径的输入，验证降级路径可用。

- [ ] **Step 3: 运行测试确认失败**

Run: `node --test tests/thumbnail.test.mjs`
Expected: FAIL（当前 `thumbnail.ts` 依赖 Electron `nativeImage` 输出 JPEG，在纯 Node 环境报错或非 WebP）。

- [ ] **Step 4: 重写 `electron/utils/thumbnail.ts` 图像缩放/编码管线**

核心改动要点：
- 用 `sharp(buf, { failOn: 'none' }).rotate()` 替换静态图链路里的 `nativeImage`（按 EXIF 自动旋正且不依赖 Electron 主进程阻塞缩放）。
- `scaleToThumb(imgBufOrSharp)`：`resize({ width: THUMB_WIDTH, withoutEnlargement: true }).webp({ quality: THUMB_QUALITY, effort: 4 }).toBuffer()`。
- `scaleToPreview(meta, baseSharp, verbatimCandidate)`：缩至长边 ≤ `PREVIEW_LONG_EDGE`（`fit: 'inside', withoutEnlargement: true`），输出 `.webp({ quality: PREVIEW_QUALITY, effort: 4 })`；若 `verbatimCandidate` 存在（合法 JPEG/WebP、长边 ≤ 2048、字节 ≤ `PREVIEW_VERBATIM_MAX`）且 `webpBuf.length >= verbatimCandidate.length`，返回 `verbatimCandidate`。
- 若 `sharp` 解码失败且文件存在，仍走 `transcodeImage(filepath, tmpPng)` 兜底转 PNG 再进 `sharp` 管线。
- `frameJpegAt` 若仍供封面写盘使用（不依赖 `nativeImage` 亦可改用 `sharp` 缩至 `maxEdge` 并 `.jpeg({ quality: COVER_JPEG_QUALITY })`，避免主进程同步卡顿）。

- [ ] **Step 5: 运行测试确认通过，并运行 `npm run typecheck`**

Run: `node --test tests/thumbnail.test.mjs && npm run typecheck`
Expected: 测试全部 PASS，typecheck 0 错误。

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json electron-builder.json5 electron/utils/thumbnail.ts tests/thumbnail.test.mjs
git commit -m "feat(thumbnail): switch image renditions to sharp WebP pipeline with size guard"
```

---

### Task 2: 实现 `cacheCodec.ts` 与基于 `node:sqlite` 的 `cache.sqlite` 存储层（`nedb.ts` 门面替换）

**Files:**
- Create: `electron/server/cacheCodec.ts`
- Modify: `electron/server/nedb.ts`（整体以 `node:sqlite` 实现原导出接口，保留 `collectTunnelCovers`、`mergeSubtreeBytes`、`mergeSubtreeLeafItems` 等纯函数）
- Create: `tests/cacheDb.test.mjs`

**Interfaces:**
- Produces (`cacheCodec.ts`):
  - `encodeCacheData(relPath: string, items: FileInfo[]): Buffer`（精简冗余 `dir`/`isDirectory` + 短键序列化 + `zlib.zstdCompressSync` level 9）
  - `decodeCacheData(relPath: string, blob: Buffer): FileInfo[]`
- Produces (`nedb.ts` 保持兼容全部现有调用方并新增):
  - 既有导出：`CACHE_VERSION`, `SearchCache`, `CacheMeta`, `OpenMode`, `BrowseHistory`, `BrowseHistoryWithPagination`, `TunnelCoverItem`, `CACHE_DB_PATH`（指向 `cache.sqlite`）, `BEFORE_RESTORE_PATH`（指向 `cache-before-restore.sqlite`）, `beginRestore`, `endRestore`, `reloadFromDisk`, `findCache`, `insertCache`, `removeCache`, `loadMeta`, `loadSubtreeBytes`, `mergeSubtreeBytes`, `mergeSubtreeLeafItems`, `findSubtreeLeafItems`, `findAllCachedCovers`, `collectTunnelCovers`, `workKeyOf`, `exportSnapshotPlain`, `exportCompactSnapshot`, `readExternalCache`, `compact`, `migrateLegacyThumbs`
  - 新增导出：`initCacheDb(dataDir?: string): Promise<void>`（测试可传入临时目录）、`getCacheDbBytes(): Promise<number | undefined>`、`exportAllCacheDocs(): Promise<SearchCache[]>`、`replaceAllCacheDocs(docs: SearchCache[]): Promise<void>`、`snapshotCacheTo(destPath: string): Promise<void>`、`collectReferencedSigsFromCache(): Promise<{ ok: boolean; count: number; sigs: Set<string> }>`

- [ ] **Step 1: 编写失败测试 `tests/cacheDb.test.mjs`**

覆盖以下断言：
1. `encodeCacheData` / `decodeCacheData` 往返测试：输入含普通文件、目录（`type: 'folder', isDirectory: true`）与收敛封面（`dir` 为子目录、`files` 数组、`sig`、`srcMtime`、`srcBytes`），解压还原后与输入深度全等，且压缩体积显著小于明文 JSON。
2. `cache.sqlite` CRUD 与大小写不敏感契约：`insertCache` 写入 `relPath: 'Actors/Julia'`，`findCache(serial, 'actors/julia', 'cover')` 命中并返回原大小写 `Actors/Julia`；`removeCache(serial, 'ACTORS/JULIA', 'cover')` 清除成功；重复同主键插入直接替换且无重复行。
3. `loadMeta({ withBytes: true, sortBy: 'path', dir: 1 })` 正确返回预计算的 `bytes`、`count` 与合成 `_id`，且不触发 `decodeCacheData`（通过测试 spy/计数断言解压调用次数为 0）。
4. `findSubtreeLeafItems` 与 `findAllCachedCovers` 正确过滤并流式解压返回结果。
5. 旧库迁移测试：构造一份加密的 `searchCache.db`（包含 AES+Base64 行、一条 `$$deleted` 行、一条明文 JSON 行、一条含 v2 `thumbData` 的旧行），启动 `initCacheDb(tmpDir)` 后验证：活跃记录全部迁入 `cache.sqlite`、已删行未复活、v2 `thumbData` 提取并写入回调、`searchCache.db` 被重命名为 `searchCache.db.migrated.bak`。
6. `collectReferencedSigsFromCache()` 在空库时返回 `{ ok: true, count: 0, sigs: Set(0) }`，库损坏时返回 `{ ok: false, ... }`。

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test tests/cacheDb.test.mjs`
Expected: FAIL（`cacheCodec.ts` 尚不存在 / `nedb.ts` 未接入 `node:sqlite`）。

- [ ] **Step 3: 实现 `electron/server/cacheCodec.ts`**

使用短键映射序列化 `FileInfo[]`（若 `item.dir === docRelPath` 则省略 `d`，若 `item.type === 'folder'` 则省略 `isDirectory`）并用 `zlib.zstdCompressSync(Buffer.from(JSON.stringify(slim)), { params: { [zlib.constants.ZSTD_c_compressionLevel]: 9 } })` 压成 `BLOB`；解压时用 `zlib.zstdDecompressSync` 还原并补齐 `dir` 与 `isDirectory`。

- [ ] **Step 4: 重写 `electron/server/nedb.ts` 底层为 `node:sqlite`**

核心实现要点：
- 使用 `DatabaseSync` 打开 `cache.sqlite`，执行 `PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000; PRAGMA auto_vacuum = INCREMENTAL;` 并建表 `cache_entries`（`WITHOUT ROWID`，主键 `(serial, rel_path_lower, mode)`）与索引 `idx_cache_serial_mode`。
- 把 `_id` 统一生成为稳定确定串 `${serial}\0${relPath.toLowerCase()}\0${mode}`，保证前端表格 `rowKey` 与 `/removeHistoryBatch` 零改动且稳定。
- 迁移逻辑 `migrateLegacyNedbFile`：若存在 `searchCache.db` 且 `cache.sqlite` 尚未创建，先写 `cache.sqlite.migrating`：流式按行用 `decryptLine` 解析，跳过 `$$indexCreated`、应用 `$$deleted`、处理未迁的 v2 `thumbData`（回调或队列转存到图片仓后删去 base64 字段、升级 `v = CACHE_VERSION`），在单一 SQLite 事务内写入，校验行数后 `close()` 并原子 `rename` 成 `cache.sqlite`，把老库改名为 `searchCache.db.migrated.bak`（若 `bin` 尚未就绪则先把提取出的 v2 图片缓冲暂存队列或调用已注册回调）。
- `snapshotCacheTo(destPath)`：使用 `await backup(db, destPath)`（或 `VACUUM INTO`）生成独立干净快照文件供还原失败回滚。
- 保留 `assertUsable()` 闸门，加载失败时同样响亮报错。

- [ ] **Step 5: 运行测试与 typecheck**

Run: `node --test tests/cacheDb.test.mjs && npm run typecheck`
Expected: 测试全部 PASS，typecheck 0 错误。

- [ ] **Step 6: Commit**

```bash
git add electron/server/cacheCodec.ts electron/server/nedb.ts tests/cacheDb.test.mjs
git commit -m "feat(db): migrate searchCache from NeDB to node:sqlite with zstd compact blobs"
```

---

### Task 3: 实现 `bin.sqlite` 图片仓与渐进无阻塞后台迁移（`binStore.ts` + `server/index.ts` 对接）

**Files:**
- Modify: `electron/utils/binStore.ts`
- Modify: `electron/server/index.ts:1244-1352,1443-1534`
- Create: `tests/binStore.test.mjs`

**Interfaces:**
- Produces (`binStore.ts`):
  - `initBinStore(dataDir?: string): Promise<void>`
  - `whenBinReady(): Promise<void>`（仅在打开 `bin.sqlite` + 扫描待迁 `bin/*.enc` 文件名后即 resolve，**< 10ms，绝不阻塞 `app.listen(3060)`**）
  - `hasBin(name?: string): boolean`
  - `getBin(name: string): { buf: Buffer; contentType: 'image/webp' | 'image/jpeg' } | null`（若需要保持兼容可另提供 `getBinEntry` 或直接升级返回结构并在 `server/index.ts` 解包）
  - `putBin(name: string, plain: Buffer): Promise<void>`（按微任务批合并入单事务写入 `bin.sqlite`）
  - `putBinsBatch(items: { name: string; buf: Buffer }[]): Promise<void>`
  - `binStats(): Promise<{ count: number; bytes: number }>`（直接查 SQLite `COUNT(*), COALESCE(SUM(size), 0)` + 待迁文件统计缓存）
  - `getBinDbBytes(): Promise<number | undefined>`
  - `listBinEntries(): { kind: 't' | 'p'; sig: string; name: string }[]`
  - `readBinEntryForBackup(kind: 't' | 'p', sigHex: string): { fmt: number; data: Buffer } | null`
  - `deleteBinsBatch(keys: { kind: 't' | 'p'; sig: string }[]): Promise<{ removed: number; freed: number }>`（事务删除后执行 `PRAGMA incremental_vacuum`）
  - `getLegacyBinPendingCount(): number`、`waitForLegacyMigration(): Promise<void>`（测试用）

- [ ] **Step 1: 编写失败测试 `tests/binStore.test.mjs`**

覆盖以下断言：
1. 写入 WebP 与 JPEG Buffer 到 `putBin` / `putBinsBatch`：`hasBin` 为真，`getBin` 返回原始字节与精准 `contentType`（`image/webp` / `image/jpeg`）；按内容自动识别 `fmt`（1=jpeg, 2=webp）。
2. 双源透明读取与后台渐进迁移测试：在临时 `bin/` 目录放置 120 个由 `encryptBlob` 加密的旧 JPEG `.enc` 文件（含 `t-` 与 `p-`），调用 `initBinStore(tmpDir)`：
   - `whenBinReady()` 在未完成迁移前即可快速 resolve；
   - 迁移过程中 `hasBin` 对所有 120 张均为 `true`，`getBin` 能正常解密并返回字节；
   - `waitForLegacyMigration()` 完成后，120 张全部进入 `bin.sqlite`，磁盘 `bin/*.enc` 被清理，且图片字节与原 JPEG 逐字节一致。
3. 批量删除与空间归还：写入大块数据后调用 `deleteBinsBatch` 删掉大部分行，验证 `bin.sqlite` 文件大小在 `PRAGMA incremental_vacuum` 后明显缩减。

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test tests/binStore.test.mjs`
Expected: FAIL（`binStore.ts` 尚未改造成 `bin.sqlite`）。

- [ ] **Step 3: 重写 `electron/utils/binStore.ts`**

核心要点：
- `bin.sqlite` 表 `bins (kind TEXT, sig BLOB, fmt INTEGER, size INTEGER, created_at INTEGER, data BLOB, PRIMARY KEY (kind, sig)) WITHOUT ROWID`，开启 `WAL`、`auto_vacuum = INCREMENTAL`。
- `detectImageFmt(buf)`：检查 `RIFF....WEBP` → `2`（`image/webp`），其余默认 `1`（`image/jpeg`）。
- 写批处理队列：短时间并发的 `putBin` 调用经由微任务（`queueMicrotask` / `setImmediate`）聚拢，在一笔 `BEGIN ... COMMIT` 事务内执行 `INSERT OR REPLACE`，避免扫盘写几十张图时产生几十次单独刷盘。
- 后台迁移器 `runLegacyMigration()`：按 **80 个文件/批**读取旧 `bin/*.enc` → `decryptBlob` → 事务写入 `bin.sqlite` → 校验行数后逐批 `unlink` 原 `.enc`，每批间 `await new Promise(r => setImmediate(r))` 让出事件循环；全部完成后若 `bin/` 为空尝试 `rmdir`。
- 注意保持 `migrateLegacyThumbs()`（v2 库内嵌 base64 出库）与 `initBinStore` 的联动：v2 迁移直接调 `putBinsBatch` 写入 `bin.sqlite`。

- [ ] **Step 4: 更新 `electron/server/index.ts` 中 `/thumb`、`/preview` 与 `/getDisks` 对接**

- `thumbController` 与 `previewController` 使用新 `getBin(name)` 返回的 `{ buf, contentType }` 设置 `Content-Type` 头；
- `listDisksController` 的 `stats.dbBytes` 汇总 `cache.sqlite`（以及 `binBytes` 同步取 `binStats()`）。
- `flushRenditions` 可保持现有 `pending` 收集，利用 `binStore` 的微任务批事务自动合批。

- [ ] **Step 5: 运行测试与 typecheck**

Run: `node --test tests/binStore.test.mjs && npm run typecheck`
Expected: 测试全部 PASS，typecheck 0 错误。

- [ ] **Step 6: Commit**

```bash
git add electron/utils/binStore.ts electron/server/index.ts tests/binStore.test.mjs
git commit -m "feat(bin): store images in bin.sqlite with non-blocking legacy .enc migration"
```

---

### Task 4: 辅助缓存文件瘦身（`gfriends/filetree.zst` 与 `assistant-hits.jsonl` 去重压缩）

**Files:**
- Modify: `electron/server/assistant/gfriends.ts:204-279`
- Modify: `electron/server/assistant/hits.ts`
- Create: `tests/auxCache.test.mjs`

**Interfaces:**
- Produces (`gfriends.ts`): `ensureGfriendsIndex(dataDir: string, forceUpdate?: boolean): Promise<GfriendsIndex>`（透明改写/读取 `gfriends/filetree.zst`，无模块级常驻缓存，遇旧 `filetree.json` 自动转 `.zst` 并删旧 `.json`）
- Produces (`hits.ts`):
  - 既有导出：`HitRecord`, `loadHits`, `appendHit`, `appendTombstone`
  - 新增导出：`compactHits(dataDir: string): Promise<{ beforeLines: number; afterLines: number }>`、`mergeHits(dataDir: string, incoming: HitRecord[]): Promise<{ added: number; updated: number }>`、`exportActiveHits(dataDir: string): Promise<HitRecord[]>`

- [ ] **Step 1: 编写失败测试 `tests/auxCache.test.mjs`**

覆盖以下断言：
1. `gfriends` 迁移与读取：在临时目录写入旧版 `gfriends/filetree.json`，调 `ensureGfriendsIndex(tmpDir, false)`，验证生成 `gfriends/filetree.zst`、删除旧 `filetree.json`，内容解析与原数据一致，且 `.zst` 体积远小于原 JSON。
2. `hits` 压缩去重：写入含重复 `id`（旧时间+新时间）与墓碑行（`coverUrl: ''`）的 `assistant-hits.jsonl`，调用 `compactHits(tmpDir)` 后验证文件行数缩减为仅剩活跃记录（墓碑已清理且只留最新）。
3. `mergeHits(tmpDir, incoming)`：按 `id` 合并，保留 `at` 时间戳较新且非墓碑的记录，同时不覆盖本机更新的记录。

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test tests/auxCache.test.mjs`
Expected: FAIL（`.zst` 与 `compactHits`/`mergeHits` 尚不存在）。

- [ ] **Step 3: 改造 `gfriends.ts` 与 `hits.ts`**

- `gfriends.ts`：`writeZstJson` / `readZstJson` 使用 `zlib.zstdCompressSync(..., { params: { [ZSTD_c_compressionLevel]: 15 } })` 读写 `filetree.zst`；检测到旧 `filetree.json` 时迁入 `filetree.zst` 后 `unlink` 旧文件。
- `hits.ts`：实现 `compactHits`（读取时若总行数 > 活跃条目数 × 1.2 + 20 即触发原子重写去重）、`exportActiveHits` 与 `mergeHits`（按 `id` 取 `at` 较大者，写入走临时文件 + `rename`）。

- [ ] **Step 5: 运行测试与 typecheck**

Run: `node --test tests/auxCache.test.mjs && npm run typecheck`
Expected: 测试全部 PASS，typecheck 0 错误。

- [ ] **Step 6: Commit**

```bash
git add electron/server/assistant/gfriends.ts electron/server/assistant/hits.ts tests/auxCache.test.mjs
git commit -m "feat(cache): compress gfriends index with zstd and add hits compaction/merge"
```

---

### Task 5: `.ffbak` 流式单文件备份容器与双格式兼容还原/合并

**Files:**
- Create: `electron/utils/ffbak.ts`
- Modify: `electron/server/index.ts:1665-2068`
- Modify: `electron/main/index.ts:242-274`
- Create: `tests/ffbak.test.mjs`

**Interfaces:**
- Produces (`ffbak.ts`):
  - `FFBAK_MAGIC = 'FFBK'`、`FFBAK_VERSION = 1`
  - `detectBackupFormat(filePath: string): Promise<'ffbak' | 'zip' | 'unknown'>`
  - `writeFfbak(targetPath: string, opts: { includePreviews: boolean; meta: FfbakMetaBundle; images: AsyncIterable<{ kind: 't' | 'p'; fmt: 1 | 2; sigHex: string; data: Buffer }> | Array<...> }): Promise<{ bytes: number; imageCount: number }>`
  - `readFfbakMetaAndVerify(filePath: string): Promise<{ version: number; includePreviews: boolean; meta: FfbakMetaBundle; imagesOffset: number; binCount: number }>`
  - `streamFfbakImages(filePath: string, imagesOffset: number, binCount: number, onImage: (entry: { kind: 't' | 'p'; fmt: number; sigHex: string; data: Buffer }) => Promise<void> | void): Promise<void>`

- [ ] **Step 1: 编写失败测试 `tests/ffbak.test.mjs`**

覆盖以下断言：
1. `writeFfbak` + `readFfbakMetaAndVerify` + `streamFfbakImages` 往返：验证元数据完整（`manifest`, `cacheEntries`, `disks`, `playlists`, `hits`）、图片字节与 `fmt` 逐字节完全一致（零二次压缩），且包头 4 字节为 `FFBK`、文本编辑器无法直接看到 JSON 明文。
2. 完整性与损坏校验（Review Focus #1）：截断文件末尾、破坏 `MetaChunk` 字节、破坏某张图片的 `DataCRC32`、破坏 `FEND` 标记——校验均在写库前立即抛出明确错误。
3. 轻量模式（`includePreviews: false`）vs 完整模式（`includePreviews: true`）：验证轻量模式不包含 `p-` 大图、包体显著减小。
4. 集成测试（`backupToFile` / `restoreFromFile` / `mergeCache` 逻辑函数）：
   - 导出时自动跳过未被引用的孤儿图片；
   - 还原与合并对 `playlists` 与 `hits` 均执行只增不删合并；
   - 读取真实构造的旧版 `.zip`（含 AES 加密 `bin/*.enc` 与 v2 `thumbData`）也能正常完成还原与合并（Review Focus #4）。

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test tests/ffbak.test.mjs`
Expected: FAIL（`ffbak.ts` 尚不存在）。

- [ ] **Step 3: 实现 `electron/utils/ffbak.ts`**

严格实现二进制帧格式：
- `Magic(4B "FFBK") | Version(2B uint16) | Flags(2B uint16) | HeaderMask(4B uint32) | MetaChunkLen(4B uint32) | MetaChunkCRC32(4B uint32) | MetaChunk(Zstd-19 + XOR mask) | BinCount(4B uint32) | [Kind(1B) | Fmt(1B) | Sig(20B) | DataLen(4B) | DataCRC32(4B) | Data]... | FooterMagic(4B "FEND")`
- 写入使用 `fs.createWriteStream(`${target}.tmp-${pid}-${Date.now().toString(36)}`)`，写完 flush 后原子 `rename` 到 `target`；失败自动清理 `.tmp`。
- `readFfbakMetaAndVerify` 在导入开始前通读校验头部、元数据 CRC32、扫描并校验所有图片帧长度/CRC32 以及末尾 `FEND` 魔数，**确保包体 100% 完整才允许动本地库**。

- [ ] **Step 4: 改造 `electron/server/index.ts` 与 `electron/main/index.ts`**

- `electron/main/index.ts`：`pickCacheSavePath` 默认文件名为 `file-finder-缓存-${YYYYMMDD}.ffbak`（过滤器 `['ffbak']`）；`pickCacheOpenPath` 过滤器允许 `['ffbak', 'zip']`。
- `electron/server/index.ts`：
  - `backupToFile` 支持可选 `{ path, includePreviews = true }`：收集 `cache_entries` + `playlists.json` 的活跃 `sig` 集合，跳过全部孤儿图，打包 `cacheEntries` + `disks` + `playlists` + `hits`（调用 `exportActiveHits`）+ 有效图片写入 `.ffbak`。
  - `restoreFromFile` 与 `mergeCache`：用 `detectBackupFormat(source)` 自动分流 `ffbak` 与历史 `zip`（复用现有 `zip.ts` 解析老 `.zip`），统一调用 `snapshotCacheTo(BEFORE_RESTORE_PATH)` 留快照并支持失败秒回滚；在 `restoreFromFile` 与 `mergeCache` 中同时对 `playlists`（`mergePlaylists`）和 `hits`（`mergeHits`）执行只增不删合并。

- [ ] **Step 5: 运行测试与 typecheck**

Run: `node --test tests/ffbak.test.mjs && npm run typecheck`
Expected: 测试全部 PASS，typecheck 0 错误。

- [ ] **Step 6: Commit**

```bash
git add electron/utils/ffbak.ts electron/server/index.ts electron/main/index.ts tests/ffbak.test.mjs
git commit -m "feat(backup): add .ffbak solid zstd backup format with legacy zip import support"
```

---

### Task 6: 服务端冗余存储盘点清理 + 设置页可视化预览 UI 与 `BackupPanel.vue` 适配

**Files:**
- Create: `electron/server/storageCleanup.ts`
- Modify: `electron/server/index.ts`（注册 `/storage/inventory`、`/storage/asset`、`/storage/purge`）
- Modify: `src/views/Settings/FrameCacheBlock.vue`
- Modify: `src/views/Settings/GeneralPanel.vue`
- Modify: `src/views/Cache/BackupPanel.vue`
- Create: `tests/storageCleanup.test.mjs`

**Interfaces:**
- Produces (`storageCleanup.ts`):
  - `inventoryRedundantStorage(dataDir: string): Promise<{ orphanBins: OrphanBinItem[]; coverBackups: BackupImageItem[]; leftovers: LeftoverFileItem[]; binTotal: { count: number; bytes: number }; blockedReason?: string }>`
  - `readCleanupAsset(dataDir: string, category: 'bin' | 'backup', key: string): Promise<{ buf: Buffer; contentType: string } | null>`（严格白名单防路径穿越）
  - `purgeRedundantStorage(dataDir: string, payload: { orphanBins?: string[]; coverBackups?: string[]; leftovers?: string[] }): Promise<{ removed: number; freed: number }>`

- [ ] **Step 1: 编写失败测试 `tests/storageCleanup.test.mjs`**

覆盖以下断言：
1. 安全闸门测试（Review Focus #2）：当 `cache.sqlite` 损坏或只有 0 条记录时，`inventoryRedundantStorage` 必须拒绝将 `bin.sqlite` 判为孤儿（返回 `orphanBins: []` 与 `blockedReason`）。
2. 1 小时保护窗测试：刚写入 `bin.sqlite`（`created_at` 在 1 小时内）且未被库引用的图片不能进 `orphanBins`；`created_at` 超过 1 小时且未被 `cache_entries` + `playlists.json` 引用的图片正确进入 `orphanBins`。
3. 旧封面备份与残留文件盘点：能扫描 `assistant/cover-backup/`、`backups/` 里的图片及 `searchCache.db.migrated.bak`、`searchCache-before-restore.db`、`cache-before-restore.sqlite`；传 `../` 越权路径被严格拒绝；执行 `purgeRedundantStorage` 后文件与行被清除，且 `bin.sqlite` 触发 `incremental_vacuum`。

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test tests/storageCleanup.test.mjs`
Expected: FAIL（`storageCleanup.ts` 尚不存在）。

- [ ] **Step 3: 实现 `electron/server/storageCleanup.ts` 并挂接路由**

- 在 `electron/server/index.ts` 注册：
  - `POST /storage/inventory`
  - `GET /storage/asset?cat=bin|backup&k=...`（给设置页网格预览孤儿图与旧封面备份图）
  - `POST /storage/purge`

- [ ] **Step 4: 更新 `src/views/Settings/FrameCacheBlock.vue`、`GeneralPanel.vue` 与 `BackupPanel.vue`**

- `FrameCacheBlock.vue` / `GeneralPanel.vue`：保持原有抽帧缓存功能不动，在下方/同卡片以清晰分组展示：
  1. **无引用图片仓（`bin` 孤儿图）**：网格预览缩略图 + 标明类型（缩略图 / 预览大图）与大小 + 勾选清除按钮（`清除选中 N 张（释放 X MB）`）。
  2. **旧封面与头像替换备份**：网格预览原图 + 文件夹提示 + 大小 + 勾选清除。
  3. **迁移与还原残留文件**：列表显示文件名与体积 + 勾选清理。
  - 严格遵守 `AGENTS.md`：所有颜色仅用 `var(--ff-*)` token，禁止 `#hex` / `rgba(...)`。
- `BackupPanel.vue`：
  - 在「备份到一个文件…」旁或弹窗/内联提供开关：`包含预览大图（完整备份）`（默认开启；关闭时导出轻量 `.ffbak` 并标注说明“仅含目录记录与缩略图，体积大幅缩小，盘在线时自动补大图”）；
  - 更新「从文件还原…」与说明文案兼容 `.ffbak` 与旧 `.zip`。

- [ ] **Step 5: 运行全量测试与 typecheck + 打包构建校验**

Run: `node --test tests/*.test.* && npm run typecheck && npm run build`
Expected: 所有单元测试 PASS，`vue-tsc --noEmit && tsc -p tsconfig.electron.json` PASS，`vite build && electron-builder` 无配置或打包错误（或用 `npx vite build` 校验 bundle 构建）。

- [ ] **Step 6: Commit**

```bash
git add electron/server/storageCleanup.ts electron/server/index.ts src/views/Settings/FrameCacheBlock.vue src/views/Settings/GeneralPanel.vue src/views/Cache/BackupPanel.vue tests/storageCleanup.test.mjs
git commit -m "feat(settings): add visual orphan/backup cleanup UI and lightweight ffbak export toggle"
```

---

## Self-Review Checklist (Executed)

1. **Spec coverage**：§4.1 → Task 2；§4.2 → Task 1 + Task 3；§4.3 → Task 4；§4.4 → Task 5；§4.5 → Task 2 + Task 3 + Task 5；§4.6 → Task 6。无遗漏。
2. **Type consistency**：各 Task 的 `Interfaces` 区块与消费方严格对齐（`nedb.ts` 保持原导出名，`binStore.ts` 兼容现有 URL key 并扩展批量与清理接口）。
3. **Review Focus**：全部 5 条高风险边界模式均已在对应 Task 的测试步骤中落盘断言。
