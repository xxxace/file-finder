# 补封面 · 抽帧当封面 + 自动带盘 · 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实施。步骤用 `- [ ]` 勾选跟踪。

**Goal:** 让"抓取失败的卡"能一键用视频关键帧当封面（可反复往后换帧、纯色自动跳档），并让右键补封面自动带上当前打开的在线盘。

**Architecture:** 抽帧是**另一个取图来源**，产出与抓取同形的 `FrameRow` 进同一个 job 表，经同一个 `/assistant/apply` 写入；差别仅在取字节处（`frameFile` 读系统盘缓存 vs `coverUrl` 下载）。帧缓存落在 `~/.file-finder/frames/<serial>/`，一张卡一份，文件名自带 `attempt/pct/skipped/nonce`；引用关系由缓存记录本身判定（卡键可复算），不需要 sidecar。

**Tech Stack:** Electron（主进程 Node + ffmpeg/ffprobe 子进程）、Vue 3 + TS、naive-ui、Less。

**Spec:** `docs/DESIGN-COVER-FRAME-2026-11-10.md`（执行前必读；本文只写"怎么落"，判据以 spec 为准）

## Global Constraints

- **项目没有测试框架** ⇒ 每个任务的验证三件套：`npm run typecheck` 0 error（含 `vue-tsc` 与 `tsc -p tsconfig.electron.json`）+ `docs/probes/` 只读探针（证据落 `.txt`）+ 真机目视。**不要写 TDD 式的假测试**。
- 改主进程（`electron/**`）⇒ **必须重启 dev**（`npm run dev`）才生效。
- 移动硬盘读盘量必须与 spec §八 逐条一致；新增任何读盘要先在计划/交付说明里交代。
- `.vue` 里不出现 `#hex`，只用 `tokens.css` 的变量或 `--n-*`；不引入彩色。
- 单个新文件 ≤ 250 行；纯逻辑进 `.ts`，模板只画。
- 同一件事只有一份实现：卡键、取帧、纯色判定、写入出口各一处。
- 提交前脱敏：入库文本不得出现真实番号/演员名/作品名/真机目录名/盘序列号/用户名（含探针输出文件）。
- 帧缓存文件名与接口参数一律过白名单正则，防目录穿越。

## Review Focus

1. **多分卷卡只搬了一个分卷** —— 8 个 writeRel 的卡抽一次帧，写入时 8 个视频必须全部进番号文件夹；用一条带帧的行代表整卡就会只搬 1 个（Task 5 的测试）。
2. **换一帧后卡片还显示旧帧** —— 浏览器按 URL 缓存图片；文件名不带 `nonce` 就永远是第一帧（Task 2/3）。
3. **已经抓到封面的卡被抽帧顶掉** —— 动作位只能在"没有可用封面"时出现（Task 6）。
4. **离线盘点把还能用的帧判成孤儿** —— 缓存文档超过 `MAX_DOCS=3000` 被截断时，超出的卡不在集合里；用户点清理就真删（Task 8）。
5. **离线盘上"点了没反应"** —— 抓取/抽帧/写入必须明确置灰并说明原因，扫描仍可用（Task 4/7）。

---

### Task 1: 共享卡键 + 阶梯 + 纯色判定（纯函数 + 探针）

**Files:**
- Create: `electron/server/assistant/cardKey.ts`
- Create: `electron/server/assistant/frameMath.ts`
- Test: `docs/probes/frame-math/run.mjs`（node 直接跑，不碰 electron）

**Interfaces:**
- Produces:
  - `cardKeyOf(x: { kind: 'file'|'dir'|'cover'; writeRel: string; query?: string }): string`
  - `key16Of(key: string): string`（`sha1(key).slice(0,16)`，小写 hex）
  - `PCT_LADDER: number[]` = `[1,2,3,5,8,12,18,25,35,50]`
  - `pctOf(attempt: number): number`（越界钳到末档）
  - `flatRatio(rgba: Buffer, w: number, h: number): number`（最大同色桶占比 0~1，量化 32 档）

- [ ] **Step 1: 写探针，先让它失败**

