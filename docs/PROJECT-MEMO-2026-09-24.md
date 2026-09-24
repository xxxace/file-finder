# file-finder 项目长期备忘

> 详细取证都在 `docs/`。这里只放**决定**和**别忘的坑**。
>
> ⚠️ **本文是「全文版」**（2026-09-24 从 `.workbuddy/memory/MEMORY.md` 整体搬过来 ——
> 那份文件已 19.4 KB，每次会话注入时会被截断，导致后半段（§九、§十）看不见）。
> `MEMORY.md` 现在只留**索引 + 铁律 + 未完成**，细节一律查这里。

## 一、特性清单（用户声明的"小便捷" —— 默认不碰）
**只有我判断某条确实有问题时才提交讨论，讨论通过才能改。**

**目录语义**
1. 有封面图的文件夹 → 收敛成一个「封面条目」；没有的 → 保持目录。
   `handleCover`：有子目录→保持目录；无子目录+有图→收敛；无子目录+无图→保持目录
2. `avatar.jpg` / `cover.jpg` = 目录自己的脸 → 当目录图标渲染，**不单独列成条目**
3. 首层也用 `cover` 模式（`handleDirChange` 传 `'cover'`）

**交互便捷**
4. 双击格子打开（单击不打开）；双击封面条目 = 打开里面**视频**
5. 封面条目 `files > 1` 时点击弹文件列表 popover
6. 快捷键：`S` 搜索框 / `F5` 重扫当前目录 / `D` 选文件夹
7. 搜索支持拼音首字母（`usePinYin`，取第一个读音）
8. 面包屑跳转；进子目录清空搜索词、返回恢复；返回恢复滚动位置
9. 视频预览复用缩略图（不走 `/raw`）—— 不为预览读一遍 5~7 GB 原片

**导航结构（已收口，别分叉）**
10. 三条入口合一条：选文件夹 / 缓存记录 / 网格下钻，全经 `handleDirChange` → `pushLevel()`
    - `openHistory(path)` 只看 path，不看记录里的 `mode`
    - `levelName(path)` 是**算**出来的（曾因此整层消失）；`openStack.value.push` 全库 1 处
    - `返回` 的 `v-if="dir"` 是老判断；栈的真判据是 `openStack.length > 1`

**架构决策（已拍板，别再提议）**
11. 保留 HTTP 前后端分离，不换 IPC
12. 封面缩略图存 DB（第一目标：少碰移动硬盘）
13. 缓存不跨机保留（"那是云端的事情"）
14. 只需保证「A 盘(H:) 拔出、B 盘(H:) 插入不冲突」

**安全 / 健壮性（已授权）**
15. 本地服务带口令 `?t=`（随机生成、不落盘、渲染层经 IPC 取）
    - 不能用 Origin 名单：打包后应用自己是 `file://`，Origin 是字面量 `'null'`
    - 走 URL 不走请求头：`<img src>` 带不了自定义头；`src/utils/request.ts` 的 `apiUrl()` 是**唯一出口**
16. 空状态只有一行浅灰小字，失败时**不显示**（`loadFailed`）
17. 封面解码有 ffmpeg 兜底；`makeDirCover` 必须先 `access` 再解码
    - 选封面的正则放行 `webp|psd|svg`，解码器都不支持 → 「承诺 > 能力」错配，别再只改一边

## 二、最高优先级
**减少对移动硬盘的读写。** 冲突时以此为准。

## 三、协作方式（用户有 ADHD + 阅读障碍）
- 交付极简：**正文 ≤10 行 + 优先一张图 + 需要他做的动作一行**
- 过程/根因/验证数据一律落 `docs/`，不进对话；他问"还有哪些没做"时只要剩余清单
- 改主进程代码后必须**重启 dev**；改了扫描逻辑后要按**刷新（↻）**重建那条缓存
- ⚠️ **他的提问先判类型**：问「X 不能吗 / 有没有 / 怎么用」= **认知需求**（讲机制+给能自己跑的实验），
  不是行动需求；不许在结尾追加"要我执行吗"式催办（2026-09-23 血泪教训）

