# 存储、缓存数据库与导入导出全面瘦身设计方案

> 日期：2026-11-26
> 目标：在**不降低大图清晰度、不拖慢扫盘/浏览速度、显著降低常驻内存占用、彻底消除边界缺陷与竞态**的前提下，把本地缓存与导出备份体积压到最小，并补齐设置页对孤儿图与冗余备份的可视化预览清理。

---

## 1. 背景与现状诊断

基于当前代码与真实 `~/.file-finder`（约 263 MB，不含导出包）盘点，核心瓶颈与冗余如下：

| 模块 | 当前实现 | 实测占用 | 核心问题 |
|---|---|---|---|
| 图片仓 `bin/` | 4,408 个独立 `.enc` 文件（JPEG + 每文件随机 16B IV + AES-256-CBC） | **255.49 MB**（占总空间 97.5%） | ① **1,512 张 / 61.56 MB 孤儿死图**无人清理且导出会全部打包；② JPEG + `verbatim` 原样图膨胀；③ Windows NTFS 数千小文件造成 ~8–10 MB 簇碎片与启动/加载耗时；④ 每文件 AES 加解密耗 CPU |
| 缓存库 `searchCache.db` | `@seald-io/nedb`（NDJSON + AES-CBC + Base64 + append-only） | **666.8 KB**（明文 497.9 KB） | ① **整库常驻 V8 内存**，随条目增长线性爆内存；② Base64 膨胀 +33.3%；③ 更新/删除产生死行不自动回收；④ 条目重复存 `dir`、`isDirectory`、40 字符 hex `sig` |
| 导出备份包 `.zip` | 自写 `zip.ts`（图片 `store`、库明文 `deflateRaw`） | **~78–255 MB** | ① 打包全部孤儿图；② `store` 无固实压缩，4,400+ 文件头占 ~500 KB；③ 不支持增量/轻量导出 |
| 辅助缓存与备份 | `gfriends/filetree.json`、旧 `assistant/cover-backup/`、`backups/`、`frames/`、`searchCache-before-restore.db` | **~7.1 MB** | ① `filetree.json`（1.87 MB）未压缩；② 旧封面/头像备份图无 UI 预览与清理入口 |

---

## 2. 设计原则与硬约束

1. **零画质二次损失（导出/导入铁律）**：导出与导入过程对图片**绝对不做有损重编码**，保证“导出前清晰，导出后完全一致”。
2. **速度只快不慢，不卡主进程**：放弃会阻塞主进程同步缩放的 `nativeImage` 链路与逐张拉起 `ffmpeg.exe` 子进程的做法，引入 `sharp`（预编译 libvips，运行于异步线程池）并发处理静态图；WebP 编码质量选型兼顾体积与极速（`t-` q78、`p-` q86）。
3. **内存最小化（为后续扩展存储信息功能让路）**：缓存库查询、列表展示、按盘汇总、目录大小聚合全部走 SQL 索引与元数据列，**绝不把全库条目列表常驻 JS 堆**。
4. **“防直视”替代高成本强加密**：本地与导出包去掉 AES-256-CBC 与 Base64 膨胀；二进制文件本身（SQLite / Zstd / 轻量魔数 XOR 混淆）已无法被记事本或资源管理器直接看穿。
5. **100% 自动无损迁移与向后兼容**：老用户升级首次启动时自动把 `searchCache.db`、`bin/*.enc`、`gfriends/filetree.json` 迁入新格式，**绝不触发重扫移动硬盘**；导入接口继续兼容老 `.zip` 备份包。

---

## 3. 总体架构与方案对比决策

经对比三套路径（零新依赖保守方案 vs `sharp + bin.sqlite` 极致用户体验方案 vs 仅清理微调），选定 **方案二（`node:sqlite` + Zstd + `sharp` WebP + `bin.sqlite` + `.ffbak` 固实包）** 作为最终设计：
- 仅新增 1 个生产依赖 `sharp`（需在 `electron-builder.json5` 配置 `asarUnpack`）；
- 数据库完全复用 **Node 24（Electron 44）原生内置 `node:sqlite`** 与 **`node:zlib`（原生 Zstd/Brotli）**，零 SQLite 编译依赖。

