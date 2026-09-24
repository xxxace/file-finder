# 第二批 · 任务 B：ffprobe 超时修复（2026-09-24）

> 规格来源：`docs/UPGRADE-PLAN-2026-09-24.md` **§16.2**（任务 B）、**§13**（实测取证）、**§1.4**。
> 改动范围：**只有 `electron/utils/thumbnail.ts` 一个文件**（+92 / −5）；另新增验证资产在 `docs/probes/`（规格要求的探针）。
> **未 `git commit` / 未 `git push`。**

---

## 〇、一句话结论

把"先起一个够不着的 ffprobe 拿时长"换成"**自己 spawn ffprobe（自带 20 秒超时、自带 pid）
→ 把时长换算成数字秒传给 `screenshots`**"。这样命令里只剩 ffmpeg，超时窗口覆盖全程。

**但是：最关键的"超时真的杀掉卡住的 ffprobe"这条，我没能实测** —— 本机沙箱禁止创建任何子进程
（`spawn` 一律 `EBUSY`，`dangerouslyDisableSandbox` 也拿不到），详见 §四。**不许把推理当实测，所以单列出来。**

已经**真跑并拿到原始输出**的两条：
- `tsc -p tsconfig.electron.json` → **exit 0**（输出 0 字节）
- **分支决策探针** → 传数字时 fluent-ffmpeg **不再调用内部 ffprobe**，命令行是 `-ss 0.42`；
  传 `'1%'` 时**会调用内部 ffprobe**。这是本次修复的核心机制，**已实测**（§三.2）

---

## 一、改动逐处说明

### 改动 1 / 4 —— 新增 `import { spawn } from 'node:child_process'`

```diff
 import os from 'node:os';
 import path from 'node:path';
 import * as fsasync from 'node:fs/promises';
+import { spawn } from 'node:child_process';
```

**为什么**：`ffmpeg.ffprobe()` 不能用了（改动的理由见改动 3），必须自己起进程、自己拿 pid。

### 改动 2 / 4 —— `FFMPEG_TIMEOUT_MS` 的注释（**值不变，仍是 20000**）

只动注释，两处：
- 首行 "ffmpeg 子进程超时…抽帧和图片转码共用" → "**外部子进程超时**…**ffprobe 探测、抽帧、图片转码三处共用**"
- 末尾补一段说明：ffprobe 与它后面的 ffmpeg 是**两段独立的 20 秒**，最坏 40 秒，**刻意为之**（见 §五 偏离第 3 条）

**为什么**：注释是下一个人唯一的护栏。值一个字符都没改。

### 改动 3 / 4 —— 新增 `probeDuration()`：自己 spawn ffprobe

```ts
function probeDuration(filepath: string): Promise<number | null> {
    return new Promise((resolve) => {
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;

        const child = spawn(ffprobePath, [
            '-v', 'error',
            '-show_entries', 'format=duration',
            '-of', 'default=noprint_wrappers=1:nokey=1',
            filepath,
        ], { windowsHide: true });

        const finish = (seconds: number | null) => { /* settled 保证只 settle 一次 */ };

        let stdout = '';
        child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
        child.on('error', (e: Error) => { console.error(...); finish(null); });
        child.on('close', (code) => {
            if (code !== 0) { finish(null); return; }
            const seconds = Number(stdout.trim());
            finish(Number.isFinite(seconds) && seconds > 0 ? seconds : null);
        });

        timer = setTimeout(() => {
            console.error('[thumbnail] ffprobe 超时，已终止子进程:', filepath);
            try { child.kill('SIGKILL'); } catch { }
            finish(null);
        }, FFMPEG_TIMEOUT_MS);
    });
}
```

**为什么这样做**（对应 §16.2 修法第 1 条）：
- `spawn` 的返回值就是我们**自己持有的句柄** → `child.kill()` 作用在确切的那个 pid 上。
  这跟 `cmd.kill()` 的差别是结构性的：后者要先赌命令对象里存着 pid，而 ffprobe 阶段它是 `undefined`
  （`processor.js:445,653`；§13.1 证据 3）。
- **取不到时长返回 `null`，调用方返回 `false`** —— 与今天的行为一致，**不退化成固定时间点**。
  所有失败路径（启动失败 / 非 0 退出 / 输出不是正数 / 超时）都归到 `null`。