## 四、文档索引
- `docs/UPGRADE-PLAN-2026-09-24.md` —— 缓存健壮性方案（第 4 版）。⚠️ 开工直接读 **§十五 开工件**
- `docs/VERIFY-P0-2026-09-24.md` —— P0 落地 + A/B 实测（逐处改动 + 判据 1/2/3 + 偏离说明）
- `docs/P0-diff-2026-09-24.diff`、`docs/P0-probe-{before,after}.log` —— 原始证据
- `docs/AUDIT-VERIFY-2026-09-24.md` —— **交叉验证与最终裁决，冲突时以它为准**
- `docs/AUDIT-2026-09-24.md` —— 初次审计；⚠️ 有内容丢失（停在 13:20），别做增量编辑
- `docs/DESIGN-{CONVERGED,PM,UIUX,BACKUP,INPUT}-2026-09-24.md`、`docs/CHANGES-VS-ORIGINAL.md`、
  `docs/ARCH-PLAN.md`、`docs/CODE-REVIEW.md`、`docs/P1-diff-2026-09-24.diff`
- `docs/FEATURE-offline-readonly-2026-09-24.md` —— **离线盘只读浏览**（锚点方案 + 18/18 实测 +
  未实测清单 + 复算命令）；日志 `docs/anchor-probe-2026-09-24.log`
- `docs/FIX-2026-09-24-naive-ui-update-prop.md` —— 缓存记录选盘不生效的根因
- `docs/DEPS-UPGRADE-2026-09-24.md` —— 依赖升级全过程；第六节是启动崩溃与换库取证
- 只读探针 `docs/probes/`：`scan-cost` / `clickable-dirs` / `cache-v-audit` /
  `ffprobe-kill-leak`（**需禁沙箱**，沙箱内 spawn 子进程一律 EBUSY）/ `p1-sfc-smoke` /
  `png-inspect.py`（纯 Python 解 PNG + 粗粒度布局可视化，用于"截图里到底有几个按钮"这类问题）
  ⚠️ `p1-sfc-smoke` 只证明"能编译"，**不证明"渲染出来是对的"**；界面对不对**无头验不了**

## 五、缓存层的规则（P0 之后）
- **永不自动删**。版本不符 = 读取时当未命中（`findCache`），浏览时被新记录自然覆盖。
  **任何"格式变化 → 删数据"的逻辑都是错的**（旧判据 `{v:{$ne:2}}` 实际是"没有 v 就删"，
  杀了"格式正确、只是没打版本号"的记录）。
- **条目一律按白名单重建**：`server/index.ts` 的 `pickFileInfo`，挂在**唯一出口 `wire()`**，
  只放行 9 个**会下发**的字段。`thumbData`/`avatarThumbData` 只存不发，**不许进白名单**；
  `files[]` 也要重建（v1 里 `FileInfoFiles = fs.Stats & { name }`）。
  黑名单（原 `stripThumbData`）已删，**别再加回来**。
- `CACHE_VERSION = 2`。**升版 = 全库重扫 = 撞移动硬盘**，非必要不升。
- 键是 `(serial, relPath, mode)`，**盘符不落数据** → `~/.file-finder/searchCache.db`
  本身就是跨机有效的导出（拷它即导出）。
- 同目录只有 3 个文件：`searchCache.db`（主库，导出拷它）／`searchCache-YYYYMMDD.db`
  （`cacheBackup` 写的当天备份，**同名互相覆盖**）／`disks.json`（盘注册表 serial→label，
  只影响"离线盘是否出现在「缓存记录」面板"，**不拷也行**，插一次盘就重新登记）
