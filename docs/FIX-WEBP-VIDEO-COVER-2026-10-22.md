# webp 无缩略图 + 视频不抽帧（裂图）· 根因与修复（2026-10-22）

**症状**（业主真机反馈）：① webp 图片不支持；② 视频没封面、也不抽帧，直接是 `<img src>` 失效的裂图图标。

---

## 一、根因：一条链，两个症状

**打包版里 `ffmpeg` / `ffprobe` 根本起不来。**

`@ffmpeg-installer` 给的路径是 `path.join(__dirname, 'ffmpeg.exe')`。打包后 `__dirname` 在
`app.asar` **内部**，而 `child_process.spawn` **不经过** Electron 给 `fs` 打的 asar 补丁
⇒ 直接 `ENOENT`。

于是：

| 走哪条路 | 依赖 ffmpeg？ | 结果 |
|---|---|---|
| jpg / png 缩略图 | 否（`nativeImage` 解码） | 正常 |
| **webp 缩略图** | **是**（`nativeImage` 解不开 webp，必须 ffmpeg 转 PNG 兜底） | **全失败** |
| **视频抽帧** | **是**（ffprobe 取时长 + ffmpeg 截图） | **全失败** |

失败 ⇒ 没有 `sig` ⇒ `wire()` 不下发 `thumb` ⇒ 前端 `thumbUrl(undefined)` 得到**空串**
⇒ `<img src="">` 被浏览器当成"当前页面地址"去加载 HTML ⇒ **裂图**。

## 二、证据

| 等级 | 证据 |
|---|---|
| 实测 | `release/1.0.0/.../resources/app.asar/node_modules/@ffmpeg-installer/win32-x64/ffmpeg.exe` → **spawn ENOENT**；同一份 `app.asar.unpacked/.../ffmpeg.exe` → **exit 0** |
| 实测 | 真库（解密后 235 条记录 / 1550 条目）：image **976/993** 有 `sig`，其中 **webp 只有 3/16**；video **128/222**。失败集中在用 exe 扫过的那几层，纯 jpg/png 的层几乎零失败 —— 与"只有依赖 ffmpeg 的路径坏"完全吻合 |
| 实测 | 探针 `docs/probes/webp-video/`：webp 3 变体（动图 / 带 alpha / 2400px）+ mp4 5 变体（fragmented / faststart / 0.4s / attached_pic / AV1）**全部成功** ⇒ 链路本身没问题，问题只在"二进制起不来" |
| 静态 | `electron-builder.json5` 原本**没有** `asarUnpack`；解包成 `app.asar.unpacked` 只是 electron-builder 对 `.exe` 的**自动检测**，随版本变化可能静默失效 |

## 三、修复（4 处）

| # | 文件 | 改动 |
|---|---|---|
| 1 | `electron/utils/thumbnail.ts` | 新增 `realBin()`：把路径里的 `app.asar` 重写成 `app.asar.unpacked`，ffmpeg / ffprobe 都过它（dev 路径不含 asar ⇒ 原样，行为不变） |
| 2 | `electron/utils/thumbnail.ts` | `probeDuration` 改成**先查 `stream=duration`（视频流）再退 `format=duration`（容器）**；`extractFrame` 补上"**产出文件非空**"的判据 |
| 3 | `src/views/FileFinder/index.vue` | `n-image` 的 `v-if` 加 `!!item.thumb`（无图退到类型图标，**绝不渲染空 src**）；类型图标类名 `.toLowerCase()` |
| 4 | `electron-builder.json5` | 显式 `asarUnpack` 两个 installer，不靠自动检测 |

### 为什么 #2 也是真根因，不是顺手加戏

`extractFrame` 原来只认 `runFfmpeg` 的 **exit code**，而 ffmpeg 在"时间点落在视频流末尾之外"时
**exit 0 且一个字都不写**。实测样本：

```
容器 format=duration = 60.000s
视频流 stream=duration = 0.500s
抽 1% = 0.6s  →  exit 0，输出目录里没有文件
```