---

## 4. 分模块详细设计

### 4.1 缓存库：`@seald-io/nedb` → `cache.sqlite`（`node:sqlite` + 字段精简 + Zstd）

文件位置：`~/.file-finder/cache.sqlite`（启用 `PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA auto_vacuum = INCREMENTAL;`）。

#### 表结构
```sql
CREATE TABLE IF NOT EXISTS cache_entries (
    serial          TEXT NOT NULL,
    rel_path        TEXT NOT NULL,
    rel_path_lower  TEXT NOT NULL,
    mode            TEXT NOT NULL,     -- 'cover' | 'folder'
    v               INTEGER NOT NULL,
    count           INTEGER NOT NULL,
    bytes           INTEGER NOT NULL,  -- data[].size 预先求好，查元数据/目录树大小无需解压 data
    create_at       TEXT NOT NULL,
    dir_mtime       INTEGER,           -- nullable
    data_zstd       BLOB NOT NULL,     -- 精简 JSON 的 zstd 压缩字节
    PRIMARY KEY (serial, rel_path_lower, mode)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_cache_serial_mode ON cache_entries(serial, mode, rel_path_lower);
```
> 注：沿用 Windows 大小写不敏感契约，`PRIMARY KEY` 锚定在 `(serial, rel_path_lower, mode)`，而 `rel_path` 保留真实大小写供下发展示与准确锚点拼接；`INSERT OR REPLACE` 原子替换同主键记录，天然覆盖大小写更名旧行，消除原先 `removeCache + insertCache` 之间的空窗与历史死行问题。

#### `data_zstd` 紧凑载荷格式（无损精简）
序列化前对 `FileInfo[]` 做无损瘦身（读出解压后还原为标准 `FileInfo[]`，外部调用方接口零感知变化）：
- 省略冗余字段：`isDirectory`（由 `type === 'folder'` 还原，当 `type === 'folder'` 即为 `true`）；
- 省略与父目录 `doc.relPath` 完全一致的 `dir`（仅当 `item.dir !== doc.relPath` 时才存，例如收敛封面条目 `dir` 指向子目录；还原时缺省即回填 `doc.relPath`）；
- 短键名与紧凑元组或短 key 对象（例如 `d/n/e/t/s/f/g/m/b`），配合 `zlib.zstdCompressSync(..., { params: { [ZSTD_c_compressionLevel]: 9 } })`（单条写入毫秒级，实测全库 498 KB 明文可压至 ~85–100 KB）。
- `sig` 保持 40 位 hex 字符串（因每条目录内部与 Zstd 压缩后占字节极少，且易于跨版本演进与排查）。

#### 内存与查询行为
- `loadMeta({ withBytes, sortBy, dir })`：**只查询轻量列**（`serial, rel_path, mode, v, count, bytes, create_at, dir_mtime`），**绝不读取与解压 `data_zstd`**。无论以后缓存膨胀到上万个目录，常驻/查询内存保持在亚 MB 级。
- `findCache(serial, relPath, mode)`：按索引查单行，仅解压该行 `data_zstd` 返回（仍校对 `v === CACHE_VERSION`）。
- `findSubtreeLeafItems(serial, baseRel, mode)`：SQL 仅拉取 `serial = ? AND mode = ? AND (rel_path_lower = ? OR rel_path_lower LIKE ? ESCAPE '\' ...)` 的子集行并逐行流式解压合并；`findAllCachedCovers` 同样按需流式逐行扫描解压，**不一次性持有全库明文对象**。
- `_id` 兼容：前端表格行键（`Cache/index.vue` 与 `removeHistoryBatch`）目前使用 `m._id`。迁移期间及新库直接用合成稳定键 `${serial}\0${rel_path_lower}\0${mode}`（或 Base64url 编码）作为 `_id` 下发，`removeHistoryBatch` 按主键直接删除，彻底告别无意义随机 `_id`。