- ⚠️ **导入/替换数据文件必须先退出应用**：实测运行中该文件**无独占锁**（`r+` 能打开）→
  覆盖面**不报错**、会被内存态静默冲掉（nedb 启动整库读进内存，**运行时内存才是真相源**）。
  这比"报错"危险得多。导出**不用**退（只读）。界面上目前**没有地方**提示这一点 —— 等用户点头再补文案。
- 库损坏两档（实测）：**>10%** → `executor.ready` 永假 → 之后所有 count/insert/find **永久挂起**
  （表现是**页面卡死**，不是空库）；**≤10%** → 加载成功但整份重写、坏行永久消失、无备份无报错
  （这才是真正的静默丢数据）。
- 成本：暖态遍历 13 ms 是 FS 缓存假象；冷态 1291 stat ≈ 8–17 s；524 张缩略图 / 340 readdir /
  83 access。全量重建 70 s–2.5 min（**推算，未整盘实测**）。
- 实测：应用对 `E:/` `F:/` 运行期写入 = **0**（11 条写盘路径穷举）。但 atime 是启用态、
  两块盘被识别为"固定驱动器" → **OS 层仍会写元数据**。
  **ffprobe 也读盘**（`timestamps:['1%']` → `getMetadata()`）→ 唯一真实伤盘风险是 **USB 供电**，
  靠"串行、一次一块盘"挡住。
- **离线盘只读浏览 = 已做**（2026-09-24 晚，用户原话「至少让我只读也可以啊」）：
  用**只读锚点** `#<serial>/<relPath>` 寻址缓存（锚点不是路径，`splitPath` 拆不开它）——
  导航栈/面包屑/下钻全程只流动这一个字符串，**导航核心一行没改**。
  `openFolder` 最前面加锚点分支：只 `findCache`，不 readdir、不写库、忽略 `noCache`，
  未命中 → `kind:'notCached'`；`getHistory` 离线盘的 `path` 由 `null` 改成锚点；
  渲染层 `readOnlyLevel`（判据=前缀 `#`）→ info 横幅 + 禁三入口 + 预览降级。
  改动/证据/未实测项见 `docs/FEATURE-offline-readonly-2026-09-24.md`；探针 18/18 PASS。
  ⚠️ 只读层**永远**只读（盘插回来也不会自动复活，得从「缓存记录」重进）——刻意如此。
  ⚠️ 这块盘**没有**任何读到磁盘文件的通道：`/raw` 天生拒绝锚点（400）。

## 六、已裁决但**不做**的（别重开）
- `CACHE_VERSION` 不为图片修复升版（按一次 ↻ 就够）
- 缩略图内存上限（C3）：重启即归零，实测全库仅 6.93 MB
- A4 删死代码 / A5 dev 重建 dist / P1-2 contextIsolation / `/raw` 收紧 / 虚拟滚动 / `readFolder` 并发化
- `ABC-01-A/B` 类"多部片子共一张图"：数量判定修不好，要做对只能番号归一化，暂无样本
- ffprobe 超时回收（§13）：**实测泄漏成立**，但**等用户点头**才动

## 七、依赖与构建链契约（动版本前先读）
锁定：electron 44.4.5 / electron-builder 26.15.3 / vite **7.3.6** / vite-plugin-electron 0.29.1 /
renderer 0.14.7 / vue 3.5.43 / naive-ui 2.45.3 / typescript 5.9.3 / vue-tsc 3.3.11 /
@ffprobe-installer 2.1.2 / @types/node 24 / **@seald-io/nedb 4.1.2**。`engines.node >=22.12.0`。
`dev` = `chcp 65001 && vite`（**渲染层由 vite dev server 3344 直接提供，HMR 推更新**）。

**四条硬契约（破了是运行期炸，不是编译期报错）**
1. 主进程/预加载**不许内联运行期依赖** → main 与 preload 各挂 `notBundle()`。
   自检：`grep 'require("fluent-ffmpeg")' dist/electron/main/index.js` 必须命中（产物 15–16 kB）。
