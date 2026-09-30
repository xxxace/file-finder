# 管理助手 · 确认界面 + 写盘（Phase 5 / 含原 2B）开工件

> 新会话开工读这一份就够。别重读全仓。

## 0. 一句话目标
给管理助手补上**人能看、能点**的那一环：全屏面板列出"没封面的片子"→ 默认全选 →
点确认 → 抓封面 → **写进盘** → 列表立刻长出脸。之前一切抓取能力都已落地并真机实测过（命中 92%），
缺的只是 UI 和"写盘"这最后一步。

## 1. 已锁定的决策（**不要再问用户，别推翻**）
- **默认全选 → 一键确认**（用户原话："先让用户确认哪些是要去匹配的，哪些不要，默认都要匹配不就好啦"）。
- **不拆 `unmatchedDirs`**：unmatched 混着目录也**保持现状**（用户否决："不需要搞这么复杂，找不到就找不到又不是天塌了"）。unmatched 在界面里只做一个"认不出番号 N 条"的可折叠小字区，**不做逐条操作**。
- **写盘只写封面文件**（`<视频同名>.jpg` 或 `<影片目录>/cover.jpg`，判据已在 `scan.ts` 算好 `writeRel`）。不做移动/改名/文件夹化。
- **认不出番号的一律回归人工**，不做关键词乱搜；"从视频抽帧"是后备方案，**本轮不做**（用户已接受舍弃）。
- FC2/javdock：**不主动加**。javbus 不收 FC2 这事实已记录在 PRD §17，用户没提就不动。
- 应用是**浅色**主题（`App.vue` 无 darkTheme），无 vue-router，弹层用全屏 `n-modal`。

## 2. 现状（全部已落地、typecheck+build 绿）
后端（`electron/server/assistant/`）：
- `POST /assistant/scan {serial, relPath}` → `{targets, unmatched, skippedCategory, scannedDocs}`（**零读盘**，targets 里每条带 `writeRel`）
- `POST /assistant/jobs {kind:'grab', serial?, relPath?, targets?, siteIds?}` → `{jobId,total}`；`GET /assistant/jobs?id=` 轮询快照；`DELETE /assistant/jobs?id=` 取消
- `POST /assistant/dryrun {siteId, query}` 单站试抓（不写盘）
- `POST /assistant/jobs {kind:'challenge', url?|siteId?}` 人工过 CF（可见窗，5 分钟）
- job 快照字段见 `jobs.ts` 的 `snapshotJob`（白名单，别绕过）
- ⚠️ `route()` **精确匹配 pathname，不支持 `/:id`**，参数一律 `?id=` / body

前端：目前**没有任何入口**。`src/views/FileFinder/index.vue` 是主界面（naive-ui）。

## 3. 本轮要做的两件事（顺序固定）
### 第 1 步：确认界面（纯读，不写盘）
- 全屏 `n-modal`，入口放 FileFinder 工具条（一个按钮，文案如"补封面"）。
- 打开 → 调 `/getDisks` 选在线盘（**多盘时给用户选**，别自作主张）→ `POST /assistant/scan`。
- 列表 = `targets`（默认全选，可单条取消勾选，显示 `dir/name → writeRel`）；底部显示"认不出番号 N 条（已跳过，可之后手动填）"。
- 「开始抓取」→ `POST /assistant/jobs {kind:'grab', targets: 勾选的}` → 轮询显示 `processed/total/hits`，可取消。
- 被 CF 拦的行给一个"人工过验证"按钮 → `kind:'challenge'`。
- **抓完只展示结果，不写盘**（第 2 步才接写盘）。这一步独立可验收。

### 第 2 步：写盘 apply（原 Phase 2B）
- 新端点 `POST /assistant/apply {jobId}`（或直接 targets）：**必须走 job 化**（`jobs.ts` 加 `kind:'apply'`）。
- 下载封面图 → **转真 JPEG**（别直接落 webp/png）→ **目标目录内 `tmp` → `rename` 原子写** → `removeCache(serial, dir, 'cover')` 失效该目录缓存（**不失效 UI 就是旧脸**，PRD 三方评审修正②）→ 追加 `apply.log`。
- 失败不中断整批，逐行记结果；**不做回滚**（只新增文件，最坏情况是多了几张 jpg，用户手动删）。
- 界面在第 1 步的面板上加最终「写入」按钮 + 逐行结果。