`docs/probes/frame-math/run.mjs`：import `../../electron/server/assistant/cardKey.ts` 与 `frameMath.ts` 的 `.ts` 源（用 `node --experimental-strip-types`），断言：
- `cardKeyOf({kind:'file', writeRel:'A/B/TST-001.jpg', query:'TST-001'})` === `'file|A/B|TST-001'`
- `cardKeyOf({kind:'dir', writeRel:'A/TST-001/TST-001.jpg'})` === `'dir|A/TST-001/TST-001.jpg'`
- `pctOf(0)`=1、`pctOf(9)`=50、`pctOf(99)`=50
- 全黑 64×64 RGBA ⇒ `flatRatio` ≥ 0.9；随机噪声 64×64 ⇒ < 0.5

Run: `node --experimental-strip-types docs/probes/frame-math/run.mjs`
Expected: FAIL（模块不存在）

- [ ] **Step 2: 实现 `cardKey.ts`**

`cardKeyOf` 的 file 分支**必须用 `writeRel` 反推层目录**（`dirOf(writeRel)`），不能用外部传的 `dir` —— 这样它和 `apply.ts:158` 的 `file|${layerDir}|${r.query}` 天然同口径。dir/cover 分支 = `` `${kind}|${writeRel}` ``。

- [ ] **Step 3: 实现 `frameMath.ts`**

`flatRatio`：每通道 `>>3` 量化成 32 档，桶键 `(r<<10)|(g<<5)|b`，统计最大桶计数 / 总像素。

- [ ] **Step 4: 跑探针**

Run: `node --experimental-strip-types docs/probes/frame-math/run.mjs > docs/probes/frame-math/result.txt`
Expected: 全部 PASS，`result.txt` 落盘且不含任何真实路径

- [ ] **Step 5: 把 `apply.ts` 的 `buildGroups` 改为调用 `cardKeyOf`**

只替换键的构造（`file` / `dir` / `cover` 三处），行为不变。

- [ ] **Step 6: typecheck + 提交**

Run: `npm run typecheck` → 0 error
```bash
git add electron/server/assistant/cardKey.ts electron/server/assistant/frameMath.ts electron/server/assistant/apply.ts docs/probes/frame-math
git commit -m "feat(cover): 共享卡键 + 抽帧阶梯 + 纯色判定（纯函数）"
```

---

### Task 2: 取帧出口 `frameJpeg`

**Files:**
- Modify: `electron/utils/thumbnail.ts`（在 `extractFrame` 之后新增导出，复用 `probeDuration` / `runFfmpeg`）

**Interfaces:**
- Produces: `frameJpeg(file: string, pct: number, maxEdge?: number): Promise<Buffer | null>`
- Consumes: 现有 `probeDuration` / `runFfmpeg`（同文件私有）

- [ ] **Step 1: 实现 `frameJpeg`**

签名 `(file: string, pct: number, maxEdge = 1280)`。流程：`probeDuration` 一次 → 算 `seconds = duration * pct / 100`（钳到 `[0, duration-0.1]`）→ `ffmpeg(file).screenshots({timestamps:[seconds], ...})` 到系统盘临时文件 → 读字节 → `nativeImage` 解码 → **只缩不放**到长边 ≤ `maxEdge` → `toJPEG(90)` → `finally` 删临时文件。任一步失败返回 `null`（调用方记 `why:'no-frame'`）。

- [ ] **Step 2: 真机验证一次抽帧**

Run: `npm run typecheck` → 0 error；然后 `npm run dev`，在 DevTools console 里对**一段本地视频**（非移动硬盘）调用一次（通过临时 IPC 或直接在 `frame.ts` 未完成时先用 `node -e` 引 ffmpeg 验证同一时间点能出图）。
Expected: 得到一个 JPEG Buffer，长边 ≤1280；同一 `pct` 两次结果视觉一致

- [ ] **Step 3: 提交**

```bash
git add electron/utils/thumbnail.ts
git commit -m "feat(thumbnail): 导出 frameJpeg（按时长百分比取一帧、限长边 1280、q90）"
```

---

