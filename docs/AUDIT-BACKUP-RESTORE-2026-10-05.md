# 备份 / 还原 商业级验收审计（2026-10-05）

> ✅ **本文的两个缺口已于同日修复**：见 `docs/IMPLEMENT-BACKUP-RESTORE-V2-2026-10-05.md`。
> - P1（快照可能不含全部记录）→ 已修为"内存态序列化"。
> - P2（`disks.json` 不进包）→ 已进包。
> 本文保留为**修复前的诊断记录**（证据链有价值），**不代表当前状态**。

> 结论先行：**主线可用，但不能宣称"商业级可靠"**。
> 存在 **1 个 P1 真实缺陷**（快照可能不含全部记录）+ **1 个 P2 缺口**（disks.json 不进包）+ **1 个 P3 观察项**（快照/按天备份无清理）。
> 所有结论均附证据等级。本机实测部分已跑过探针。

---

## 一、链路全景（代码坐标）

| 动作 | 入口 | 服务端 | 关键文件 |
|---|---|---|---|
| 备份到文件 | `HistoryTable:964` `handleBackupToFile` | `index.ts:1445` `backupToFile` | 打包 `searchCache.db` + `bin/*.enc` |
| 从文件还原 | `HistoryTable:991` | `index.ts:1503` `restoreFromFile` | 覆盖主库 + 回滚 |
| 合并缓存 | `HistoryTable:1036` | `index.ts:1573` `mergeCache` | 取 create_at 新的 |
| 打开数据目录 | `HistoryTable:940` | `main/index.ts:211` | `shell.openPath` |

**导出包结构**（`index.ts:1453`）：
```
searchCache.db            条目信息（密文逐行）
bin/t-<sig>.enc           缩略图
bin/p-<sig>.enc           预览大图
```

---

## 二、P1 缺陷：还原快照可能不是"完整快照"（证据等级：静态 + 本机实测）

### 事实（nedb 源码坐实，`node_modules/@seald-io/nedb/lib/persistence.js`）

- **写路径 = 只追加**：`persistNewStateAsync` → `storage.appendFileAsync`（`:163`）。
  删除也是追加一条 `$$deleted` 标记，**旧行不消失**。
- **压缩路径**：`persistCachedDatabaseAsync`（`:92`）只在 `loadDatabase`（`:339`）或显式 `compactDatafile` 时执行。

### 推论

`restoreFromFile` 的快照是：
```ts
await fsasync.copyFile(CACHE_DB_PATH, BEFORE_RESTORE_PATH);   // index.ts:1527
```
它拷的是**磁盘文件**。而磁盘文件在"本次进程启动后发生过增删改"时，**含历史追加行**。

### 后果

| 场景 | 快照内容 | 回滚结果 |
|---|---|---|
| 进程启动后**没**做过增删改（磁盘刚好是紧凑态） | = 内存态 | ✅ 正确回滚 |
| 进程启动后**做过删除**（如浏览了别的目录触发 remove+insert） | 含被删记录的旧行 | ⚠️ **已删记录在回滚后复活** |
| 快照那一刻主库正被追加写（批量扫描中） | 可能截到半行 | ⚠️ 回滚出一份损坏库 |

### 本机实测（探针 `/tmp/probe-final.mjs`）

```
文件                            总行  索引  数据行  唯一id  膨胀行
searchCache.db                  223   1     222     222     0
searchCache-before-restore.db   2     2     0       0       0   ← 快照为零记录！
searchCache-20261005.db         224   2     222     222     0
```

**两条硬证据**：
1. `before-restore.db` **数据行为 0** —— 它是一次还原留下的快照，却**一条记录都没有**。
   说明当时主库磁盘文件里只有索引行？不——更可能是 `copyFile` 发生在**主库刚被整体重写、只写了索引行**的瞬间。
   **无论哪种解释，结论一致：这份"安全快照"救不了人。**
2. 当前主库"膨胀行 = 0" 是**巧合**（刚 load 过、之后没删过东西）。一旦删过，膨胀行立刻 > 0。

### 修法（正确的方式，非补丁）

快照**不该拷磁盘文件**，而该**从内存态重新序列化一份**——内存才是真相源（`nedb.ts:1494` 注释已明说）。