## 4. 验收（AC）
1. 不插盘也能打开面板、看到清单（scan 零读盘，拔盘可跑）。
2. 默认全选；取消勾选的不会被抓。
3. 抓取有进度、能取消；被 CF 拦能弹窗人工过一次然后继续。
4. 写入后**不需要重启**，回到那个目录封面立刻出现（`removeCache` 生效的证据）。
5. 全程只新增封面文件，不改名、不移动、不删任何东西。
6. `npm run typecheck` + `npx vite build` exit 0。

## 5. 探针 / 自测（沿用，别重造）
- `docs/probes/phase2a-selftest.js`（DevTools 粘贴，零占位符）
- `node docs/probes/scan-rules/run.mjs`（规则回归）、`node docs/probes/parse-title/run.mjs`（20/20）
- `node docs/probes/scan-real/run.mjs <serial>`（真数据分布，**零读盘**）
- 铁律：改解析/扫描逻辑必跑上面三个探针；验证脚本必须先拿"已知存在的 ID 当控制组"。

## 6. 给用户的交互口径
他不懂技术、有 ADHD：交付时**结论一行 + 一张图 + 需要他做的动作一行**；过程和细节全写进本文档或 PRD，别贴日志。

---

## 7. 实施记录（2026-09-25，代码层完成；真机未验）

### 第 1 步：确认界面 ✅
- 新组件 `src/views/FileFinder/AssistantCoverModal.vue`（全屏 `n-modal`，全程裸 flex，不用 n-space）。
- 入口 = FileFinder 工具条常驻按钮「补封面」（子元素个数恒定，不破坏工具条铁律）。
- 流程：打开 → `/getDisks`（只有一块盘自动选；多盘用户选）→ `POST /assistant/scan` → targets 默认全选可单条取消 → 「开始抓取」→ `POST /assistant/jobs {kind:'grab'}` → 1.2s 轮询进度、可取消 → unmatched 只做折叠小字区。
- 被 CF 拦：底部出现「人工过验证并重抓（N 条）」→ `kind:'challenge'`（按 `GrabRow.blockedSite` 定站点）→ 过完自动**只重抓被拦的那批**。
- 面板关闭不杀任务：重开时 `GET /assistant/jobs` 挂回正在跑的 job。

### 第 2 步：写盘 apply ✅
- 新模块 `electron/server/assistant/apply.ts`；`POST /assistant/apply {serial, jobId}`（走 `startJob` 分发，job kind=`'apply'`）。
- 链路：从 grab job 取命中行（**不信任前端转发的 URL 列表**）→ `net.request` 下载（**Chromium 网络栈 + `persist:assistant` session**，CF cookie 自动带上）→ 转真 JPEG（JPEG 本尊原样落盘；nativeImage 解不动的走 ffmpeg 兜底 = `thumbnail.ts` 的 `transcodeImage`，已 export）→ **目标目录内** `.cover-*.tmp` → `rename` 原子写 → `removeCache` 失效 → 追加 `apply.log`。
- 失效范围：文件形态失效所在目录；目录形态（basename=cover.jpg）**多失效父目录**（目录的脸长在父目录的缓存里）。
- 失败逐行记结果、不中断、不回滚。写完 emit `refresh`，主界面正常取数（不带 noCache）→ 新封面立刻出现（AC-4 的证据路径）。

### ⚠️ 踩坑（记档）
- **Electron 44 的 `net.fetch` RequestInit 类型没有 `session` 字段** → 下载改用 `net.request`（类型和运行时都支持 `session` + `useSessionCookies`）。