2. **vite 不要上 8**（rolldown 把渲染层 `require("electron")` 变裸 ESM import → `file://` 白屏）。
   自检：`grep -c 'from"electron"' dist/assets/index-*.js` 必须是 0。
3. 打包靠 electron-builder 自动收 prod `dependencies` → 两个 dependencies 的划分**决定打进包的东西**
   （`less` 是构建期工具却挂在 dependencies；瘦身要挪走 = 结构变更，需用户点头）。
4. 缓存层是 `@seald-io/nedb` 4.x。**别装回 `nedb`**（Node 24 无 `util.isDate`），也别给 `util` 打补丁。
   v4 三件事：数据文件双向兼容；`$ne` 匹配"字段缺失"要重验；公开 `compactDatafile(cb)` 取代私 API，
   `loadDatabase()`/`ensureIndex()` **必须给回调**（否则升级成 UnhandledPromiseRejection）。

**其它已踩过的坑**
- 数据目录 `%USERPROFILE%\.file-finder`，与 Electron 版本无关；改 `electron-builder.json5` 别加 `productName`
- Electron 二进制不随 `npm install` 下载：
  `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node node_modules/electron/install.js`
- `npm install` 后扫残留 `find node_modules -maxdepth 1 \( -name "*.DELETE.*" -o -name ".*-*" \)`；
  **先看是不是空壳**（本仓库 178 个 `.<包名>-<hash>` 全是空的、不影响运行）
- **naive-ui 的 update 事件只能挂一个 handler**：`v-model:X` 与 `:on-update:X` 是同一个 prop，
  后写的顶掉 setter（控件能展开能点、值不变）
- **naive-ui `n-popconfirm` 不会复制 trigger**（读源码确认：`trigger: slots.trigger`，
  面板只有 `description + [negative][positive]`）—— 这是对的，但**别停在这一步**：
  我 2026-09-24 白天的判断「重复按钮是旧代码渲染的」是**错的**，真因是 `n-space`
  （见 §十一）。**教训：`grep` 计数只能证明"源码里只有一份"，不能证明"运行时渲染出一份"。**
- **`@seald-io/nedb` v4：不先 `loadDatabase` 就 `insert`，回调永远不来** ——
  而事件循环里没有别的句柄 → node **静默 exit 0、一行输出都没有**
  （2026-09-24 写探针时踩到，表现像"脚本什么都没打印却成功退出"）
- **`%TEMP%` 下的探针要 `NODE_PATH=D:/code/file-finder/node_modules`**，
  否则 `require('esbuild')` / `@seald-io/nedb` 解析不到
- 无头/沙箱验证见 skill `electron-headless-verify`（替身 + 隔离探针 + 探针时序坑）

## 八、P0 + P1 + P2 已落地（2026-09-24 晚，**未提交**）
> 开工前先读 `docs/DESIGN-CONVERGED-2026-09-24.md` §六「落地与实测」。

**P0 实际是 4 处**（原计划 1 处，多的 3 处是审查时新发现）`electron/server/index.ts`
1. `readFolder` 的 `readdir` 失败 → **抛错**并挂 `kind:'unreadable'`（原 `return []`）
2. `handleCover` 读取失败 → 返回 **`null`**（原 `[]`）—— ⚠️ **空数组是 truthy**，
   调用方 `if (converged) {…; continue;}` 会把这个子目录**静默跳过，连名字都不出现**
3. `openFolderController` 拆开 `!parts`（UNC 等：合法、只是不缓存）与 `!disk`（**报错**，`kind:'offline'`）
4. **`route()` 咽喉点替掉全部 `event.on`** —— `event.emit` 是**同步调用**，async handler 抛错无人接
   → unhandledRejection + **请求永久挂起**。**不加这条，改动 1 会让情况从"写坏数据"变成"页面永远转圈"**
