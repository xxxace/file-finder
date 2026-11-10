# 补封面 · 抽帧当封面 + 自动带盘（设计）

**日期**：2026-11-10（v2，首版被 builder check 挑了 5 处结构性错误，已改）
**状态**：设计完成，待批准（未写一行业务代码）
**范围**：`AssistantCoverModal` 全链路 + `electron/server/assistant/`（新增 `frame` job）
**前置**：`DESIGN-ASSISTANT-WORKBENCH-2026-11-08.md`（骨架/状态语汇/动效预算），本文只写增量

---

## 一、意图

补封面第一遍抓取必然会留下一批"没封面"的卡（站点没有 / 被拦 / 封面解不出 / 认不出番号）。
这批卡的视频**就躺在盘上**，封面其实取得到 —— 抽一帧。用户原话：
「提供一个功能按钮抽帧作为封面」「允许用户对某个作品进行重新抽帧，每次都比之前往前些，
防止出现黑色或者信息不够的画面当封面」。

真正要解决的不是"抽一帧"，是**在抽帧这个必然反复的动作里，让用户用最少的点击拿到一张能看的脸**。

## 二、目标 / 非目标 / 反目标

**目标**
1. 右键「补封面」时，若主界面正开着一块**在线**盘，自动预选该盘并直接扫它（省掉每次手选）。
2. 抓取失败的卡，能一键（单卡 / 批量）用视频关键帧当封面，**先上卡预览、再确认写入**。
3. 单卡可反复「换一帧」，位置沿固定阶梯往后推，卡片上显示当前档位。
4. 抽出的帧本身是纯色（黑场 / 白闪 / 纯色卡）时，自动往后跳档并如实告知跳了几次。
5. 离线盘一律不能抓取 / 抽帧 / 写入（必须在线），扫描仍可看缓存清单。

**非目标**
- 不给「认不出番号」的条目做卡片（用户 2026-11-10 明确：那批不处理，维持折叠明细）。
- 不做以图搜图 / 视觉去重（早已砍）。
- 不做"手动输入秒数 / 时间轴拖选"（违反"不手动输入"的立场，且不是他的用法）。
- 不改抓取端（`grab.ts` 一个字不动）。
- 不做跨盘批量（一个面板一条盘，与现状一致）。

**反目标（做出来算失败）**
- 抽帧绕过了"必须在线"的判据，变成一条能往离线盘写的口子。
- 抽帧把一张**已经抓到的**好封面顶掉（拿到就不再抽）。
- 为了抽帧新增第二个"确认写入"弹窗（同一件事问两次）。

## 三、约束

| 类别 | 约束 |
|---|---|
| 读盘 | 移动硬盘读写是最高优先级成本。抽帧**必须逐部串行**（机械盘并发寻道会更慢），每一部的读盘量要在界面上说得清（§八） |
| 缓存 | `thumbnail.ts` 的缩略图缓存纪律不动；帧缓存是**新的、独立的**一层（系统盘、可重建） |
| 唯一实现 | 「取一帧」只有 `thumbnail.ts` 一个出口；「抽帧并判纯色」只有 `frame.ts` 一个出口；单卡与批量**共用**它 |
| 样式 | `.vue` 内不出现 `#hex`，只读 `tokens.css`；不引入彩色；沿用 `.ffw-*` 皮肤 |
| 规模 | 单个新文件 ≤ 250 行；纯逻辑进 `.ts`，模板只画（`coverModel.ts` 的既有分工） |
| 验证 | 无测试框架 ⇒ `vue-tsc --noEmit` 0 error + `tsc -p tsconfig.electron.json` 0 error + 只读探针 + 真机目视。**改了主进程必须重启 dev** |

## 四、现状事实（已实测核对，行号为准）