---

### 4.2 图片仓：`bin/*.enc` → `bin.sqlite` + `sharp` WebP 管线

文件位置：`~/.file-finder/bin.sqlite`（启用 `PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA auto_vacuum = INCREMENTAL;`）。

#### 表结构
```sql
CREATE TABLE IF NOT EXISTS bins (
    kind       TEXT NOT NULL,      -- 't' | 'p'
    sig        BLOB NOT NULL,      -- 20 字节 raw SHA-1（比 40 字符 hex 省一半）
    fmt        INTEGER NOT NULL,   -- 1 = jpeg, 2 = webp
    size       INTEGER NOT NULL,   -- data 字节长度（便于 SUM(size) 零扫描数据页）
    created_at INTEGER NOT NULL,   -- unix ms（用于清理保护窗判断）
    data       BLOB NOT NULL,      -- 纯净图像字节（或轻量混淆）
    PRIMARY KEY (kind, sig)
) WITHOUT ROWID;
```
> **设计要点**：
> 1. **防直视与零膨胀**：由于图片本身已收进二进制 `bin.sqlite` 的 BLOB 列，不再对每张图片做 AES-256-CBC + 16B IV + PKCS7 填充，用户无法用系统资源管理器或看图软件直接浏览，同时**每张图省去 16~31 字节头尾开销与解密 CPU**，且消除了 4,400+ 小文件在 NTFS 上约 8–10 MB 的簇碎片。
> 2. **URL 与下游零破坏**：对外下发的 key 名与接口契约保持不变（`t-<40hex>.enc` / `p-<40hex>.enc`）。`hasBin(name)` 查内存轻量索引集合（启动时只执行 `SELECT kind, sig FROM bins`，4,400 条 20B key 在内存中仅占 ~250 KB）；`getBin(name)` 直接同步主键点查 `SELECT fmt, data FROM bins WHERE kind = ? AND sig = ?` 返回 `{ buf, contentType }`，`/thumb` 与 `/preview` 据 `fmt`（或字节头魔数嗅探兜底）返回 `image/webp` 或 `image/jpeg`。
> 3. **批量事务落盘**：`flushRenditions()` 时通过 `putBinsBatch()` 将本次扫描产出的多张 `t-` / `p-` 图片包进**单次 SQLite `BEGIN ... COMMIT` 事务**落盘，避免逐张刷盘 I/O 瓶颈。
> 4. **空间即时归还**：清理孤儿图 `DELETE` 后立刻执行 `PRAGMA incremental_vacuum;`（耗时毫秒级），把空闲页实时归还操作系统。

#### `sharp` 高速编码管线（[thumbnail.ts](file:///d:/code/file-finder/electron/utils/thumbnail.ts)）
- **静态图片（`imageRenditions`）**：
  - 一次 `fsasync.readFile` 后直接喂给 `sharp(buf, { failOn: 'none' })`（避免损坏 EXIF 报错丢图），并调用 `.rotate()` 自动按 EXIF Orientation 纠正方向（对齐原有 `nativeImage` 体验）。
  - `thumb`（384px）：`resize({ width: 384, withoutEnlargement: true }).webp({ quality: 78, effort: 4 })`。
  - `preview`（2048px）：
    - `resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true })`
    - 输出 `.webp({ quality: 86, effort: 4 })`（剥离冗余 EXIF/XMP/ICC 元数据；若原图本身就是合法 JPEG/WebP 且长边 ≤ 2048、体积 ≤ `PREVIEW_VERBATIM_MAX` 且转换后 WebP 字节反而 ≥ 原图字节，则**保留原字节**，绝不“越压越大”！）。
  - **兜底链路**：若源格式为 `sharp` 无法直接解码的特殊格式（如老式 `.psd` / 损坏流），**保留现有 `ffmpeg` `transcodeImage` 兜底转 PNG 再交给同一条 `sharp` 缩放管线**，兼容范围不降反升。