- 只查 `format=duration`：ffprobe 读的是**移动硬盘上的源文件**，这是"拿到时长"的最小查询
  （不抄 `ffmpeg.ffprobe()` 默认那份 `-show_streams -show_format` 全量元数据）。见 §五 偏离第 2 条。

### 改动 4 / 4 —— `extractFrame()` 改成"先自己拿时长 → 传数字秒"

```diff
-/** 取一帧（视频缩略图用）。`screenshots()` 内部会自己 `run()`，所以拿回来就能挂监听 */
-function extractFrame(filepath: string, frame: string): Promise<boolean> {
+async function extractFrame(filepath: string, frame: string): Promise<boolean> {
+    const duration = await probeDuration(filepath);
+    if (duration === null) return false;
+
     return runFfmpeg(
         ffmpeg(filepath).screenshots({
-            timestamps: ['1%'],
+            timestamps: [duration * 0.01],
             filename: path.basename(frame),
             folder: path.dirname(frame),
         }),
         '抽帧',
         filepath
     );
 }
```

**为什么**（对应 §16.2 修法第 2、3 条）：
- **`'1%'` 必须去掉**，否则 `computeTimemarks`（`recipes.js:169` 的判据
  `timemarks.some(t => /^[\d.]+%$/.test(t))`）为真 → 内部再起一个 ffprobe。
  注释里把这条链路和后果写全了（函数 docblock，第 250-270 行），**防止下一个人改回去**。
- **时间点仍是「时长的 1%」**：`duration * 0.01`，不是固定秒数。1% 是刻意选的（躲开片头黑场），语义原样保留。

### 未改动的（规格明确要求保住）

| 项 | 状态 |
|---|---|
| `FFMPEG_TIMEOUT_MS = 20000` | ✅ 值未变 |
| `scaleToThumb` / `THUMB_WIDTH` / `THUMB_QUALITY` 链路 | ✅ 一个字符未动 |
| `imageThumb` / `transcodeImage` / `videoThumb` 逻辑 | ✅ 未动（`videoThumb` 只是经由 `try/finally` 调用 async 的 `extractFrame`，本来就 `await`） |
| `CACHE_VERSION` | ✅ 未升 |
| 其它任何文件 | ✅ 未改（`git status` 里别的改动是上一批 P0 留下的，非本次产生） |

---

## 二、类型检查（真跑）

```
$ "C:/Users/<user>/.workbuddy/binaries/node/versions/22.22.2-3/node.exe" \
    node_modules/typescript/bin/tsc -p tsconfig.electron.json > out 2>&1; echo "exit=$?"
exit=0
```

原始输出文件：`docs/probes/out-tsc-electron.txt`，**0 字节**（无任何诊断）。
未接管道（`> file 2>&1; echo exit=$?`，退出码取的是 tsc 的）。

---

## 三、实测

### 三.1 探针清单

| 文件 | 作用 | 状态 |
|---|---|---|
| `docs/probes/ffprobe-timemark-branch.mjs` | 证明"传数字 → 内部 ffprobe 不被调用；传 `'1%'` → 被调用" | ✅ **已跑，exit 0** |
| `docs/probes/ffprobe-timeout-fix.mjs` | 回归（正常文件出图）+ 修复（超时杀掉卡住的 ffprobe） | ❌ **未能运行**（EBUSY，见 §四） |
| `docs/probes/esm-stub-loader.mjs` | 把裸模块名 `electron` 重定向到替身 | 支撑文件 |
| `docs/probes/electron-stub.mjs` | `nativeImage` 的极简替身（让纯 Node 能 import 真的 `thumbnail.ts`） | 支撑文件 |

> 探针的取向：`ffprobe-timeout-fix.mjs` **直接 import 真的 `electron/utils/thumbnail.ts`**，
> 不是把逻辑抄一份。两个障碍及绕法（Node 22 默认 type stripping 可直接 import `.ts`；
> `electron` 用 loader 换替身）。**替身只实现 `nativeImage.decode`，与 spawn/超时/杀进程无关**，
> 不参与被验证的行为。

### 三.2 分支决策探针（真跑，`exit=0`）

```
$ node docs/probes/ffprobe-timemark-branch.mjs
```

