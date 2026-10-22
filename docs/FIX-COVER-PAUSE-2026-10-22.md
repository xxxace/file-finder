# 补封面 / 换封面：暂停 · 终止 · 试跑中断（2026-10-22）

> 用户原话：「无法暂停任务」／「一旦执行只能全成功和全失败……已经获取到的封面应该可以让用户
> 选择是否要写入，而不是放缓存或者是丢弃掉」／「试跑也有这些问题，一旦开始任务，就无法中断」。

## 一、根因（四条，全部静态可证）

| # | 位置 | 事实 |
|---|---|---|
| 1 | `jobs.ts` `JobStatus` | 只有 `running/done/cancelled/error`，**没有暂停态**。`cancelJob` = 立刻 `abort()` ⇒ 在飞的 5 个窗口全断。 |
| 2 | `grab.ts:278` | `if (job.cancelled) return;` —— 已经 `await` 到手的 `outcome.match` **整条丢掉**。于是 `hits=0`、`progress.hits` 不动 ⇒ 前端「确认写入」按钮根本不出现（`v-if="applyHits > 0"`）。这就是"终止 = 全失败"的直接原因。 |
| 3 | `index.ts` `dryRun` | `runSteps/runExtract` 都支持 `signal`，但这里**没传**（同文件 `pick`/`record` 都传了 `abortOnClose`）。⇒ 试跑断开连接也不会停，最长白等 `NAV_TIMEOUT(25s) + POLL_TIMEOUT(20s)`。 |
| 4 | `index.ts` `startGrab`（过验证后重抓） | 前端 `startGrab(blockedTargets)` 起**新 job**，旧 job 的命中行随之消失。**这是审查时新发现的真 bug**（不是用户报的）。 |

附带发现：
- `finishJob` 只认 `running` —— 加了 paused 后，从暂停态终止会**永久卡在 paused**（必须一起改）。
- `Promise.all` 在某个 worker 抛 `CancelledError` 时立刻 reject，而其他 worker 还在 `pushRow` ⇒ 收尾与写结果赛跑，最后几条会被"已结束"的快照吞掉。
- 暂停若恰好发生在队列跑空时，worker 会挂在闸门上 ⇒ job 永远 paused（明明没事可做）。闸门前必须先看 `next`。
- `startGrab` 冲突回 409，前端 `postAction` 只会弹一句"抓取启动失败"（拿不到 `jobId`）。
- 点「开始抓取」后 `setInterval` 第一拍在 1.2s 后 ⇒ 这段时间界面毫无反应。

## 二、三个动作的语义（这是这次的核心设计）

| 动作 | 后端 | 在飞请求 | 队列 | 已产出的结果 |
|---|---|---|---|---|
| **暂停** | `status='paused'` + `gate.pause()` | 跑完 | 原地停住 | 全部保留（并继续记录） |
| **继续** | `status='running'` + `gate.resume()` | — | 从暂停处接着跑 | 保留 |
| **终止** | `cancelled=true` + `gate.resume()` + `abort()` | 立刻中断 | 丢弃剩余 | **全部保留，可写入** |

写盘（apply）同样支持暂停：**当前这一部写完才停**（半途停在一个分组中间、分卷搬了一半更糟）。

## 三、改动

**后端**
- `jobs.ts`：`Gate`（暂停闸门，`wait()` 挂在暂停上）、`pauseJob/resumeJob/reopenJob`；`finishJob` 放行 paused；`sweep` 不淘汰 paused；`getJob<Row>()` 泛型。
- `grab.ts`：worker 循环 `先看 next → await gate.wait() → 取号`；取消时**命中照样记行**；`allSettled` 收拢；`append` 参数累加 total。
- `apply.ts`：分组前等闸门；终止文案带"剩 N 组没写"。
- `index.ts`：`POST /assistant/jobs?id=&act=pause|resume`；`dryrun` 接 `abortOnClose` 信号；`startGrab` 支持 `jobId` 追加（`reopenJob`，结果并进同一张表）；冲突 409 → 200 + `reused`。

**前端**
- `AssistantCoverModal.vue`：footer 新增 暂停/继续/终止、暂停时「写入已抓到的」、终止后「确认写入」照常可用、「继续抓未完成的（N 条）」（= 没轮到的 + 试过失败的，`jobId` 追加进同一张表）；`isLive()` 让暂停中**继续轮询**；`poll` 第一拍立刻执行；重开面板挂回 paused 任务；`pickCards` 同目标重抓取新图（后写覆盖前写、分卷不重复计数）；`writtenSet` 跨多次写入累积，确认弹窗标「已写入」且默认不勾。
- `Settings/index.vue`：试跑中同一位置变「取消试跑」。
- `request.ts`：`postAction(url, data, { signal })`。

## 四、验证

- `npm run typecheck` → 0 error。
- `node docs/probes/jobs-pause/verify.mjs` → **11/11 PASS**（纯逻辑：`import jobs.ts`，不需要 electron、零读盘、零窗口）。
  覆盖：未暂停时 `wait()` 立刻过／暂停后挂住／继续放行／终止也放行（否则 worker 永不返回）／从 paused 收尾／已结束不能再暂停终止／终止保留 rows／reopen 换新 controller（abort 过的 signal 永远 aborted）。
- **未实测**：真机点按体验（等重启 dev 后目视）。

## 五、反馈与图标（2026-10-22 追加）

**按钮 loading**：动作的可见延迟 = 一次 POST（几百 ms，换封面时更长）+ 最多 1.2s 的轮询。
不转圈就像点了没反应，所以每个动作都挂了 `acting` 状态：

- `pause` / `resume` / `stop` / `grab`（含「继续抓未完成的」）/ `apply`，同一时刻只放行一个。
- **动作后立刻 `refreshJob()`** 拉一次快照，不等下一拍轮询 —— 点了就当帧看到状态变化。
- 「终止」的转圈**保持到任务真收尾**（`settleActing()` 在轮询看到 `!isLive` 时才清）：
  后端 abort 只是开始收尾，worker 还要陆续退出，提前放开按钮会让人以为没停。
- 「开始抓取 / 确认写入」在 `poll()` 之后补一次 `refreshJob()`，否则转圈收掉的一瞬间
  footer 还停在上一阶段（会闪一下"待抓取"）。
- 关闭面板时清 `acting`，避免下次打开挂着一个假 loading。
- 顺带补上「重新扫描」「人工过验证」的 loading（后者原本只有文案变化）。

**图标**：左轨「缓存记录」`FootstepsOutline`（脚印）→ `TimeOutline`（时钟）。
它是"按时间留下来的历史扫描清单"，时钟比脚印贴切；`FolderSelector` 里那句
"脚印图标"的历史教训注释同步改成中性说法（图标已不是脚印）。

## 六、审查结论：还没做（列给主人定）

1. 「认不出番号」行没有手填番号的入口（原本文案写着"可手动填写"，是句空承诺 —— 已把文案改掉）。
   实际触发面很窄：补封面的目标在 scan 阶段已过番号闸门，换封面的目标自带 `query`。
2. 主界面「扫描」只有取消、没有暂停（它不走 job，是另一套流程）。
3. 抓取没有剩余时间估算（ETA）。
4. 结果明细不能按状态筛选（几十条以上不好找）。