- **视频抽帧（`videoRenditions` & `frameJpegAt`）**：
  - `extractFrame` 仍走可控超时的 `ffprobe + ffmpeg` 抽帧，抽出的临时帧交给 `imageRenditions`（即 `sharp` 出双尺寸 WebP）；补封面用的 `frameJpegAt` 仍按盘上需要写 `.jpg`（或传给 `apply.ts` 转 JPEG 写盘，不破坏“移动盘内封面文件保持 `cover.jpg`”的既有约束）。
- **打包解包配置**：[electron-builder.json5](file:///d:/code/file-finder/electron-builder.json5) `asarUnpack` 增加 `"node_modules/sharp/**"` 与 `"node_modules/@img/**"`。

---

### 4.3 辅助缓存文件瘦身

- **`gfriends/filetree.json` → `gfriends/filetree.zst`**：
  - [gfriends.ts](file:///d:/code/file-finder/electron/server/assistant/gfriends.ts) 下载扁平化后使用 `zlib.zstdCompressSync` level 15 写为 `filetree.zst`（实测 **1.87 MB → ~259 KB**），读取时按需解压，**不在模块级常驻内存**；首次检测到旧 `filetree.json` 时自动转存为 `.zst` 并删除旧 `.json`。
- **`assistant-hits.jsonl`**：
  - 每次写入保持追加安全，启动时或触发压缩时（若文件含墓碑行或重复 id 超 20%）自动后台重写去重快照（先写 `.tmp` 再 `rename` 原子替换）。
- **`playlists.json` / `disks.json`**：
  - 本地保持紧凑 JSON（或去多余缩进），体积本身仅数 KB；导出时统一打入 `.ffbak` 的 Zstd 固实元数据区。

---

### 4.4 导入导出单文件格式 `.ffbak`（流式读写 + 固实压缩 + 零二次掉画质）

用户已明确**不要求资源管理器双击打开**，因此放弃低效且受限于条目的 `.zip`，设计专用单文件格式 **`.ffbak`**（FileFinder Backup）：

#### 二进制帧结构（支持流式读写，零内存峰值）
```
[Magic: 4B "FFBK"]
[Version: 2B uint16 LE = 1]
[Flags: 2B uint16 LE]           -- bit0: 包含 p- 大图 (1=完整包, 0=轻量包)
[HeaderMask: 4B uint32 LE]      -- 轻量伪随机 XOR 掩码种子（用于对正文头部做简单防直视混淆，0 开销）
[MetaChunkLen: 4B uint32 LE]    -- 元数据区块压缩后字节数
[MetaChunkCRC32: 4B uint32 LE]
[MetaChunk: Zstd-19(JSON/NDJSON Bundle)]
   ├─ manifest: { format, app, createdAt, cacheVersion, dbEntries, images, includePreviews, playlists, hasHits }
   ├─ cacheEntries: 全部活记录（含精简 JSON 与 stats，统一被整块 Zstd-19 固实压缩，消除重复键）
   ├─ disks: disks.json 内容
   ├─ playlists: playlists.json 内容（若存在）
   └─ hits: assistant-hits.jsonl 去重后活跃命中（若存在）
[BinCount: 4B uint32 LE]
Repeated BinCount times:
   [Kind: 1B (1='t', 2='p')]
   [Fmt:  1B (1='jpeg', 2='webp')]
   [Sig:  20B raw SHA-1]
   [DataLen: 4B uint32 LE]
   [DataCRC32: 4B uint32 LE]
   [Data: raw image bytes]      -- 零二次编码，原字节进出！仅写入当前 cache+playlists 有效引用的 sig
[FooterMagic: 4B "FEND"]
```

> **核心优势与边界保障**：
> 1. **自动排除全部孤儿图**：打包时只收集 `cache_entries` + `playlists.json` 中实际出现的 `sig` 集合再去 `bin.sqlite` 取图，当前 **61.56 MB 死图直接剔除**。
> 2. **完整模式 vs 轻量模式**：导出面板提供切换（默认完整包；勾选“仅含目录记录与缩略图（轻量包）”可跳过全部 `p-` 大图，包体再缩减约 **70–80%**，未来盘在线点开大图时会自动懒生成补齐）。
> 3. **无内存爆炸与强校验**：导出通过 `fs.createWriteStream` 流式逐张写出图片块；导入时先校验 `Magic`、`Version`、每个块与每张图的 `CRC32` 以及结尾 `FEND` 标记——**任何截断、损坏的文件在动主库之前立即报错中止**。
> 4. **全量向后兼容导入与一致的合并语义**：
>    - 读取文件前 4 字节魔数自动分流：`FFBK` → 新 `.ffbak` 解析器；`PK\x03\x04` → 原有 `zip.ts` 解析器（支持导入历史 `.zip` 备份，含旧版 v2 base64 库与密文 `bin/*.enc` 自动解码转入新库，**老备份永不作废**）。
>    - **还原（`restoreFromFile`）与合并（`mergeCache`）的附属数据语义统一**：
>      - `cache_entries`：还原 = 整份替换；合并 = 按主键 `(serial, rel_path_lower, mode)` 取 `create_at` 较新者。
>      - `bin` 图片仓：两者均**只增不删**并入缺失 `sig`。
>      - `disks.json`：两者均**只补缺**本地没有的盘。
>      - `playlists.json`：两者均**只增不删按夹与条目标识合并**（补齐原 `mergeCache` 未实现收藏夹合并的空缺）。
>      - `assistant-hits.jsonl`：两者均按番号 `id` **只增不删合并**（同番号取时间戳 `at` 较新且非墓碑的记录，绝不丢弃本机已刮削成果）。
> 5. **还原前自动快照与回滚**：`restoreFromFile` 执行前调用 `cache.sqlite` 的在线备份机制（`VACUUM INTO` 或 `node:sqlite` `backup()`）写入独立槽位 `cache-before-restore.sqlite`，失败秒回滚；还原成功后可在设置页清理面板展示并一键删除。

---

### 4.5 自动无损迁移与零画质下降铁律

1. **首次启动渐进无损迁移（零重扫盘、零阻塞启动、可中断恢复）**：
   - **[技术拍板] 启动期不阻塞 `app.listen(3060)`**：
     - `searchCache.db`（体量小，毫秒级）在 `app.listen(3060)` 前完成向 `cache.sqlite.migrating` 的事务写入，校验行数一致后原子 `rename` 为 `cache.sqlite`，并将旧库重命名为 `searchCache.db.migrated.bak`。
     - `bin/*.enc`（可能达数百 MB / 数千文件）**绝不在 `listen()` 前同步搬完**，以免前端首屏请求撞上 `ERR_CONNECTION_REFUSED`：
       - `binStore` 启动时立即打开 `bin.sqlite` 载入已迁索引，同时对遗留 `bin/*.enc` 做一次轻量 `readdir` 记入内存待迁集合，`app.listen(3060)` **立即放行**。
       - 运行期**双源透明读取**：`hasBin` 判 `sqliteKeys ∪ pendingLegacyEnc`；`getBin` 优先查 `bin.sqlite`，若命中 `pendingLegacyEnc` 则无缝回落读盘解密 `.enc`（并在内部顺带写入库或由后台迁移写入）。
       - 后台分片迁移器按 **80 张/批** 走异步调度 + 单事务批量写入 `bin.sqlite`（保留原 JPEG 字节与原 `fmt=1`），每批之间让出事件循环，不抢占用户交互与 HTTP 请求；每批校验落库成功后再删除对应 `.enc`（全部迁完后移除空 `bin/`）。
   - 若存在 `gfriends/filetree.json`：异步转存为 `filetree.zst` 后删去旧 `.json`。
2. **存量旧图零重编码（用户明确拍板）**：
   - 所有已存于本地的旧版 JPEG 缩略图与预览大图**一律原样无损迁入 `bin.sqlite`**，**不提供也不执行**任何存量旧图二次有损转 WebP 任务，100% 杜绝已存封面出现任何画质下降；仅今后新扫描与新生成的封面直接从源文件单次编码为高画质 WebP（`t-` q78、`p-` q86）。

---

### 4.6 设置页统一存储清理与孤儿预览（扩展 [FrameCacheBlock.vue](file:///d:/code/file-finder/src/views/Settings/FrameCacheBlock.vue)）

在设置 → 通用中，将原「抽帧缓存」区块升级/扩展为统一的**缓存与冗余清理**面板（保留原有抽帧缓存全部逻辑，并新增另外三类可预览清理项，**全部支持先预览再勾选删除**，严格只用 `var(--ff-*)` token）：

1. **抽帧缓存（`frames/`）**：保持现有功能不变（盘点、用实时清单核实、网格看图勾选删除）。
2. **无引用缓存图片（`bin.sqlite` 孤儿 `t-` / `p-`）**：
   - **安全铁律（防误删）**：仅当 `cache.sqlite` 正常打开且记录数 > 0 时才允许计算孤儿；汇总 `cache_entries`（所有 `v` 版本，含未迁移版本）+ `playlists.json` 全部 `sig`，集合外的图片才列为孤儿，且**排除近 1 小时内新写入（`created_at` 保护窗）与正在进行的扫描/合并任务**。
   - 展示：**优先展示 `t-` 缩略图**（若某 `sig` 只有孤儿 `p-` 大图则直接用 `/preview` 缩略显示），网格中标明类型（缩略图/大图）、体积、创建时间，支持全选/反选与「清除选中 N 张（释放 X MB）」，删完立刻 `PRAGMA incremental_vacuum;`。
3. **旧封面/头像替换备份（`assistant/cover-backup/` & `backups/`）**：
   - 扫描本地磁盘备份图，展示真实缩略图预览 + 所属目录名尾巴 + 时间 + 体积，勾选清除。
4. **旧版迁移与还原残留文件**：
   - 自动扫描 `searchCache.db.migrated.bak`、`searchCache-before-restore.db` / `cache-before-restore.sqlite`、旧 `bin/` 残留目录等，展示文件名与体积，支持勾选一键清理。

---

## 5. 并发、边界与故障恢复清单

- **并发写锁**：
  - `cache.sqlite` 继续经由全局唯一的 `queueCacheWrite(serial, relPath, mode, task)` 串行写入同主键；SQLite 开启 `busy_timeout = 5000`。
  - `bin.sqlite` 写操作通过单线程异步批量微队列汇入单事务，读取（`/thumb`、`/preview`）完全并发无阻塞。
- **中断恢复**：
  - 导出 `.ffbak` 先写 `${target}.tmp-${pid}`，全部写完并 flush 后再 `rename` 到 `target`；失败自动删 `.tmp`。
  - 启动迁移先写入 `.migrating.sqlite` 临时库，事务提交并校验行数一致后再原子 `rename` 成正式库，**任何阶段断电/崩溃不会破坏原有 `searchCache.db` 与 `bin/`**。
- **损坏兜底**：
  - `cache.sqlite` 若因异常损坏导致无法打开，响亮报错阻断写入（沿用现有 `assertUsable()` 闸门哲学），绝不把空库当成正常库去误判 `bin.sqlite` 全是孤儿。
  - `bin.sqlite` 单条损坏不影响列表功能（返回 404/占位并记日志），`hasBin` 与实际读取保持一致。
- **渲染层契约**：
  - `BackupPanel.vue` 更新文件选择器过滤器为 `['ffbak', 'zip']`（导出默认 `.ffbak`，导入支持 `.ffbak` 与 `.zip`），并新增「含预览大图（完整备份）/ 仅缩略图（轻量备份）」选项及导出体积提示。