原始输出（`docs/probes/out-ffprobe-timemark-branch.txt`）：

```json
{
  "1_传数字(修复后的写法：42 秒 × 0.01)": {
    "传入的时间点": "0.42",
    "内部 ffprobe 是否被调用": false,
    "最终命令行里的 -ss 值": "0.42",
    "命令行里是否出现 % 百分比": false,
    "完整命令行": "-ss 0.42 -i C:\\Users\\<user>\\AppData\\Local\\Temp\\ffprobe-branch-dummy.mp4 -y -filter_complex split=1[screen0] -vframes 1 -map [screen0] C:\\Users\\<user>\\AppData\\Local\\Temp\\ffprobe-branch-out\\branch.jpg"
  },
  "2_传字符串百分比(修复前的写法)": {
    "传入的时间点": "\"1%\"",
    "内部 ffprobe 是否被调用": true,
    "最终命令行里的 -ss 值": "(命令行里没有 -ss)",
    "命令行里是否出现 % 百分比": false,
    "完整命令行": "-i C:\\Users\\<user>\\AppData\\Local\\Temp\\ffprobe-branch-dummy.mp4"
  }
}
```

**读法**：
- 传数字（修复后的写法）→ `内部 ffprobe 是否被调用: false`，且命令行里是 **`-ss 0.42`**
  （42 秒 × 0.01，已核对 `42 * 0.01 === 0.42` 为真）。**这就是"命令里只剩 ffmpeg"的直接证据。**
- 传 `'1%'`（修复前的写法）→ `内部 ffprobe 是否被调用: true`，此时 waterfall 卡在等元数据，
  命令行只拼出 `-i <src>`。**这就是孤儿 ffprobe 的来源，且它正是本次要去掉的那一段。**

**这个探针为什么不依赖 spawn**：`ffmpeg`/`ffprobe` 两条分支的**分叉点**在
`computeTimemarks` 的谓词上，发生在任何 spawn **之前**；探针只读这个分叉结果
（给 `cmd.ffprobe` 套一层只读探针记"有没有被调用"），并从 `cmd._getArguments()`
（fluent-ffmpeg 自带的"只算不跑"）读回命令行。所以即使本机 spawn 全 EBUSY，结论依然成立。

**证据边界（不夸大）**：本探针证明的是 **fluent-ffmpeg 的分支行为 + 我们传进去的实参形状**，
**没有**证明"真实 ffprobe 卡住时被杀了"（那是 §三.3，未测成）。

### 三.3 超时杀进程探针 —— **未实测** ❌

探针代码已写好（`docs/probes/ffprobe-timeout-fix.mjs`），设计为：
- A. `videoThumb(<42 秒 mp4>)` → 断言出图、`-ss 0.42`、**只有 1 个 ffprobe**（我们自己那个）
- B. `videoThumb('pipe:0')` → ffprobe 阻塞在 stdin 读 → 20 秒后断言
  **同一 pid 已死**（钩子）+ **tasklist 计数回到基线**（OS 层）+ 未起 ffmpeg
- 连跑 2 轮，看是否存在孤儿累积

**但它一次都没跑起来**：本机**无法创建任何子进程**。原始输出如下。

跑探针（素材生成即失败）：
```
$ node docs/probes/ffprobe-timeout-fix.mjs
(node:27600) [MODULE_TYPELESS_PACKAGE_JSON] Warning: Module type of file:///D:/code/file-finder/electron/utils/thumbnail.ts is not specified and ...
生成素材失败: undefined
```

手工复现同一句 ffmpeg（把 `error` 打出来）：
```
bin D:\code\file-finder\node_modules\@ffmpeg-installer\win32-x64\ffmpeg.exe
status null error spawnSync D:\code\file-finder\node_modules\@ffmpeg-installer\win32-x64\ffmpeg.exe EBUSY
```

确认是"所有子进程都被挡"而不是"ffmpeg 特例"：
```
where    -> status null err spawnSync where EBUSY
tasklist -> status null err spawnSync tasklist EBUSY
cmd      -> status null err spawnSync cmd EBUSY
（连 spawn 自己：spawnSync(process.execPath, ['-e','console.log(1)']) -> EBUSY）
```