| 事实 | 位置 |
|---|---|
| 打开补封面不认盘：只 `loadDisks()`，仅"全机一块盘"才自动选 | `AssistantCoverModal.vue:363-372` |
| 路径→盘号已有现成实现（`H:/x`、`#serial/x`、显式 serial 三形态）。**这是渲染层工具，不是服务端能力** | `src/views/FileFinder/assistant/driveContext.ts:26`，头像面板在用 |
| 取帧 = 时长 **1%** 处，自己 spawn ffprobe 带 20s 超时，exit 0 还验文件非空 | `utils/thumbnail.ts:317-347` |
| 写入的字节来源只有一个：`coverUrl` 下载 → 解码 → JPEG | `assistant/coverImage.ts:63` `getVerifiedCover()` |
| `/assistant/apply` **只接一个 jobId 且只认 `kind:'grab'`**，还预过滤 `isUsableCoverUrl` | `assistant/index.ts:488`、`:498` |
| 写入按 **`ApplyGroup` 循环**（不是按 row），group 里只有 `coverUrl` | `assistant/apply.ts:73-93`、`:225` |
| 写入对裸文件会**文件夹化搬迁**（建 `番号/`、搬分卷、写同名图）；`buildGroups` 需要 `kind/query/srcRel` | `assistant/apply.ts:128-175` |
| `kind:'dir'` 目标**不带** `srcRel`（视频在目录里，得现场找） | `assistant/scan.ts:32-58` |
| 抓取目前**不判盘在线**（只有写入判） | `apply.ts:192` 判了；`startGrab` 没判 |
| 卡片 `state='ok'` 的判据是 **`grabbed && card.coverUrl`**（帧行 `coverUrl` 为 null，会掉进 error） | `assistant/coverModel.ts:126` |
| 卡片已有 `pending` 态（DotField 点阵）与"封面落地"动效 | `assistant/CoverCard.vue`、`workspace.css` |
| 行按 writeRel 收拢时 first-wins（`grabs.find(ok)`），换一帧会被旧帧顶住 | `assistant/coverModel.ts:114` |
| 前端 `startApply` 硬依赖 `grabJob` 的 id | `AssistantCoverModal.vue:504`、`:513` |

## 五、方案（选定的那条）

**抽帧是"另一个取图来源"，不是另一条写入链路。**

```
            ┌─ 抓取（站点）──→ GrabRow {coverUrl} ─┐
扫描 → 目标 ─┤                                     ├→ 卡片预览 → 勾选 → 写入（同一条）
            └─ 抽帧（本地）──→ FrameRow {frame} ──┘
```

- 抽帧结果与抓取结果**同形**（都进 `job.rows`、都驱动同一张卡、都经同一个 `startApply`）。
- 写入链路里**要动四处，不是零处**（首版文档写错，这里改正）：
  ① `buildGroups` 门槛放行帧行；② `ApplyGroup` 增加 `frameFile` 字段；
  ③ `runApply` 取字节处按 group 的 `frameFile` 分支；④ `/assistant/apply` 收**多个 jobId**、并放行 `kind:'frame'`。
  其余（备份 / tmp→rename / 搬迁 / 日志 / 墓碑 / 刷新）**一行不改**。
- 所以"抽帧的封面"与"抓取的封面"在写入语义上完全等价：都会文件夹化搬迁、都会备份、都能失败重试。

**为何不是"抽帧即写盘"**：他明确要"每次往前些，防止黑色当封面"—— 这是一个**看了不满意再换**的
循环。没有预览就没有这个循环，只有"写错了再改"，而改一次要动盘两次。

**为何单卡与批量共用一个 job**：单卡重抽 = 续/起一个 1 条的 job。代价是底栏闪一下
「抽帧中 1/1」；换来的是暂停/终止/进度/结果全都不用重写（`jobs.ts` 的 Gate 已就绪），
也不存在"单卡请求挂 60 秒"的形态（`jobs.ts:1-16` 明令要避免的那种）。

## 六、状态与阶梯

**阶梯（唯一真相源，服务端 `frame.ts`）**：`PCT_LADDER = [1, 2, 3, 5, 8, 12, 18, 25, 35, 50]`（%）。

- 首次抽帧 = `attempt 0` → 1%；「换一帧」= `attempt + 1` → 下一档。
- 到 50% 后按钮禁用，文案「已到中段」。
- 前端只发 `attempt`，**档位由服务端查表**（不复制第二份阶梯，避免漂移）。

**纯色自动跳档（用户 2026-11-10 裁决：比值 ≥ 90% 才跳）**

```
抽到帧 → 解码 → 缩到 64×64 → 每通道 >>3 量化（32 档）→ 统计最大同色桶
        → 覆盖率 ≥ 0.90 ⇒ 判为纯色 ⇒ attempt + 1 再抽（最多跳 3 档）
```

- 判据按**字面**实现：只看"同色占比"，**不看亮度**。黑场、白闪、纯色过场卡都该跳；
  "暗但有内容"的帧不该被跳（他的原话是纯色，不是"太黑"）。
