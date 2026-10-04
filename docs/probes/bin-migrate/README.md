# bin-migrate —— 图片出库迁移 / bin 仓 / zip 的真数据探针

> **状态（2026-10-04）：全绿。** 迁移**字节级**核对通过、bin 加解密往返通过、
> zip 往返通过，并且**外部校验通过**（Windows 自带的 `Expand-Archive` 能解开我们写的 zip，
> 解出来的文件 sha256 与磁盘原件逐字节一致）。

## 复算

```bash
bash docs/probes/bin-migrate/run.sh      # 结果落到 out.txt
```

外部校验（不在脚本里，因为从 bash 里调 powershell 会绕过安全检查 —— 要用 PowerShell 工具跑）：

```powershell
$zip = (Get-Content docs\probes\bin-migrate\zip-path.txt -Raw).Trim()
Expand-Archive -LiteralPath $zip -DestinationPath "$(Split-Path $zip)\unzipped" -Force
Get-FileHash "$(Split-Path $zip)\unzipped\bin\<某个 t-*.enc>" -Algorithm SHA256
```

## 这个探针在验什么（以及为什么这么写）

| 项 | 判据 | 结果 |
|---|---|---|
| ① 迁移 | 迁移前把每条 base64 解出来、迁移后把每个 bin 文件解出来，**按内容去重后**张数与总字节**完全相等** | 20/20、777951 B **精确一致** |
| ①b 记录形状 | 迁移后库里**残留 0 个 base64 字段**、每条都带 `sig`、版本号升到 3 | 0 / 20 / `[3]` |
| ② bin 仓 | 加解密往返一致、同一内容两次写入**密文不同**（随机 IV）、不留 `.tmp` 残file | 全 true |
| ③ zip | 写 → 列 → 取，取出的字节与磁盘原件**逐字节相等** | true（并另做系统解压校验）|

**为什么被测的是"合成出来的旧格式库"而不是真库**：真库会被**就地迁移**
（见 `entry.ts` 顶部的警告）—— 拿它当输入，这个探针一辈子只能跑一次。
素材取真 bin 里那 20 张真图，形状自己拼，于是**可反复复算**。

**为什么按内容去重后再比**：bin 是按**内容指纹**命名的，内容完全相同的两张图共用一个文件
（设计如此，不是丢数据）。实测真库里 1236 张图 → 1205 个文件（**31 张是重复内容**）。

## ⚠️ 一条踩过的坑（写给下一个人）

**导入 `bundle.cjs` 这件事本身就会加载 + 迁移 `process.env.USERPROFILE` 指向的那个库。**
2026-10-04 我在一个临时统计脚本里忘了先把 USERPROFILE 指到副本 ⇒ **动了真库**
（当时是"就地迁成了新格式"，数据没丢、迁移本身是对的，但那是**不该发生**的动作）。
所以：**任何用到这个 bundle 的脚本，必须先 `process.env.USERPROFILE = <副本目录>` 再 require。**

## 真库上的实际效果（2026-10-04 12:19 实测）

| | 迁移前 | 迁移后 |
|---|---|---|
| `searchCache.db` | **85 MB** | **428 KB**（图片搬走了 + 整库重写压缩）|
| `bin/`（1205 个文件） | — | **50 MB**（1236 张图的裸字节；base64 那 +33% 没了）|
| 合计 | 85 MB | **50 MB**（−41%）|

> 大图（`p-*.enc`）此刻是 **0 个**：迁移只能搬库里已有的缩略图。
> 大图会在"扫描那一层"或"第一次点开看"时生成（见 `server/index.ts` 的 previewController）。