加 `dangerouslyDisableSandbox` 后的两种结果（都拿不到）：
```
（一次）Error: sandbox-center cmd decisionRecord missing actual resource subject
（另一次）status null err EBUSY
```
Bash 通道与 PowerShell 通道、连试 3 次，结果一致。

> 结论：**"修复后超时能真的杀掉正在跑的 ffprobe"这条，本次没有实测证据。**
> 只有结构上的论证（`child.kill()` 作用于我们自己 spawn 出来的那个 pid）+ §13 已实测的旧行为作对照。
> **这不是实测，不许当实测引用。**

### 三.4 现有证据边界汇总（诚实版）

| 结论 | 等级 |
|---|---|
| `tsc -p tsconfig.electron.json` exit 0 | **实测**（可复算） |
| 传数字 → fluent-ffmpeg 内部 ffprobe **不被调用**；命令行 `-ss 0.42` | **实测**（`ffprobe-timemark-branch.mjs`，exit 0） |
| 传 `'1%'` → 内部 ffprobe **被调用** | **实测**（同上） |
| `42 * 0.01 === 0.42`（时间点确为"时长的 1%"） | **实测**（Node 22.22.2） |
| 修复后超时**真的杀掉**卡住的 ffprobe | ⚠️ **未实测**（环境禁 spawn），仅结构论证 |
| 正常文件修复后仍能出缩略图（端到端） | ⚠️ **未实测**（同上） |
| 修复后不再累积孤儿 | ⚠️ **未实测**（同上） |
| 新 ffprobe 查询只读 `format=duration` 这一小段 | ⚠️ **未实测**（未跑 ffprobe；命令是写死的，可静态复算） |

---

## 四、为什么实测没跑成（把结论说清楚）

规格里有一条硬约束写着："探针要跑起来必须 `dangerouslyDisableSandbox`（沙箱内 Node spawn
任何子进程都返回 EBUSY）。**如果拿不到这个权限、跑不起来实测，就如实写'未实测'**"。
本次就是这种情况：**加了 `dangerouslyDisableSandbox` 仍然 EBUSY**（一次还直接报
`sandbox-center cmd decisionRecord missing actual resource subject`）。

按约束，我没有把推理写成实测：§三.3 与 §三.4 已按"未实测"标注。
真正跑通这部分只需要一条命令（在能 spawn 的机器上）：

```
node docs/probes/ffprobe-timeout-fix.mjs
```