### 自测清单（真机，照 AC 走）
1. 不插盘开面板看清单（AC-1）；2. 取消勾选的不被抓（AC-2）；3. 进度/取消/CF 人工过一次（AC-3）；
4. 写入后回目录封面立刻出现、不用重启（AC-4）；5. 盘上只多了封面 jpg（AC-5）；
6. `apply.log` 在数据目录（`~/.file-finder/apply.log`）。

### 真机反馈修复（2026-09-25 晚，二轮）
1. **「写入启动失败 未知任务类型：(空)」**：`/assistant/apply` 曾错接 `startJob` 的 kind 分发器，
   而 apply 的 body 只有 `{serial, jobId}` 没有 kind。修 = 专用端点直接调 `startApply`，不过分发器。
2. **抓取提速（用户要求并发）**：串行 → **有界并发 5**（`grab.ts` 的 `GRAB_PARALLEL`，唯一旋钮）。
   `queue.ts` 新增 `runPaced`（只守同主机 1.5s 发起间隔、不排队）；同番号 memo 改 Promise 形态，
   并发撞号只发一次请求。**写盘仍全局串行**（动硬盘的串行是硬件保护）。
   同主机请求到达节奏不变 —— 提速来自"慢页面重叠加载"，不是把请求打得更密。

### 三轮：命中缓存落盘 + 封面预览（2026-09-25 晚）
1. **番号命中缓存**（新 `electron/server/assistant/hits.ts`）：命中结果追加到
   `~/.file-finder/assistant-hits.jsonl`（JSONL 只追加、崩溃最多丢一行）。下次抓取
   （含中断/重启后重抓）先查缓存：命中直接复用 URL，**秒回、零网络**。
   - 只缓存命中不缓存失败；URL 永久失效（HTTP 非 200 / 图解不开）时 apply 追加
     **墓碑行**，下次抓取自动重新真抓。**永不物理删除**。
   - ⚠️ 这只是**文本缓存**（URL），移动硬盘零写入 —— 写盘仍只有手动点「写入封面」才发生。
2. **封面预览确认**：结果列表给命中行加缩略图（`referrerpolicy="no-referrer"` 防外链检测），
   写盘前后都能对图核对 —— 「看一眼图再点写入」就是确认环节。

### 四轮：写入 = 确认弹窗 + 文件夹化搬迁 + 分卷归一（2026-09-25 晚，用户拍板）
> ⚠️ **本节取代 §1 里"写盘只写封面文件、不做移动/改名/文件夹化"的旧决策** —— 用户明确改要 Folder 化。

1. **写入确认弹窗**：点「确认写入…」→ 二级 modal，grid **一部片一张卡**（缩略图 + 番号 +
   分卷数），默认全勾、可反选/全选/全不选。不勾的**不写也不搬**。确认后把勾选覆盖的
   writeRels 作为 `picks` 发 `POST /assistant/apply`，后端按 picks 再过滤（不信任前端 URL）。
2. **文件夹化搬迁**（apply 重写为分组制）：
   - 文件形态（裸视频散在层里）：`mkdir <番号>/` → 全部分卷 `rename` 进去（同盘瞬时、不复制
     数据）→ 封面写 `<番号>/cover.jpg`。上一层从此是一张带脸的文件夹卡。
   - 目录形态（`TST-088/` 已存在）：不搬，只补 `cover.jpg`。
   - 冲突一律跳过并记录（目标同名已存在 / 源已不在），不覆盖、不删除、不中断、不回滚。
   - 为此 `ScanTarget`/`GrabRow` 新增 `srcRel`（源视频完整相对路径含扩展名）。
3. **分卷归一**：`AAA-123-A/B`、`TST-014-01…08` 在 `parseTitle` 就剥掉后缀归一到同一番号
   （**一直如此**），memo 保证只发一次请求；分组建文件夹会把全部分卷一起带上。
   4 条新用例已锁进 parse-title 探针（现 24/24）。

### 五轮：深度重扫（删图后扫描识别不到）—— **零抽帧版**
- **根因**：扫描零读盘、只认缓存。apply 失效过又没人浏览的目录对扫描**完全不可见**；
  手动删图后缓存还停在"有脸"。