多音轨 / 尾部长静音 / 拼接过的片源都会造成"容器时长 ≫ 视频流时长"。修前这类视频永远抽不到帧，
修后（先问视频流）统一成功 —— 探针 `videoLongContainer.thumbBytes = 7374`（修前为 0）。

### 为什么 #3 必须改

即使缩略图造不出来（坏文件、编码不支持），界面也**不该裂图**。
`<img src="">` 是浏览器里唯一会画出"裂开图标"的写法；缺图应该退到类型图标（`fiv-icon-*`），
这与"目录没脸就用文件夹图标"是同一条既有规则。

## 四、验证

- `npm run typecheck` → 0 error
- 探针 `bash docs/probes/webp-video/run.sh` → 全过（含新增的长容器回归样本）
- `vite build` → 通过；`dist/electron/main/index.js` 里能 grep 到 `app.asar.unpacked`
- 重新打包：**未完成** —— 当时 `file-finder.exe` 正在运行（3 个进程），`win-unpacked` 被占用；
  且宿主环境的 safe-delete shim 会拦 electron-builder 的批量清理。业主关掉 app 后自己跑 `npm run build` 即可。
  （构建前若 `dist` 已存在，`vite.config.ts:9` 的 `rmSync('dist')` 也会被同一个 shim 拦 —— 先把 `dist` 移走再构建，**别改那段代码**。）

## 五、验收

1. 关掉正在运行的 file-finder，`npm run build`，装新 exe（或直接 `npm run dev`）。
2. **对没有封面的目录按一次 ↻** —— 已缓存的失败条目不会自动重抽（`findCache` 命中就短路），
   只有重扫才会重新抽帧 / 重新转码。
3. 预期：webp 有缩略图；视频出帧；确实造不出图的条目显示 mp4/webp 类型图标，**不再裂图**。

---

## 六、补充：「目录的脸」也认 webp（同日追加）

上面修的是**缩略图生成**；但 `cover.webp` / `avatar.webp` 原本**连这一步都进不来** ——
目录的脸只认两个写死的名字（`avatar.jpg` / `cover.jpg`），`stat` 都不会发生。

**改动**：把名单抽成单一真相源 `electron/server/dirCover.ts`，由
`server/index.ts`（扫盘）和 `server/assistant/scan.ts`（找缺封面的深度重扫）共用：

```
['avatar.jpg', 'cover.jpg', 'avatar.webp', 'cover.webp']
```

- **jpg 排在前面** ⇒ 有 `cover.jpg` 的目录行为与以前**一模一样**。
- 两处共用一份的意义：助手那边若还用旧名单，会把"其实已经有 webp 封面"的目录判成没脸，
  **再补写一张 cover.jpg 覆盖上去**。

**效率（实测，本机 SSD 热缓存，300 次平均）**：

| 操作 | 单次耗时 |
|---|---|
| 4 次失败 `stat`（新名单最坏情况） | 35.8 µs |
| 2 次失败 `stat`（旧名单） | 16.3 µs |
| 1 次 `readdir`（同一目录） | 46.5 µs |

⇒ 每个没脸的目录 **+19.5 µs**，仍**低于**"改成列目录"的 46.5 µs。
一屏 30 个目录合计 +0.6 ms，与一次扫盘的 readdir + 每条目 stat 相比可忽略。
（移动硬盘冷启动会慢一个量级，但同一目录的 4 次元数据查询命中同一份目录项缓存，
且真实体感由外层 readdir 决定。）

**一个行为对齐（不是新特性）**：`cover.webp` 现在与 `cover.jpg` 同待遇 ——
不再作为独立图片条目/封面卡出现，而是**这个目录的脸**。

**未做**：png/其它格式（要加就是往名单里塞一个名字，成本同上）；`<目录名>.webp`
（与文件夹同名的封面）**不在**这条名单的语义里 —— 那是 `handleCover` 收敛封面的事，
它认任意图片扩展名（`index.ts` 的正则本来就含 webp）。