### Task 3: `frame.ts` —— 帧缓存与 `runFrameJob`

**Files:**
- Create: `electron/server/assistant/frame.ts`
- Modify: `electron/server/assistant/jobs.ts`（`JobKind` 加 `'frame'`）
- Modify: `electron/server/assistant/grab.ts`（`GrabRow` 增加可选 `frame?: boolean`，逻辑不动）

**Interfaces:**
- Consumes: `cardKeyOf` / `key16Of` / `PCT_LADDER` / `pctOf` / `flatRatio`（Task 1）、`frameJpeg`（Task 2）、`Job`/`pushRow`/`bumpProgress`/`finishJob`（`jobs.ts`）
- Produces:
  - `interface FrameRow extends GrabRow { frame: true; frameFile: string; pct: number; attempt: number; skipped: number; why?: 'no-video'|'probe-failed'|'no-frame'|'offline' }`
  - `frameFileName(key16: string, attempt: number, pct: number, skipped: number, nonce: string): string`
  - `framePath(dataDir: string, serial: string, frameFile: string): string`
  - `runFrameJob(serial: string, targets: ScanTarget[], job: Job<FrameRow>, dataDir: string, videoExts: string[]): Promise<void>`
  - `readFrameIndex(dataDir: string, serial: string, targets: ScanTarget[]): Promise<{writeRel:string; frameFile:string; pct:number; attempt:number; skipped:number}[]>`

- [ ] **Step 1: 实现帧缓存三件事**

`frameFileName` 产出 `<key16>_a{a}_p{p}_s{s}_n{nonce}.jpg`；写入走 `tmp → rename`；同 `key16` 前缀的旧 jpg 在成功后删掉（同一条逻辑对象的替换）。`framePath` 返回 `<dataDir>/frames/<serial>/<file>`，目录按需 `mkdir -p`。

- [ ] **Step 2: 实现 `runFrameJob`（串行、逐卡）**

按 `cardKeyOf` 去重成卡 → 对每卡：
1. `await job.gate.wait()`，`job.cancelled` 则 break
2. 选视频：`kind:'file'` 用 `srcRel`；`kind:'dir'` 则 `readdir(盘符/目录)`，过滤 `videoExts`、剔除 `/sample|trailer|preview|特典|予告|cm/i`、自然序取第一个；找不到 ⇒ 该卡所有 writeRel 推 `status:'error', why:'no-video'`
3. 从 `attempt` 起在 `PCT_LADDER` 内循环：`frameJpeg(file, pct)` → 解码成 RGBA（`nativeImage.createFromBuffer(buf).resize({width:64,height:64}).getBitmap()`，注意 BGRA→RGBA 语义只需一致，不必转换）→ `flatRatio ≥ 0.9` 且未跳满 3 次 ⇒ `attempt++` 重试（`skipped++`）
4. 成功 ⇒ 落缓存、`pushRow` **为该卡的每个 writeRel 各推一行**（同一 `frameFile`）
5. `bumpProgress` 累加 `processed/hits/misses`；全部完成 `finishJob(job,'done', …)`

- [ ] **Step 3: 实现 `readFrameIndex`**

跑 `scanMissingCovers(serial,'')`（纯缓存）建 `key16 → ScanTarget` 映射，`readdir` 帧目录按前缀匹配，产出 `writeRel` 列表（一个卡键对应它的全部 writeRel）。

- [ ] **Step 4: typecheck + 重启 dev + 目视**

Run: `npm run typecheck` → 0 error；重启 `npm run dev`
Expected: 主进程日志无报错；`~/.file-finder/frames/` 目录在首次抽帧后出现

- [ ] **Step 5: 提交**

```bash
git add electron/server/assistant/frame.ts electron/server/assistant/jobs.ts electron/server/assistant/grab.ts
git commit -m "feat(assistant): frame job —— 抽帧、纯色自动跳档、帧缓存、索引回填"
```

---

### Task 4: 路由 + 离线闸门

**Files:**
- Modify: `electron/server/assistant/index.ts`（`startJob` 分发、新增 4 个路由、`startGrab` 加离线判断）