- **终版修法（用户拍板"不要抽帧"）**：`POST /assistant/rebuild {serial, relPath?}` ——
  apply.log 里的层用**纯 readdir+stat 实时清单**（`liveList`，不生成缩略图、不抽帧、
  **不写缓存**）替换缓存旧貌，再跑**同一套规则**（`evaluateDocs`，从 scan.ts 抽出的
  唯一评估函数，缓存扫描与深度重扫共用）。
  - "子目录有没有脸" = 2 次 stat 探 `avatar.jpg`/`cover.jpg` 固定名，与 `makeDirCover`
    同一判据；不收敛封面条目，结果与收敛形态一致（有脸子目录被 avatar 检查挡住）。
  - 盘不在线 → refreshed=0，退化为普通缓存扫描。
  - ⚠️ 中间版本（走 `scanAndCache` 重建、带抽帧、注入 rebuildDir 依赖）已整体撤销。
- **不覆盖**：非助手写入的目录被手动改 → 仍走主界面「重读这一片」（缓存体系的既有答案）。
- ⚠️ **不变量（真机踩出来的）**：实时探查**只对没脸的子目录**进行 —— 有脸的目录在缓存世界
  从不拥有自己的文档（收敛成封面卡后不再下钻），规则因此从不会看到有脸目录的内部；
  实时清单必须恢复同一不变量，否则有封面的全被误报成"影片目录"（2026-09-25 真机实测）。
- ⚠️ **"有脸"的正确定义（第二轮真机踩出来的）**：= **handleCover 收敛成功** = 纯文件目录
  里有**任何一张图片**（`server/index.ts:357` 的图片正则），**不是**只认 `avatar.jpg`/
  `cover.jpg`。片子文件夹自带 `番号.jpg` 是常态。`liveHandleCover` 逐字复刻其形态判断
  （只摘掉缩略图生成），`avatar` 固定名探测只用于"有子目录的目录"（makeDirCover 判据）。

### 六轮（grill-me 问清后做）：封面同名化 + 预览代理
- **用户拍板**：封面与文件夹**同名**（`AAA-123/AAA-123.jpg`）；`cover.jpg`/`avatar.jpg`
  是"目录头像"保留名，**助手永不写**（用户视 cover 等同 avatar，之前写的他已手动删除）。
  - scan 的 dir-form 目标 writeRel = `<目录名>.jpg`；`GrabRow` 新增 `kind`（透传），
    apply 分组改用 kind 判形态（同名后文件名猜不了）。
  - file-form 组封面 = `<layer>/<番号>/<番号>.jpg`。探针期望同步更新（锁新行为）。
- **预览代理**：`GET /assistant/preview?url=`（复用 apply 的 `download`：同一条 Chromium
  session 通道 + 100 条 FIFO 内存缓存）。渲染层 <img> 全部走代理 —— 直接 <img> 外站图
  会被防盗链拦（真机 2026-09-25），且代理保证"预览能显示的就一定能写入"。

### 七轮：写入后被重新识别（根修）+ 搬迁转大写
- **根因**：rule ①（影片目录折叠）不检查文件夹里是否已有图片。普通扫描靠"有脸目录没有
  自己的文档"的不变量躲开；深度重扫故意看进写过的目录就撞盲区 —— 分卷名≠封面名
  （大小写/尾缀），刚写过的原样再报。**大小写和 ABC123 尾缀是同一个洞的两个表象。**
- **根修**：折叠前 `hasImage` 闸门（有图片=有脸，handleCover 收敛判据），写进规则本体，
  缓存扫描与深度重扫共用。
- **搬迁转大写（用户拍板）**：仅助手搬迁分卷时，主名英文字母转大写（a1b1.mp4→A1B1.mp4），
  扩展名不动；dir 形态原地文件不碰。
- **已知边界（非 bug，不修）**：apply.log 永久追加（深度重扫目录清单随之增长，但只是
  readdir）；非助手写入的目录被手动改仍走主界面「重读这一片」。