- 另：删 `dropLegacyRecords` + 启动调用；`findCache` 加版本判断；`pickFileInfo` 白名单挂在 `wire()`；
  `compact()` 现在**无调用方**（保留，将来做 `/compact` 维护入口）。

**P1**（`src/views/FileFinder/index.vue`）：两个**平铺**扫描按钮（不再藏 hover 下拉）；
重读加 `n-popconfirm`；扫描中禁「刷新」（它带 noCache）；三态 `n-alert` 横幅（**不 closable**）；
`failKind` 为真源、`loadFailed` 改 `computed` 派生。命名 **补全这一片** / **重读这一片**；
**「刷新」不改名**，只加 tooltip。
**失败分类链路**：服务端 `kind` → `route()` 透传 → `request.ts` 的 `ApiError.kind`。
**判别不许 match 文案**（同"`apiUrl()` 唯一 URL 出口""`wire()` 唯一下发出口"）。

**P2**：IPC `openDataDir` → `shell.openPath(config.userBasePath)`；「缓存记录」面板加文字链接
「打开存放文件夹」。**不做**应用内导入按钮（导入 = 覆盖全库，危险度高于所有扫描动作）。

**实测**：A/B（before 覆盖成 `count:0` / after 完好）+ 回归（真空目录、普通目录）全 PASS；
`kind` 两种分类均正确下发；`vue-tsc`+`tsc`+`vite build` 全 exit 0；两条构建契约自检通过。
**17:15 另一会话独立复核通过**（见 `docs/VERIFY-P0-2026-09-24.md` §八，含 3 条补查）。

**探针**（`%TEMP%/ff-p0b-probe/`）：`run.cjs`(P0 A/B) · `run-regress.cjs` · `run-kind.cjs` ·
`run-anchor.cjs`(离线只读 18 判据) · `build-after.cjs` · **`sync-after.cjs`**（从主仓库刷新副本 + 重打三处特化）。
⚠️ 探针跑之前要 `NODE_PATH=D:/code/file-finder/node_modules`（否则 esbuild/nedb 解析不到）。
⚠️ **改完主仓库源码必须跑 `sync-after.cjs` + `build-after.cjs`**；端口特化（3060→3062）要有断言。
⚠️ **复算 `run.cjs` 前必须先清 `<variant>-data`**（`seed()` 只 insert 不清库 → 脏目录上重跑会叠加
→ 出 2 条**假 FAIL**）。**探针的可复算性 = 脚本 + 前置状态。**
⚠️ **`_line.cjs`**：库加密后不能直接 `JSON.parse` 数据行（老探针会误报「落盘记录: (无)」）。
**"读不到"的真实形态怎么造**：`icacls <dir> /deny <user>:(RD)`（Git Bash 要 `MSYS_NO_PATHCONV=1`）

## 九、加密 / 备份 / 还原 / 合并（2026-09-24 晚，**未提交**）
**用户批准原话**：「接受，导出就加密，导入就解码，规划设计好了一起做了！」

**加密契约（动之前必读）**
- 钩子挂在 `nedb.ts` 的 `afterSerialization`/`beforeDeserialization`：**AES-256-CBC + base64**，零新依赖。
  `CACHE_KEY = sha256('file-finder-cache-v1-2026-09-24')`、`CACHE_IV = 16 个 0`。
- ⚠️ **`CACHE_KEY` 永不可改**：改了 = 旧库全读不出来。不是配置项。
- ⚠️ **IV 必须固定**：要**确定性加密**，否则同一 `relPath` 每次密文不同 → `serial` 索引与
  `findCache({serial,relPath,mode})` 全失效。
- 钩子输出**绝不能含换行**（nedb 会丢数据）→ 必须 base64。明文兼容判据：行以 `{` 开头
  （base64 字符集不含 `{`）→ **旧明文库零迁移代码**，启动那次整库重写自动变密文。