**Interfaces:**
- Consumes: `runFrameJob` / `readFrameIndex`（Task 3）
- Produces（HTTP）:
  - `POST /assistant/jobs` `{kind:'frame', serial, targets, appendTo?}` → `{jobId}`
  - `POST /assistant/frames` `{serial}` → `[{writeRel, frameFile, pct, attempt, skipped}]`
  - `GET /assistant/frame?serial=&f=` → `image/jpeg`
  - `POST /assistant/frames/inventory` / `verify` / `purge`（Task 8 实现，这里先注册返回 501 占位）

- [ ] **Step 1: `startFrame` + 分发**

`startJob` 里 `if (body.kind === 'frame') return startFrame(body,res)`。`startFrame` 做：盘在线判断（`getDrives(true)` 里找 serial，找不到回 `409 {error:'这块盘现在不在线，插上盘再抽帧'}`）→ 有 `appendTo` 且该 job 是 `kind:'frame'` 且已结束 ⇒ `reopenJob`，否则 `createJob('frame', targets.length)` → `void runFrameJob(...)` → 立刻回 `{jobId}`。

- [ ] **Step 2: `startGrab` 加同一道离线闸门**

写盘前判一次（与 Step 1 同一段代码，抽成局部 `assertOnline(serial)`，**不要复制第二份**）。

- [ ] **Step 3: 预览路由**

`GET /assistant/frame`：校验 `f` 过 `^[0-9a-f]{16}_a\d{1,2}_p\d{1,3}_s\d_n[0-9a-z]+\.jpg$`，再校验 `serial` 在盘表里，`readFile(framePath(...))` 回 `image/jpeg` + `Cache-Control: no-store`；不合法 400，不存在 404。

- [ ] **Step 4: 验证**

Run: `npm run typecheck` → 0 error；重启 dev，DevTools 里 `fetch('/api/assistant/frame?serial=X&f=../etc/passwd')`
Expected: 400（白名单挡住穿越）

- [ ] **Step 5: 提交**

```bash
git add electron/server/assistant/index.ts
git commit -m "feat(assistant): frame job 路由、帧预览、抓取/抽帧离线闸门"
```

---

### Task 5: 写盘链路支持帧行（多 jobId）

**Files:**
- Modify: `electron/server/assistant/apply.ts`
- Modify: `electron/server/assistant/index.ts`（`startApply` 改收 `jobIds[]`）

**Interfaces:**
- Consumes: `FrameRow.frameFile`（Task 3）、`toJpeg`（`coverImage.ts` 已导出）
- Produces: `runApply(serial, rows, job, dataDir, picks?, scanAndCache?)` 不变签名（rows 允许含帧行）；`ApplyGroup` 新增 `frameFile: string | null`

- [ ] **Step 1: 放宽 `buildGroups` 门槛 + 记录来源**

`if (r.status !== 'ok' || (!isUsableCoverUrl(r.coverUrl) && !r.frame)) continue;`；group 上写 `frameFile: r.frame ? r.frameFile : null`（`file` 形态取**该组第一条带帧的行**）。这条保证 Review Focus 1：8 个分卷行都带同一个 `frameFile`，`srcRels` 一个不少。

- [ ] **Step 2: `runApply` 取字节分支**

把 `await getVerifiedCover(g.coverUrl, …)` 换成：
```ts
const cover = g.frameFile
  ? await localCover(dataDir, serial, g.frameFile)   // 读文件 → toJpeg 兜底 → CoverCheck
  : await getVerifiedCover(g.coverUrl, job.controller.signal, enqueue);
```
`localCover` 是同文件私有函数，返回形状与 `CoverCheck` 一致（`urlBad` 恒 false）。

- [ ] **Step 3: 写成功后删帧**

该组 `ok` 后 `unlink(framePath(...))`（失败忽略）。

- [ ] **Step 4: `startApply` 改收 `jobIds[]`**