- 量化到 32 档是为了吸收 JPEG 振铃：纯黑区解码后不是精确的 0,0,0。
- **已知边界（诚实标注）**：大面积同色但非纯色的画面（天花板、墙面、天空）也会 ≥90% ⇒ 会误跳；
  渐变黑场（fade in/out）不是纯色 ⇒ **逃得过判据**。两者都是判据本身的形状，不另打补丁；
  阈值放 `frame.ts` 顶部常量，真机看多了再调。
- 跳档的读盘代价：**probe 只做一次**，每跳一档多一次 seek（§八）。
- 每部最多 4 次抽取（首抽 + 跳 3 档）。仍是纯色 ⇒ 取最后一帧，角标写「自动跳过 3」。

**取哪个视频（`kind:'dir'`）**：readdir → 只留视频扩展名（`server/videoExt.ts`，唯一真相源）→
**剔除疑似片花**（`sample|trailer|preview|特典|予告|cm` 不区分大小写）→ 自然序取第一个。
不按文件大小挑：`readdir` 能给名字但不能给大小，n 次 `stat` 就是 n 次寻道，直接推翻 §八 的读盘承诺。
（残余风险：无 `sample` 字样的小片花仍可能被选；用户点「换一帧」即可绕过，这是他已有的动作。）

**顺序**：串行、一次一部。job 并发度 = 1，与抓取的 5 并发刻意不同。

## 七、接口

### 7.1 起任务 / 追加

```
POST /assistant/jobs
{ kind:'frame', serial, targets: ScanTarget[], appendTo?: jobId }
→ { jobId }
```

- `targets` 就是 `/assistant/scan` 下发的那批（前端按 `writeRels` 过滤），**不新增目标形状**。
- `appendTo`（复用 `reopenJob`，与 `startGrab` 的 `jobId` 同义）：单卡重抽把新行追加进同一个 job
  ⇒ 卡不会因为"换了 job"丢回 idle。
- 服务端按**卡**去重后抽一次（卡键与 `buildGroups` 同口径：`file|<dir>|<query>` / `dir|<writeRel>`），
  但**为该卡的每个 writeRel 都下发一行** —— 否则多分卷只有一条带帧，`buildGroups` 只搬一个分卷。

### 7.2 行形状：`FrameRow = GrabRow + 帧字段`

**不是新形状。** 必须带 `kind / query / srcRel / writeRel`，否则 `buildGroups` 会走进错的分支
（首版文档漏了，会把封面写成 `undefined/undefined.jpg`、一个分卷都不搬）。

```ts
interface FrameRow extends Omit<GrabRow, 'status' | 'coverUrl'> {
  status: 'ok' | 'error';      // 'no-video' 归到 error + why，不扩枚举
  coverUrl: null;              // 帧行的字节不从 URL 来
  frame: true;
  frameFile: string;           // 帧缓存文件名（不含目录），见 7.3
  pct: number;                 // 实际用的档位
  attempt: number;             // 阶梯下标（下次 = attempt + 1）
  skipped: number;             // 自动跳过的档数
  why?: 'no-video' | 'probe-failed' | 'no-frame' | 'offline';
}
```

### 7.3 帧缓存：只有一张 jpg，文件名自带元数据

```
<dataDir>/frames/<serial>/<cardKey16>_a{attempt}_p{pct}_s{skipped}_n{nonce}.jpg
```

- `cardKey16` = `sha1(卡键)` 前 16 位（卡键含中文/斜杠，不能进文件名）；**一张卡一份**，多分卷共用。
- `nonce` = `Date.now().toString(36)`：每次抽取都换文件名 ⇒ 预览 URL 天然变 ⇒ 浏览器不会拿旧图。
  同时修掉首版 `v=<attempt>` 的坑（失败重试 attempt 归 0 会撞回同一个 URL）。
- **不要 sidecar（2026-11-10 裁决，我原方案是多余的）**：判断"这张帧还被不被引用"不需要额外记账 ——
  卡键是**可复算的**，服务端拿 `scanMissingCovers(serial)` 把每张卡重算一遍 `cardKey16`，
  与文件名比对即可。引用关系由缓存记录本身表达，不需要第二份。少一层文件、少一处会不同步的真相。
- 换一帧 = 删同前缀旧 jpg、写新 jpg，`tmp → rename`（与 apply 同一纪律）。
- **代价（诚实标注）**：孤儿行**没有名字可显示**（键已经算不出卡）。展示靠图本身
  —— 回收站看脸认东西，比猜名字准。