```ts
// nedb.ts 新增：把内存态导成一份"紧凑库"写到指定路径
export async function snapshotTo(path: string): Promise<void> {
    const lines: string[] = [];
    const docs = await new Promise<SearchCache[]>((res, rej) =>
        nedb.find({}, (e, d) => (e ? rej(e) : res(d))));
    for (const doc of docs) lines.push(encryptLine(JSON.stringify(doc)));
    await fsasync.writeFile(path, lines.join('\n') + '\n', 'utf8');
}
```
`restoreFromFile` 里把 `copyFile(CACHE_DB_PATH, BEFORE_RESTORE_PATH)` 换成 `snapshotTo(BEFORE_RESTORE_PATH)`。
判据=「同类场景会不会复发」：将来任何增删改都不再影响快照正确性 ⇒ 是修复不是补丁。

> ⚠️ **此项需要主人批准后实施**（动的是还原链核心）。

---

## 三、P2 缺口：`disks.json` 不进包（证据等级：静态 + 本机实测）

- 盘注册表 `~/.file-finder/disks.json`（`driveIdentity.ts:180`）**不在备份包的 entries 里**（`index.ts:1453` 只有 db + bin）。
- 本机实测该文件：**7 条记录，`label` 全为空串**。
- `syncRegistry`（`driveIdentity.ts:216`）里 label 硬编码 `''`，**全项目无写入 label 的入口**。
- ⇒ 现在丢失影响 ≈ 0，但**是"结构缺口"**：一旦开放"给盘命名"，备份立刻变不完整。

### 修法
`backupToFile` 的 entries 加一条 `disks.json`；`restoreFromFile` / `mergeCache` 各加一次"解包后写回"。
成本 ~6 行，但要碰两条链 ⇒ 同样需主人批准。

---

## 四、P3 观察项：快照 / 按天备份无清理（证据等级：本机实测）

- `before-restore.db` 每次还原覆盖同一路径 ⇒ **不累积**（✅ 好）。
- `cacheBackup()` → `searchCache-YYYYMMDD.db` 按天一份 ⇒ **会累积**（本机已有 2 份）。
- 但 `cacheBackup()` **唯一调用点是 `/backup`**（`index.ts:1416`），而该接口**前端没有调用者**
  （`HistoryTable` 走的是 `backupToFile`）⇒ 按天备份实际上是**从不执行的死接口**。
- 判定：**不是缺陷**，是可清理的历史遗留。建议记入"该删清单"。

---

## 五、做得对的地方（不动的理由）

| 设计 | 位置 | 评价 |
|---|---|---|
| bin 未就绪**拒绝打包** | `index.ts:1450` | ✅ 宁可不导也不导"静默无图"包 |
| 还原失败**尽力回滚** | `index.ts:1534-1542` | ✅ 且区分"覆盖是否已开始" |
| `restoring` 闸门挡所有读写 | `nedb.ts:189` | ✅ 责任在唯一 DB 模块内 |
| 外库**先复制再读** | `nedb.ts:390` | ✅ 只读介质也能用 |
| 图片**只增不删**并入 | `index.ts:1470` | ✅ 不覆盖本地更新的那份 |
| zip **store-only** | `zip.ts:6` | ✅ 内容已压不动，白烧 CPU 没意义 |
| 合并走**同一写入链** | `index.ts:1620` | ✅ 不与后台扫描撞车 |

---

## 六、验收结论

| 维度 | 判定 |
|---|---|
| 备份包内容完整性（库+图） | ✅ 成立 |
| 还原主线可用性 | ✅ 成立（正常路径能还原） |
| **还原失败时的回滚可靠性** | ❌ **不成立**（P1：快照可能缺失/含脏数据） |
| 跨机迁移完整性 | ⚠️ 基本成立（disks.json 缺口 P2，当前无害） |
| 静默丢数据风险 | ⚠️ 有（P1 的"删后回滚复活"形态） |

**一句话**：正常用没问题；**但"还原失败自动回滚"这条安全网有一个洞**，商业级场景（客户误操作后要求回滚）会暴露它。**修 P1 即可达到可交付标准。**

---

## 附：复现步骤（供主人自查）

```bash
# 1. 看快照是否为空
node /tmp/probe-final.mjs      # 已跑，见 §二表格

# 2. 造成膨胀行复现（需在 dev 里操作）
#    浏览一个已缓存目录 → 触发 removeCache+insertCache → 磁盘立即膨胀
#    此时再执行还原并故意失败 → 回滚后检查记录数
```