它会自己用 lavfi 在 `%TEMP%` 现生成 42 秒素材（**不碰 E:/ F:/**），约 65 秒跑完
（A ≈ 2s，B 两轮各 ≈ 20s）。

---

## 五、偏离规格的地方（单列一节）

规格 §16.2 的修法我基本照做，以下是**与字面不完全一致**的四处，逐条说明：

1. **用的是 `timestamps:` 而不是 `timemarks:`。**
   规格 §16.2 修法第 2 条写的是 `screenshots({ timemarks: [dur * 0.01] })`。
   fluent-ffmpeg 里两者是**同一件事**：`recipes.js:125-127` 是
   `if ('timestamps' in config) { config.timemarks = config.timestamps; }`。
   原代码用的就是 `timestamps`，为了把 diff 缩到最小（少动一行），保持 `timestamps`。
   **语义与规格完全一致。**

2. **ffprobe 只查 `format=duration`，没有复刻旧的"视频流时长优先、format 兜底"链。**
   旧链路（`recipes.js:192-195`）是 `vstream.duration` 优先，`NaN` 时退到 `meta.format.duration`。
   新实现只读 `format=duration`，取不到就 `null` → 调用方返回 `false`（不出缩略图，不报错）。
   **取舍**：`-show_streams` 要比 `-show_entries format=duration` 多读一大截容器数据，
   而 ffprobe 读的是移动硬盘上的源文件 —— 「少碰盘」是本项目最高优先级（§1、§16.2 的立意），
   所以选了最小查询。
   **已知的理论差异**：若某个文件"视频流有时长、但容器 format 没有 duration"（少见），
   旧实现可能仍能出图，新实现会返回 `false`。**未实测这类文件在实际盘上是否存在。**

3. **ffprobe 的超时也复用 `FFMPEG_TIMEOUT_MS`（20 秒）→ 最坏总耗时 20 + 20 = 40 秒**
   （旧实现是"两段共用一个 20 秒窗口"）。
   规格只说"自己带超时"+"`FFMPEG_TIMEOUT_MS = 20000` 不变"，没说两段是否共用 deadline。
   我选择**每段各 20 秒**，并在常量注释里写明理由（共用一个 deadline 会让"ffprobe 慢"吃掉
   ffmpeg 的预算，反而更容易误杀正常的抽帧）。**这是一处行为变化，主动报备。**

4. **新增了 3 个文件到 `docs/probes/`**（探针 + loader + electron 替身）与若干输出文件。
   规格的硬约束是"只允许改这一个文件"，但实测要求又明确写"新写一个探针放 `docs/probes/`" ——
   我按后者执行：**产品代码只有 `thumbnail.ts` 一个文件被改**，`docs/probes/` 下的都是新增的
   验证资产（不改任何现有文件的逻辑）。另外根目录临时日志 `log-tsc-batch2.txt` 已删除，未留残留。

---

## 六、给调度方的待办

1. ~~**复核方在能 spawn 的机器上跑一次 `node docs/probes/ffprobe-timeout-fix.mjs`**，
   把输出贴进本文件 §三.3 替换掉"未实测"。~~ → **✅ 已由调度方跑通，见 §七。**
2. 若复核发现探针本身有问题（例如 ESM 侧拿到的 `spawn` 不是钩子那一版 ——
   探针里 `0_钩子自检` 就是专门防这个的），按它的输出修探针，**不要**改 `thumbnail.ts` 的行为。

---

## 七、调度方复核（2026-09-24 17:25，独立跑，**"未实测"这一条已补齐**）

执行方当时报"探针一次都没跑起来（本机 `spawn` 一律 EBUSY）"。**在调度方这边，加了
`dangerouslyDisableSandbox` 之后能跑**，所以这条不属于"环境做不到"，只是执行方那侧没拿到权限。

**两个前置（第一次跑失败的原因，可复算）**

| 问题 | 表现 | 处理 |
|---|---|---|
| 素材生成失败 | `生成素材失败: undefined` —— 探针里用 `spawnSync(ffmpegPath, …)` 造 42 秒素材 | **改用 Bash 直接 exec ffmpeg 生成** `%TEMP%/ffprobe-fix-normal.mp4`（143,369 B / 42 s），探针见文件已存在就跳过生成 |
| 之后 | `exit=0`，全部通过 | — |

**实测原始输出**（完整在 `docs/probes/out-ffprobe-timeout-fix.txt`）

| 组 | 观测 | 结果 |
|---|---|---|
| **0 钩子自检** | ESM 侧 `spawn` 是否已被钩子替换 | `true`（不是假钩子） |
| **A 正常文件回归** | 返回值 / 耗时 / **ffprobe 被 spawn 次数** | `Buffer(14 B)` / **735 ms** / **1 次**（只有我们自己那个，**没有第二个**） |
| | 抽帧命令里的 `-ss` | **`0.42`** —— `42 s × 1% === 0.42` ✅ 抽帧位置仍是"时长的 1%" |
| | 抽帧命令完整参数 | `-ss 0.42 -i …\ffprobe-fix-normal.mp4 -y -filter_complex split=1[screen0] -vframes 1 -map [screen0] …jpg` |
| **B 超时杀进程（2 轮）** | 卡住期间 ffprobe pid 存活 | `true` / `true` |
| | 超时到点耗时 | **20048 ms / 20031 ms** |
| | **超时后同一 pid 是否存活** | **`false` / `false`** ← **修复点，孤儿不存在了** |
| | 返回值 / 是否起了 ffmpeg | `null` / **0 次**（拿不到时长就不再白起一个 ffmpeg） |

**一处证据强度的折扣（我要求的诚实标注）**：探针里的 `tasklist` 这条 **OS 层核对通道全程返回 `-1`**
（纯 Node 里 `execFileSync('tasklist')` 在本机起不来），所以"进程真的死了"只有**一条**通道：
`process.kill(pid, 0)` 判活 —— 那仍然是 OS 层的系统调用，不是钩子自说自话，**但它是单通道**，如实标注。

**结论**：`probeDuration` 的进程确实握在自己手里、超时确实能杀掉它；同时**没有**破坏
"1% 抽帧"和"只起一个 ffprobe"。**§三.3 的"未实测"由本节替代。**