### 7.4 回填与预览

```
POST /assistant/frames   { serial }              → [{ writeRel, frameFile, pct, attempt, skipped, at }]
GET  /assistant/frame    ?serial=&f=<frameFile>  → image/jpeg（no-store）
```

- 回填只收 `serial`：服务端自己跑一次 `scanMissingCovers(serial)`（纯缓存、零读盘）算出每张卡的
  `cardKey16`，再 readdir 帧目录按前缀匹配 ⇒ 直接得出 `writeRel`。**前端不传 targets，也不需要 sidecar。**
- `GET /assistant/frame` 只接受 `^[0-9a-f]{16}_a\d{1,2}_p\d{1,3}_s\d_n[0-9a-z]+\.jpg$`（白名单，防目录穿越），其余 400。

### 7.5 写入

```
POST /assistant/apply  { serial, jobIds: string[], picks: string[] }
```

- 从 `jobIds` 里收集 `kind ∈ {grab, frame}` 的行，拼成一个 rows 数组（**首版最大的漏洞**：
  原来只接一个 grab jobId，而"扫描→抽帧→写入"这条主流程根本没有 grab job）。
- 服务端不再用 `isUsableCoverUrl(coverUrl)` 做唯一门槛：`isUsableCoverUrl(coverUrl) || row.frame`。
- `buildGroups`：帧行照常按 `kind/query/srcRel` 分组，`ApplyGroup` 新增 `frameFile: string | null`。
- `runApply` 取字节处唯一分支：`g.frameFile ? 读缓存文件 → toJpeg 兜底 : getVerifiedCover(url)`。
- 帧行**不立墓碑**（墓碑是给"URL 永久坏"用的）。
- 写入成功后删掉该卡的帧 jpg（已落盘，不再需要）。

### 7.6 抽帧缓存的盘点与回收（全局、不分盘、两级）

```
POST /assistant/frames/inventory  {}            → { total, bytes, items: [{ file, serial, bytes, mtime, pct, attempt }] }
POST /assistant/frames/verify     {}            → 实时核实（逐项 stat），刷新同一个 items
POST /assistant/frames/purge      { files:[] }  → { removed, freed, skipped }
```

**盘不是分界线**（2026-11-10 裁决）：帧缓存全在系统盘，与哪块盘无关 ⇒ **统一盘点、统一清理**，
盘只是列表上的一个过滤维度，不按盘发提醒、不按盘分块。

- **级一 `inventory` —— 零读盘，离线也能做。**
  对每块有缓存记录的盘跑 `scanMissingCovers(serial)`（纯缓存、唯一实现），把返回的每张卡重算
  `cardKey16` 建一个集合；帧文件名里的键在集合里 ⇒ `live`（还被引用），不在 ⇒ `orphan`（没人要了）。
  这一条口径就覆盖他说的全部情形：**已经补上正式封面的卡不再出现在"仍缺封面"集合里 ⇒ 它的抽帧帧必然判废**。
  不设年龄阈值 —— 判据只有"还缺不缺封面"，简单且自洽（改名后旧键失效，也是废）。
- **级二 `verify` —— 需要盘在线，只 stat 自己。**
  把仍判 `live` 的项（有键 ⇒ 从级一的映射里拿得到 `writeRel`）按盘上真实路径 `stat` 一次
  （裸文件看 `<dir>/<name>`，目录看目录本身）。不存在 ⇒ 缓存滞后，改判 `orphan`。
  读盘量 = **live 项数 × 1 次 stat**，不是扫盘。盘离线的项原样保留，回一句 `× N 项因盘离线未核实`
  —— 这就是"等在线时才处理"的那一档。
- **`purge` 不信任前端**：服务端重算一遍（inventory + 对在线盘顺手 verify），只删确认为 `orphan` 的，
  其余计入 `skipped`。文件名一律过 §7.4 白名单正则。
- ⚠️ **`inventory` 不能套 `scan.ts:15` 的 `MAX_DOCS = 3000` 截断**。它一截断，超出上限的卡就不在集合里
  ⇒ 还能用的帧被误判成孤儿 ⇒ 用户点清理就真删了。缓存全量进内存（当前 218 条记录量级），不读盘。

### 7.7 离线闸门

