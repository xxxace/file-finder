# 备份 / 还原 完善实施记录（2026-10-05）

> 上游审计：`docs/AUDIT-BACKUP-RESTORE-2026-10-05.md`（那里记录的是**修之前**的状态）。
> 本文记录本次改动、验证与遗留。

---

## 一、改了什么（三目标一次到位）

| 目标 | 改动 | 文件 |
|---|---|---|
| **完整性** | ① 还原快照改「内存态序列化」（修 P1）② `disks.json` 进包/出包 ③ 包内加 `manifest.json` 校验 + 版本 | `nedb.ts` `index.ts` |
| **性能** | 快照纯内存（零磁盘读）；包内清单使"拿错文件"可**秒级拒收** | `nedb.ts` `index.ts` |
| **体积** | 库改「明文 JSON + raw-deflate」入包 | `zip.ts` `index.ts` |

### 逐项说明

**① 快照改内存态序列化（修 P1）**
- 新增 `exportSnapshotPlain()`（`nedb.ts`）：从**内存态**导明文，`exportCompactSnapshot()` 复用它写加密快照。
- `restoreFromFile` 不再 `copyFile(主库 → 快照)`，改调 `exportCompactSnapshot`。
- 判据（会不会复发）：任何增删改都不再影响快照正确性 —— 是修复不是补丁。

**② `disks.json` 进包**：`backupToFile` 加入包；`restoreFromFile` / `mergeCache` 用
`mergeRegistryMissing()` **只补缺、不覆盖**（本地 `firstSeenAt` 更可信）。

**③ `manifest.json`**：含 `format`（=1）/ `app` / `createdAt` / `cacheVersion` / 计数。
还原时若 `format > BACKUP_FORMAT` 明确报错（新包给旧程序读 → 不允许半懂不懂地读）。

**④ 体积**：`zip.ts` 扩成**逐条目可选 deflate**（`ZipSource.compress`）。
库/清单/disks 用 deflate，图片仍 store（加密 JPEG 压不动）。

---

## 二、实测收益（真库）

| 项 | 改前 | 改后 | 收益 |
|---|---|---|---|
| 库（进包） | 441.5 KB | **80.7 KB** | **省 81.7%** |
| 图片 | 72 MB | 72 MB | 0（熵已满，压不动 —— 实测不压是对的） |
| **整包估算** | ~72.4 MB | **~72.0 MB** | 库那份省下的全部体现在这里 |

> 单看库省 360 KB；因为图片占绝对多数，整包只小约 0.5%。
> 但**库是每次备份都要写的**，且将来记录变多时收益线性增长 —— 值得。

---

## 三、验证（三个探针 + typecheck）

| 探针 | 覆盖 | 结果 |
|---|---|---|
| `docs/probes/backup-restore-v2/verify.cjs` | zip 混合读写 / 加解密往返 / 新旧包兼容 / 体积 | **14 PASS / 0 FAIL** |
| `docs/probes/backup-restore-v2/e2e.cjs` | **用真实 `zip.ts` 编译产物**跑打包→解包 | **7 PASS / 0 FAIL** |
| `docs/probes/backup-restore-v2/real-data.cjs` | **真实主库**往返逐字一致 | **7 PASS / 0 FAIL** |
| `docs/probes/backup-restore-v2/order-guard.cjs` | **时序回归**（快照必须在闸门打开前） | **3 PASS / 0 FAIL** |
| typecheck | `tsc -p tsconfig.electron.json` | **0 error** |

---

## 四、⚠️ 过程中抓到的两个真 bug（探针的价值）

**bug 1：`listZip` 读错了 size 字段（会 100% 破坏 deflate 解包）**
中央目录偏移 `+20` 是**压缩后**大小、`+24` 是原始大小。我起初读 `+24` ⇒
store 条目两者相同（看不出问题），deflate 条目切多了字节 ⇒ inflate 报
`unexpected end of file`。**是 `e2e.cjs` 用真实源文件跑出来的**（复刻版探针发现不了）。
已修：`size` 取 `+20`，另存 `rawSize`。

**bug 2：快照调用顺序错了（会 100% 让还原失败）**
`beginRestore()` 打开闸门后，`assertUsable()` 会推所有读写 —— 而 `exportCompactSnapshot`
要读库 ⇒ 必须**先快照、后开闸**。我第一版写成 `beginRestore()` 在前 ⇒ 还原第一步必抛
"缓存库正在还原"。**是写 `order-guard.cjs` 时想到并验证的**。
已修：快照挪到 `beginRestore()` 之前，且失败时**不开始还原**（主库一字节未动）。

> 两个 bug 都**通不过一次真机还原**。若只看 typecheck 就交付，用户第一次用就会炸。
> 教训：**改动核心链路后，必须用真实源文件跑端到端往返**，复刻逻辑的探针会漏。

---

## 五、兼容性（旧包能读吗）

| 包类型 | 库在包里的形态 | 处理 |
|---|---|---|
| 旧包（2026-10-04 生成） | **密文原样** | `encryptPlainDb` 判首行不以 `{` 开头 ⇒ **原样写回**（不双重加密） |
| 新包（本次起） | **明文 JSON + deflate** | inflate → `encryptPlainDb` 逐行加密 |

判据落在**内容形态**（明文行必以 `{` 开头，base64 密文不会是）而非 manifest
—— 旧包压根没有 manifest。已实测（`verify.cjs` [C] 段 + `real-data.cjs`）。

---

## 六、遗留（需要主人动作）

1. **重启 dev 后真机目视**：备份 → 还原 → 合并 三条路径各跑一次。
   - 重点看：还原后记录数不变、封面图还在、还原失败时能回滚。
2. **未做**：快照/按天备份的清理策略（P3，非缺陷）；`/backup` 死接口可清理（见审计文档）。
3. ⚠️ **未实测**：真机上"还原失败自动回滚"这条路径（探针够不到 `wire()` 之下的部分）。
   逻辑上已正确（快照格式与主库逐字等价），但**未经真机故障注入验证**。