- 强度是**诚实版**：固定密钥 = **混淆级别**，只防"随手用记事本打开"，**不防有心人**；
  **不许对外宣称是安全存储**（已写进代码注释）。体积 8.2 → 11.5 MB（1.333x）。

**启动开销（实测，机制未定位）**：明文 ~1300ms / 明文→密文 612ms / 密文 **~150ms**；纯 AES 仅 21ms/轮。
**只取"加密没有引入启动代价"这一条**；"明文为什么反而慢 8 倍"未定位，不许当优势宣称。

**关键闸门 `assertUsable()`（原 `assertLoaded`）**：`nedb.ts` 里**唯一**的读写闸门，6 个导出函数全过它。
挡 `loadError`（否则 executor 永假 → **所有请求永久挂起 = 界面卡死**）+ `restoring`
（还原窗口期 → 否则后台批量扫描的 append 会和 `copyFile` 撞出残file）。
⚠️ `onLoaded` **成功时必须清空 `loadError`**，否则"还原失败→回滚成功"之后库仍被判不可用。

**还原 = 就地重载，不重启**（推翻初版设计）：`reloadFromDisk()` 二次调 `loadDatabase`
（探针 `ff-enc-probe/reload.cjs` **6/6 PASS**）。`app.relaunch()` 在 dev 下不可靠
（vite-plugin-electron 起的进程）→ **能重载就不要重启**。快照用**独立槽位**
`searchCache-before-restore.db`（`cacheBackup()` 那个是同名覆盖的，关键时刻靠不住）。

**分工原则（延续既有先例，别分叉）**：**需要系统能力的那一步进主进程（对话框），
数据本身的操作留服务端（HTTP）** —— `pickCacheSavePath`/`pickCacheOpenPath` 只选路径；
`/backupToFile`、`/restoreFromFile`、`/mergeCache` 干活。和 `openDirectory` 逐字一致。

**合并 vs 还原（两个词必须分清）**

| | 还原 | 合并 |
|---|---|---|
| 本机独有记录 | **消失** | 保留 |
| 可撤销 | 有（快照 + 自动回滚） | 无（只增不删） |
| 二次确认 | **要** | 不要 |

合并规则：按 `(serial,relPath,mode)` 比，冲突取 `create_at` 新的；**只并 `v === CACHE_VERSION`**；
每条都走 `queueCacheWrite`（和 `scanAndCache` 同一条链）先删后插；
⚠️ 读外部文件必须**先复制到临时文件**（`loadDatabase` 会整库重写 → 直接 load 等于改了用户的备份，
只读介质还会直接失败）；插入时**丢掉外来的 `_id`**（撞唯一索引会中断合并）。

**证据在哪**：`%TEMP%/ff-enc-probe/{migrate,reload,timing}.cjs` · `%TEMP%/ff-p0b-probe/run-backup.cjs`，
全部可重跑。总账 **migrate 12/12 · reload 6/6 · run-backup 30/30 · P0 A/B+回归+kind 全 PASS**，
逐条见 `docs/DESIGN-BACKUP-2026-09-24.md` §七。

## 十、待用户动作（别自己往下走）
- **重启 dev**（他跑的实例还是旧代码）
- `ffprobe` 超时回收（方案 §13）：**等点头**
- **目视验收「离线盘只读浏览」+「工具条/状态条」两处界面**（服务端与渲染结构都有 18/18、30 轮实测，
  **但观感无头验不了**）—— 见 `docs/FEATURE-offline-readonly-2026-09-24.md` §五、
  `docs/FIX-2026-09-24-nspace-duplicate-keys.md` §六
- "改数据文件前先退出应用"的界面提示文案：**等点头**
- `compact()` 留或删：待定

## 十一、naive-ui `n-space` 的重复 key（2026-09-24 晚，**已修**）
**症状**：点了「补全这一片」之后，工具条上出现**两个「重读这一片」**，还有一个**点了没反应的「取消」**。