- 服务端（真相源）：`startGrab` / `startFrame` 起任务前判盘在线，离线回 409 + 人话；`runApply` 已有。
- 前端（体验）：离线时「开始抓取 / 抽帧 / 确认写入」禁用 + `title` 与底栏 detail 说明原因。
- 扫描**不闸** —— 它零读盘，离线盘也想看看缺哪些。

## 八、读盘清单（每轮必须主动交代）

| 动作 | 读盘量 |
|---|---|
| 扫描 / 重扫 | 0（纯缓存） |
| 深度重扫 | readdir + stat，**不抽帧**（既有行为不变） |
| 抽帧 · `kind:'file'` 目标 | 1×ffprobe（读头部）+ 每档 1 次 seek 读（约几 MB，落在 1%~50% 处） |
| 抽帧 · `kind:'dir'` 目标 | 上面 + **1 次 readdir**（视频在目录里，要现场找第一部） |
| 纯色判定 | **0**（帧已在内存，只是 CPU） |
| 回填帧索引（`POST /assistant/frames`） | **0**（缓存算卡键 + 系统盘 readdir，不碰移动硬盘） |
| 设置页盘点（`inventory`）= 级一 | **0**（同上，纯内存 + 系统盘） |
| 设置页「用实时清单核实」（`verify`）= 级二 | **live 项数 × 1 次 stat**（只 stat 有帧的那几个目标，不是扫盘）；盘离线则跳过、0 读盘 |
| 写入 | 与原链路一致：备份、写图、分卷搬迁 |

## 九、UI 规格

### 9.1 卡片（`CoverCard.vue`）

- 左上：勾选（不动）。**右上：动作位**（新增），24×24 ghost，**常驻**不靠悬停（他不靠悬停找东西）。
- 动作位由 `coverModel.actionOf(item)` 一处判定，模板只画：

| 卡片情形 | 动作位 | 角标 |
|---|---|---|
| 无封面（`miss`/`noid`/`error`/`blocked`），没抽过 | 「抽帧」 | 原状态文字 |
| 有帧（`ok` + `frame`） | 「换一帧」 | `抽帧 · 8%`；跳档时 `抽帧 · 8% · 跳过 2` |
| 站点抓到（`ok` 无 `frame`） | 无 | 站点名（不动） |
| 已写入（`written`） | 无 | 已写入（不动） |
| 抽帧中 | 无（禁用） | 点阵覆盖（复用 `pending` 的 `DotField`） |
| 已到 50% | 「换一帧」禁用 | `抽帧 · 50%` |

- **状态判定必须先改**：`state='ok'` 的判据从 `grabbed && card.coverUrl` 改成
  `grabbed && (card.coverUrl || card.frame)`，否则帧行（`coverUrl=null`）会掉进 `error` 分支，
  而前端 `startApply` 只收 `state==='ok'` ⇒ 帧永远写不进去。
- 帧的预览地址由父层拼：`item.frame ? /assistant/frame?serial=…&f=item.frame.frameFile : /assistant/preview?url=…`。
- 抽帧中的点阵 = 既有"逐条等待"语言，**不新增 spinner**；帧落地沿用 `workspace.css` 的 blur/scale 动效。

### 9.2 底栏（`TaskDock`）

- `idle` 态多一个 ghost 按钮：**「没封面的 N 部抽帧」**，仅 N>0 时出现，排在主按钮左边。
- 新模式 `frame` / `frame-pause` / `frame-done`：
  - 运行：`抽帧中 3 / 12` + 详情 `已跳过 2 张纯色`
  - 暂停：`已暂停 3 / 12` + `在飞的那一部跑完即停`
  - 结束：`抽帧结束 9 / 12 有封面` + `3 部抽不出（视频找不到 / 盘离线）`
- `buildCoverTask()` 增加 `frame` 参数；优先级 apply > frame > grab（抽帧与抓取不同时跑）。
- 进度线复用底栏上边缘那条（`scaleX`，200ms linear，进度不用缓动）。

### 9.3 抽帧缓存的盘点与回收（全局，住进设置界面）

**为什么需要**：帧缓存稳态是"每卡 1 张、写入即删"，但仍有两类文件**永不被引用**：
① 作品改名 / 换盘 / 已补上正式封面 ⇒ 卡键对不上了；② 抽了没写、后来这部也不在盘上了。
既不能静默删，也不能任其堆积 —— 所以给一个**能审阅的处理页**。