`body.jobIds?: string[]`（兼容旧 `jobId` 单值）；逐个 `getJob`，只收 `kind ∈ {grab, frame}` 且 `status !== 'running'`，把 `rows` 拼起来喂 `runApply`；门槛从 `isUsableCoverUrl(coverUrl)` 改为 `isUsableCoverUrl(coverUrl) || row.frame`。

- [ ] **Step 5: 验证（含 Review Focus 1）**

探针 `docs/probes/frame-apply/run.mjs`：用 8 条同 `query` 的 `FrameRow`（同 `frameFile`）喂 `buildGroups`，断言产出 **1 个 group 且 `srcRels.length === 8`**、`coverWriteRel === 'A/TST-001/TST-001.jpg'`。结果落 `result.txt`。

Run: `node --experimental-strip-types docs/probes/frame-apply/run.mjs`
Expected: PASS；`npm run typecheck` 0 error

- [ ] **Step 6: 提交**

```bash
git add electron/server/assistant/apply.ts electron/server/assistant/index.ts docs/probes/frame-apply
git commit -m "feat(apply): 帧行走同一条写入链路（多 jobId 汇总、本地字节、写后删帧）"
```

---

### Task 6: 视图模型 + 卡片动作位

**Files:**
- Modify: `src/views/FileFinder/assistant/coverModel.ts`
- Modify: `src/views/FileFinder/assistant/CoverCard.vue`
- Modify: `src/views/FileFinder/assistant/workspace.css`

**Interfaces:**
- Consumes: `FrameRow` 形状（同 `GrabRowLike` + `frame/pct/attempt/skipped`）
- Produces:
  - `type FrameRowLike = GrabRowLike & { frame: true; frameFile: string; pct: number; attempt: number; skipped: number; why?: string }`
  - `CoverItem` 增加 `frame?: { file: string; pct: number; attempt: number; skipped: number }`
  - `type CoverAction = 'frame' | 'reframe' | 'none'`
  - `actionOf(item: CoverItem, busy: ReadonlySet<string>): CoverAction`
  - `buildCoverItems(...)` 的 `opts` 增加 `frameBusy?: ReadonlySet<string>`

- [ ] **Step 1: 改状态判定（Review Focus 2/3）**

`grabbed && card.coverUrl` → `grabbed && (card.coverUrl || card.frame)`；`grabbed` 改为**同一 writeRel 的最后一行**（`grabOf.get(rel)`，现有 Map 已是 last-wins）而不是 `grabs.find(ok)`。帧行 `ok` 时 `coverUrl` 仍为 null，但 `frame` 有值 ⇒ state `'ok'`，`badge` 写 `抽帧 · ${pct}%`（`skipped>0` 时补 ` · 跳过 ${skipped}`）。

- [ ] **Step 2: 实现 `actionOf`**

规则：`state ∈ {miss,noid,error,blocked}` 且无 `frame` ⇒ `'frame'`；`state === 'ok'` 且有 `frame` 且 `pct < 50` ⇒ `'reframe'`；否则 `'none'`。`frameBusy` 含该卡任一 writeRel ⇒ `'none'`。

- [ ] **Step 3: 卡片右上动作位 + 抽帧中点阵**

`CoverCard.vue`：`:media` 里加 `<button class="ffw-card__act">`（绝对定位右上 24×24，常驻），`props` 增加 `action: CoverAction`，`emit('frame')`；`frameBusy` 时整个 media 叠 `DotField`。`workspace.css` 加 `.ffw-card__act`（走 `--ff-ctl-*`，不写 hex）。

- [ ] **Step 4: typecheck + 真机目视**

Run: `npm run typecheck` → 0 error
Expected（目视，30 秒）：失败卡右上出现动作位；抽帧中的卡有点阵；抓到封面的卡**没有**动作位

- [ ] **Step 5: 提交**

```bash
git add src/views/FileFinder/assistant/coverModel.ts src/views/FileFinder/assistant/CoverCard.vue src/views/FileFinder/assistant/workspace.css
git commit -m "feat(cover-ui): 卡片动作位（抽帧/换一帧）与帧状态判定"
```

---

### Task 7: 面板接线（第三个 job、批量抽帧、离线禁用、自动带盘）