**根因（两层）**
1. **naive-ui 2.45.3 的 `Space` 给每个子项硬编码同一个 key** ——
   `node_modules/naive-ui/{es,lib}/space/src/Space.js` 里 `createElementBlock("div", { key: 1, … })`。
   最新版就是 2.45.3，**没有可升的版本**。
2. **子元素个数一变就错位**：`normalizeVNode(() => array)` 生成 `patchFlag=-2` 的 Fragment →
   Vue 走 `patchKeyedChildren` → 两个新 `div` 的 key 都是 1，后写顶掉前写 →
   两个旧节点认领**同一个新槽位**，其中一个再没人回收 → 每切一次多留一个节点。
   Vue 自己会喊：`[Vue warn]: Duplicate keys found during update: 1  at <Space …>`。

**「取消没用」= 两件事叠加**：① 残留的「取消」按钮还在屏上，再点它时扫描早退出了 → 毫无反应；
② 取消是**软取消**（只在目录边界生效，刻意的）→ 点击到生效之间没有任何反馈 → 已用
`cancelling` 补上即时反馈。

**修法（不是打补丁）**：会增减子元素的容器**不再用 `n-space`**，换裸 flex `.hstack`（`gap:12px`
与 `n-space` 默认间距一致）。裸容器没有 key 可比 → 这类错位**在结构上不可能发生**。
改了 3 处（头部左组、头部右组、封面文件 popover）；`FolderSelector`/`HistoryTable` 那两处
子元素**恒定**，**没动**。
**铁律：不要在 `n-space` 里放过会增减的子元素。**

**顺手做的交互**（向 PC 文件管理器看齐）：扫描入口**常驻**、忙碌只置灰（不消失不变形）；
进度 + 取消搬到网格下方的**独立状态条**；工具条子元素**恒定**。

**证据**：`docs/probes/nspace-dup/`（`run.sh` 一键复算）——最小复现（不需要 popconfirm）
S1/S2 FAIL 59 次 + Vue 警告 60 条；对照组裸 div PASS；`wrap-item="false"` **修不掉**；
改前那一屏逐字复现 `["取消","补全这一片","重读这一片","重读这一片"]`。
改后 30 轮：骨架变化 0 / 重复 0 / Vue 警告 0。全程见
`docs/FIX-2026-09-24-nspace-duplicate-keys.md`。

**方法论收获**：**"同一次状态切换会不会渲染出重复节点"是纯渲染问题，可以在
happy-dom + 真 naive-ui 下复现/验证** —— 补上了 `electron-headless-verify` 里
"界面对不对无头验不了"的那个缺口（结构可验，观感仍不可验）。

**⚠️ 紧接着的布局回归（同一晚修掉，教训比上面那条更重要）**
`n-space` 的包装 `div` **恰好把 `n-input` 天生的 `width: 100%` 关在盒子里**；换成裸容器后
100% 直接生效 → 搜索框独霸一行 → 工具条 1 行变 3 行（头部 37px → **117px**，真 Chrome 实测）。
修法：`.toolbar{flex-wrap:nowrap}` + 搜索框固定 `200px`。
**原文那句"界面对不对无头验不了"要改成两层**：
- **结构**（渲染出几个节点）→ happy-dom + 真 naive-ui 可验；
- **布局**（几行、多宽）→ **真 Chrome + Playwright（`channel:'chrome'`，不下载浏览器）可验**；
- **观感**（好不好看）→ 只能人眼。
**结构对 ≠ 布局对** —— 结构探针当时报了 PASS，而界面上明明是三行。

**铁律（新增）**
- **`n-input` 是 `width: 100%`**：放进会换行的 flex 行 = 独霸一行。`n-space` 时代被包装 div 掩盖过，
  **别再依赖那种巧合**。给固定宽度，或给容器 `nowrap`。
- **切 SFC 模板做探针时，别在切出来的片段外面再包一层容器** —— 那层包装会改变布局，
  结构结论无关紧要、布局结论直接失真。