**盘不是分界线**（2026-11-10 裁决）：缓存是全机器的，一块一块提醒很怪。所以
**统一盘点、统一处理**，盘只作为列表上的**过滤维度**（`全部 / D盘 / E盘…`），默认全部。

**放哪**：**设置 → 通用 → 备份与迁移 下面新增一块「抽帧缓存」**（不新增一级分类 ——
`Settings/index.vue:24` 的准则写明"不为单项设置开一级页"；它和备份同属"系统盘上的数据"）。
**不弹窗**：补封面面板只负责**提醒 + 跳过去**。

**两级处理（对应他说的"得区分场景，逐级处理"）**

| 级 | 条件 | 做什么 | 读盘 |
|---|---|---|---|
| 一 · 记录判定 | 帧的卡键不在 `scanMissingCovers(serial)` 的"仍缺封面"集合里 | 直接判 `orphan`（作品已删/改名/换盘/已补封面） | **0**（纯缓存） |
| 二 · 实时核实 | 仍判 `live` 但缓存可能滞后 | 从级一的映射里拿到 `writeRel`，按盘上真实路径 `stat` 一次，不存在 ⇒ 改判 `orphan` | live 项数 × 1 次 stat；**盘离线就跳过**，并写明「× N 项因盘离线未核实」 |

第二级是**手动按钮**（`用实时清单核实`），盘离线时置灰并说明原因 —— 不自动扫盘、不后台跑。

**界面（就地展开，不是弹窗）**
1. 区块头：`抽帧缓存 · 12 张 · 3.1 MB`，其中 `4 张无引用`（有才显示）。
2. 一行过滤：`全部 ▾`（盘）· `无引用 / 刚生成 / 在用`（状态）· 排序按体积或时间。
3. 点「查看无引用的 4 张」就地展开列表：每行 `小图 · 盘 · 抽于 11-05 · 1.2 MB`（**没有名字** ——
   键已经算不出卡，靠图认，见 §7.3），默认全选。
4. 操作：`清除选中 4 张（释放 3.6 MB）` + `用实时清单核实`（需在线）。
   **不再弹二次确认** —— 这个列表本身就是审阅。
5. 清除后 `notify('success', '已清理 4 张', '释放 3.6 MB')`，数字就地更新。

**提醒**：补封面面板扫描完发现 orphan 时
`notify('warning', '抽帧缓存有 4 张用不到了', '设置 → 通用 可清理 · 3.6 MB')`
—— warning 自带 Nudge 音效（`useNotify.ts:21-23`），不另接音效通道。
面板顶栏 meta 同时多一段可点文字 `旧帧 4`，点了 `router.push('/settings')`。
**节流是全局的**（`localStorage['ff.frameCleanupNotified'] = yyyy-mm-dd`，每天最多一次），不按盘。

**不做**：不做定时任务、不在启动时扫全部盘、不提供"还原"（帧可由视频重建）。
删除只 `unlink` 系统盘上的帧 jpg，**移动硬盘上没有任何动作**。

### 9.4 顶栏 / 自动带盘

- `setShowModal(v, picks?, presetPath?)`：`index.vue` 的 `onMoreSelect('cover')` 传 `currentPath`。
- 面板侧：`loadDisks()` 之后，若无 picks 且 `presetPath` 非空 ⇒ `resolveDriveContext({currentPath:presetPath})`
  （**复用既有实现**）⇒ 命中且**该盘在线**才预选，然后照常 `runScan()`。
- 离线 / 清单屏 / 推不出序列号 ⇒ 保持空白，与现在完全一致（用户自己选）。
- 离线时三个操作按钮禁用，`title` 写「这块盘现在不在线，插上盘再操作」。

## 十、边界与失败

| 情形 | 行为 |
|---|---|
| `kind:'dir'` 里没有视频（`hasVideo === false`） | `error + why:'no-video'`，角标「没有视频」，动作位置灰 |
| ffprobe 拿不到时长 / 视频已不在（缓存过期） | `error + why:'probe-failed'`，角标「抽帧失败」，可再点（attempt 归 0） |
| 抽到 50% 仍纯色 | 取最后一帧 + 「自动跳过 3」，按钮禁用 |
| 盘中途拔掉 | 当前这部 `error`，job 以 `error` 收尾，已抽到的帧全部保留（写回前需插盘，`runApply` 会挡） |
| 抽帧后重扫 | 帧结果按 writeRel **跨扫描保留**（`frameByRel` 只在关面板时清空）；扫不到的目标自然消失 |
| 关闭面板再打开 | `POST /assistant/frames` 回填（§7.4），档位与帧都还在 |
| 抽帧把已抓到的封面顶掉 | **不可能**：动作位只在"没有封面"时出现 |