**Files:**
- Modify: `src/views/FileFinder/AssistantCoverModal.vue`
- Modify: `src/views/FileFinder/index.vue`（`onMoreSelect('cover')` 传 `currentPath`）

**Interfaces:**
- Consumes: `actionOf` / `CoverItem.frame`（Task 6）、`POST /assistant/frames` + `POST /assistant/jobs(kind:'frame')` + `/assistant/apply{jobIds}`（Task 3/4/5）
- Produces: `setShowModal(v: boolean, picks?: FacePick[], presetPath?: string)`

- [ ] **Step 1: 第三个 job + 帧行状态**

`const {job: frameJob, track: trackFrame, …} = useAssistantJob(onFrameSettled, …)`；`frameRows = ref<FrameRowLike[]>([])`；`items` 的 `buildCoverItems` 入参改成 `[...grabRows, ...frameRows]`；`busy` / `selLocked` 加入 `isLiveJob(frameJob)`；`setShowModal` 的"挂回在跑任务"里加 `kinds: grab|apply|frame`。

- [ ] **Step 2: 单卡与批量共用一份启动实现**

```ts
const startFrame = async (list?: ScanTargetLike[]) => { … }
```
单卡传该卡的全部 writeRel 对应 targets + `appendTo: frameJob?.id`（有则续）；批量传"没有可用封面"的全部卡。**两处调用同一函数**，不写第二个。

- [ ] **Step 3: 回填 + 帧预览地址**

`runScan` 成功后追加 `POST /assistant/frames {serial}` → 写入 `frameRows`（按 writeRel 覆盖旧的）。`coverSrc` 计算：`item.frame ? apiUrl(`${API_BASE}/assistant/frame?serial=${serial}&f=${item.frame.file}`) : previewSrc(item.coverUrl)`。

- [ ] **Step 4: 底栏批量按钮 + 离线禁用（Review Focus 5）**

`idle` 态加 ghost 按钮「没封面的 N 部抽帧」（N>0 才出）；`counts` 无需改（`ok` 已被算进 ready）。`const canOperate = computed(() => selectedDisk?.online !== false)`，离线时禁用「开始抓取 / 抽帧 / 确认写入」，`title` 写「这块盘现在不在线，插上盘再操作」，`扫描` 保持可点。

- [ ] **Step 5: `apply` 传 `jobIds`**

`startApply` 里 `jobIds = [grabJob?.id, frameJob?.id].filter(Boolean)`；删除对 `grabJob` 的硬依赖。

- [ ] **Step 6: 自动带盘**

`index.vue:1634` 改成 `assistantModal.value?.setShowModal(true, undefined, currentPath.value)`。面板内 `loadDisks()` 之后：`if (!picks && presetPath)` ⇒ `resolveDriveContext({ currentPath: presetPath })` ⇒ 命中且 `disks.find(d => d.serial === ctx.serial)?.online !== false` 才 `selectedSerial = ctx.serial`；否则保持 `null`。

- [ ] **Step 7: typecheck + 真机目视**

Run: `npm run typecheck` → 0 error；重启 dev
Expected（目视）：① 在某盘某目录右键→补封面，盘选择器**已选中该盘**且清单直接是它的；② 拔盘后同一入口进来 → 盘选择器**空**（与改前一致）；③ 离线盘上三个按钮灰、扫描可点

- [ ] **Step 8: 提交**

```bash
git add src/views/FileFinder/AssistantCoverModal.vue src/views/FileFinder/index.vue
git commit -m "feat(cover-ui): 面板接入抽帧 job、批量抽帧、离线禁用、自动带上当前盘"
```

---

### Task 8: 设置页「抽帧缓存」区块

**Files:**
- Modify: `electron/server/assistant/frame.ts`（`inventory` / `verify` / `purge`）
- Modify: `electron/server/assistant/index.ts`（三个路由从 501 换成真实实现）
- Create: `src/views/Settings/FrameCacheBlock.vue`
- Modify: `src/views/Settings/GeneralPanel.vue`（挂一行）
- Modify: `src/views/FileFinder/AssistantCoverModal.vue`（顶栏「旧帧 N」+ 每天一次提醒）

