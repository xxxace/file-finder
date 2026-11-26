# 补封面：卡顿 / 终止杀不掉 / 无超时 / WAF 白等（2026-11-23）

主人四条反馈 + 两条追加（熔断不可用、暂停文案）。**证据等级**：静态 / 推理 / 实测，逐条标注。

| 症状 | 根因 | 修法 |
|---|---|---|
| ① 卡顿 | 被拦站点每条**白等 20 秒**；失败时**每条**序列化 800KB HTML 快照（`grab` 从不读）；`toJpeg` 跑在并发槽**之外** | WAF 4 秒放弃；`captureSnapshot:false`；转码移进槽 |
| ② 终止杀不掉 | ffprobe/ffmpeg 不接 signal；`passChallenge` nav sleep 不带 signal；`net.request` 无内建超时 | 全接 signal / `SIGKILL` / `download` 内建 20s |
| ③ 超 45 秒 | ⚠️ **deadline 只是个数字**：只在"回到循环条件"时读一次，`executeJavaScript` / `loadURL` / `download` 正在 await 时它毫无作用；图片验证还用的是 `job.controller.signal`（预算管不到） | 预算做成 **AbortController → AbortSignal**，与取消信号合并后贯穿所有 await |
| ④ 中途报错还在等 | 完全不看 `did-fail-load`：`SSL handshake failed … net_error -100`（ERR_CONNECTION_CLOSED）这种"注定打不开"的页面会被轮询到预算耗尽 | `watchNavFailure` + `FATAL_NAV_ERRORS` 立即收工，`webContents.stop()` |
| ⑤ 只认 CF | 判据只覆盖 CF 三个信号，认出来还要等满 20 秒 | `WAF_DETECT` 扩到 DDoS-Guard / Imperva / PerimeterX；403/429/503 也算被拦 |

## 一、45 秒预算的**正确**实现

```
grabCard()  领取这张卡
  ├ budget = new AbortController()；45 秒后 budget.abort()
  ├ merged = combineSignals(job.controller.signal, budget.signal)    ← 任一 abort 即 abort
  └ outcomeOf(id, deadline, merged.signal)
       └ fetchOnce(id, deadline, signal)
            ├ runExtract / runSteps({ signal, deadline })
            ├ enqueueWithRetry(..., signal, deadline)
            └ getVerifiedCover(url, signal)      ← 以前这里是 job.controller.signal（漏网）
```

- `deadline`（数字）只负责**分配**：还有没有时间试下一站。
- `signal` 负责**掐断**：到点直接 abort，`onAbort` 销毁窗口、`download` 自行 reject。
- `Promise.race` 的 `BudgetExceeded` 负责**兜底**：万一某个 await 漏接 signal，
  worker 也不会被拖住 —— 45 秒一到就放行到下一张（这就是主人要的「超时熔断」）。
- 只有数字 = 只能"检查点式"超时，一次长 await 就能把 45 秒撑到 70 秒
  （2026-11-23 主人在真机抓到，这也是上一版"45 秒已是硬上限"错在哪）。
- 预算到点 / 用户取消 / 暂停，三者必须分开：`BudgetExceeded` = 这一卡判超时；
  `CancelledError + job.cancelled` = 终止；`CancelledError + !job.cancelled` = 暂停归还。

## 二、暂停：**立刻中断在飞**（2026-11-23 第三版定稿）

- `pauseJob`：`gate.pause()` + **先 abort 再换代 controller**。在飞请求立刻断，
  worker 捕获 `CancelledError && !job.cancelled` ⇒ 把条目放回队首 ⇒ 停在闸门前。
- **终止**（`cancelJob`）语义不变：立刻 abort、不再继续，已产出的行全保留。
- ⚠️ **别信"跑完即停"**：那是 11-08 的旧裁决，也是上一版界面上句谎话 ——
  主人照着它看到「已暂停 0 / 4」却还在跑。现在文案写「在飞的已停下，结果都留着」，
  与行为一致（**文案即契约**）。
- 语义历史：11-08 不掐断 → 11-23 上午立刻断 → 11-23 晚误回退到不掐断（被旧裁决带偏，
  主人当场打回「怎么还在跑」「别给旧的上下文影响了你」）→ **现在：立刻断，别再改**。

## 三、WAF 与"打不开"

- `WAF_GIVE_UP_MS = 4s`：连续 4 秒判挑战页 ⇒ 直接放弃本站（交互式挑战隐藏窗过不去）。
- **不做整站熔断**（初版加过，当天撤）：抓取 5 并发，"连续两次拦截"在并发下实际是
  **同一瞬间 5 张卡一起撞墙**，一眨眼整站判废；而 CF 常只拦部分详情页。
  省时间靠 4 秒放弃 + 45 秒预算：整站被拦的代价 = 4 秒/卡 ÷ 并发。
- `FATAL_NAV_ERRORS`（-100/-101/-102/-105/-107/-113/-118/-200/-202）：主框架连不上就**立刻**
  返回 `err:'net'` 并 `webContents.stop()` —— 不重试、不刷握手日志，界面显示真实原因。

## 四、抽帧子进程

`thumbnail.runFfmpeg` / `probeSeconds` 增加可选 `signal`：abort 时 `SIGKILL`。
`probeDuration` 中断后不再打第二次。`frameJpegAt` / `probeVideoSeconds` / `transcodeImage` 透传。

## 五、证据等级

- 静态：逐行核过；`npm run typecheck` 0 error。
- 实测：主人真机报"**超过 45 秒**"+"SSL 握手失败刷屏"—— 两条都已定位到上文 ③④ 的漏点。
- 推理：暂停/终止时序、"预算到点 vs 用户取消"的区分。
- 未实测：修完后 45 秒的实测耗时、`did-fail-load` 在各站点上的覆盖、WAF 正则对新站覆盖率。

## 六、待真机确认

1. 被拦 / 连不上的站点不再让整批卡住超过 45 秒（进度应持续前进）；
2. 报"打不开页面（…握手失败）"的行**立刻落表**，不再空转；
3. 暂停：在飞几条出完结果就停，`已暂停 x / y` + "结果都留着"；
4. 终止：1 秒内停，已命中的行仍在。