## 十一、自检（对既有铁律）

- **不加操作列**：卡上的动作位不是"表格操作列"，双击打开语义未变。
- **不读盘**：除 §八 明列的抽帧读盘，其余全为内存/系统盘操作。
- **不加手动路径/秒数**：档位是程序给的。
- **同一个决定只问一次**：仍是"卡上勾选 → 底栏一次确认"，没新增确认窗。
- **一份实现**：取帧 `thumbnail.ts`、抽帧+判纯色 `frame.ts`、动作判定 `coverModel.ts`、写入 `apply.ts`，
  每条只有一个出口；单卡与批量共用。
- **无彩色**：动作位走 `--ff-ctl-*`；角标沿用现有 badge 皮肤。
- **规模**：新增 `server/assistant/frame.ts`（约 180-220 行）；`AssistantCoverModal.vue`（现 572 行）
  增量控制在 +70 行内。

## 十二、改动清单（给 builder 的地图）

| 文件 | 改什么 |
|---|---|
| `electron/utils/thumbnail.ts` | 导出 `frameJpeg(file, pct, maxEdge)`：probe 一次 → seek 抽帧 → 缩到长边 ≤1280 → q90 JPEG 字节。取帧逻辑仍只有这一处 |
| `electron/server/assistant/frame.ts`（新） | 阶梯、纯色判定、帧缓存（命名/写入/替换/查找）、按卡去重、`runFrameJob()`、`inventory/verify/purge` |
| `electron/server/assistant/jobs.ts` | `JobKind` 加 `'frame'` |
| `electron/server/assistant/index.ts` | `startFrame()` 分发；`POST /assistant/frames`；`POST /assistant/frames/inventory`；`POST /assistant/frames/verify`；`POST /assistant/frames/purge`；`GET /assistant/frame`；`/assistant/apply` 改收 `jobIds[]` 并放行 frame；`startGrab` 加离线闸门 |
| `electron/server/assistant/apply.ts` | `ApplyGroup` 加 `frameFile`；`buildGroups` 门槛；`runApply` 取字节分支；写成功后删帧缓存 |
| `electron/server/assistant/grab.ts` | 只加可选字段 `frame?: boolean` 供共用，逻辑不动 |
| `src/.../assistant/coverModel.ts` | `ok` 判据加 `card.frame`；last-wins（换一帧覆盖旧帧）；`actionOf()`；`frame` 字段透传；frame 三个 dock 模式文案 |
| `src/.../assistant/CoverCard.vue` | 右上动作位 + 抽帧中点阵 + 角标 |
| `src/.../AssistantCoverModal.vue` | 第三个 `useAssistantJob`；`frameByRel` + 回填；批量抽帧按钮；离线禁用；`apply` 传 `jobIds`；`setShowModal` 第三参；顶栏「旧帧 N」提示（点了进设置）+ 每天一次提醒 |
| `src/views/FileFinder/index.vue` | `onMoreSelect('cover')` 传 `currentPath`（一处） |
| `src/views/Settings/FrameCacheBlock.vue`（新） | 「抽帧缓存」区块：总张数/占用、过滤（盘/状态）、无引用列表就地展开（小图+名字+日期+体积）、清除选中、实时核实（离线置灰） |
| `src/views/Settings/GeneralPanel.vue` | 挂上面那块（备份与迁移下方），约 +3 行 |
| `src/.../assistant/workspace.css` | 动作位样式（两三个选择器） |

## 十三、留给 builder 的

- 动作位图标：`@vicons/ionicons5` 没有语义完全贴切的，候选 `CameraOutline` / `ScanOutline` / `RepeatOutline`，
  按"抽帧 / 换一帧 / 禁用"三态选，不引新图标库。
- 阶梯常量、纯色阈值 0.90、64×64 采样边长、`sample` 剔除词表，都放常量位，允许真机调。
- 帧缓存目录不做定时清理（缓存层永不自动删）；只有"同卡替换"和"写入成功后删本卡帧"。
- 探针：纯色判定与阶梯是纯函数，写一个只读 `.mjs` 探针（合成纯色图 + 真帧样本），证据落 `.txt`。