**Interfaces:**
- Produces（HTTP）:
  - `POST /assistant/frames/inventory {}` → `{ total, bytes, items: [{ file, serial, bytes, mtime, pct, attempt }] }`（**只返回孤儿**）
  - `POST /assistant/frames/verify {}` → 同形状（对在线盘把 `live` 里盘上已不存在的改判孤儿后合并）
  - `POST /assistant/frames/purge { files: string[] }` → `{ removed, freed, skipped }`

- [ ] **Step 1: `inventory`（零读盘，Review Focus 4）**

对 `loadMeta()` 里出现过的每个 serial 跑 `scanMissingCovers(serial,'')`，把每张卡 `key16Of(cardKeyOf(t))` 收进 `Set`；`readdir` `frames/<serial>`（不存在则跳过），文件名键不在集合 ⇒ 孤儿。**不要套 `MAX_DOCS` 截断** —— 用不设上限的取文档路径（spec §7.6 的警告），否则超出上限的卡会被误判。

- [ ] **Step 2: `verify`（需在线，只 stat）**

对每个仍 `live` 的项，从级一映射拿 `ScanTarget`，`stat(盘符/对应真实路径)`（`kind:'file'` 查 `srcRel`，`kind:'dir'` 查目录），`ENOENT` ⇒ 并入孤儿。盘离线的项跳过，回 `offlineSkipped: number`。

- [ ] **Step 3: `purge`（不信任前端）**

重算 inventory（+对在线盘顺手 verify），只删落在孤儿集合里的；其余 `skipped++`；文件名过白名单正则。

- [ ] **Step 4: 前端区块**

`FrameCacheBlock.vue`：头部 `抽帧缓存 · 12 张 · 3.1 MB`（有孤儿时追加 `· 4 张无引用`）+ 一行过滤（盘 `全部/D/E…`、状态 `无引用/在用`）+「查看无引用的 N 张」就地展开列表（`<img src="/assistant/frame?...">` + `盘 · 抽于 MM-DD · 1.2MB` + 勾选，默认全选）+ 底部 `清除选中 N 张（释放 X MB）` 与 `用实时清单核实`（离线置灰）。清除后 `notify('success', …)` 并就地刷新。

- [ ] **Step 5: 挂到通用面板 + 面板提醒**

`GeneralPanel.vue` 在"备份与迁移"下方挂 `<FrameCacheBlock />`。补封面面板扫描完成后若孤儿数 > 0：`notify('warning', '抽帧缓存有 N 张用不到了', '设置 → 通用 可清理 · X MB')`，顶栏 meta 加可点文字 `旧帧 N` → `router.push('/settings')`；提醒按 `localStorage['ff.frameCleanupNotified']` 每天最多一次（全局，不按盘）。

- [ ] **Step 6: 验证**

Run: `npm run typecheck` → 0 error；重启 dev
Expected（目视）：① 设置→通用 出现「抽帧缓存」，数字与 `~/.file-finder/frames` 实际张数一致；② 点「用实时清单核实」前后数字变化合理；③ 清除后目录里文件真的少了、盘上文件一个没动

- [ ] **Step 7: 提交**

```bash
git add electron/server/assistant/frame.ts electron/server/assistant/index.ts src/views/Settings src/views/FileFinder/AssistantCoverModal.vue
git commit -m "feat(settings): 抽帧缓存盘点与清理（零读盘级一 + 在线核实级二）"
```

---

## 收尾（不算任务，交付前自查）

- [ ] `npm run typecheck` 0 error；`npm run build` 前先关掉运行中的 app（旧 exe 里 ffmpeg 起不来）
- [ ] spec §八 的读盘清单与实际实现逐条对上（尤其 `kind:'dir'` 的 1 次 readdir、`verify` 的 stat 次数）
- [ ] 真机回归：抽帧 → 换一帧 3 次 → 写入 → 盘上有封面且分卷全在 → 再扫描该目录不再报缺封面
- [ ] 脱敏扫描后再 `git commit`（探针输出不得含真机路径/番号）
