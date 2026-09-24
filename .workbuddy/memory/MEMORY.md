# file-finder 项目长期备忘

## 一、特性清单（用户声明的"小便捷" —— 默认不碰）

**只有当我判断某条确实有问题时，才提交讨论；讨论通过才能改。**

### 目录语义
1. **有封面图的文件夹 → 收敛成一个「封面条目」（当片子显示）；没有的 → 保持目录**
   - 用户原话：「有 avatar 图片的文件夹我才当目录，如果没有我是直接当视频文件的，因为里面是有封面图的……只有视频类型的才会」
   - 实现：`handleCover` —— 有子目录 → 保持目录；无子目录 + 有图 → 收敛；无子目录 + 无图 → 保持目录
2. **`avatar.jpg` / `cover.jpg` = 目录自己的脸**：作为目录图标渲染，且不单独列成条目
   - 用户原话：「有 avatar 的你要将目录图标换成 avatar 渲染，而不是我点开来你显示 avatar.jpg」
3. 首层也用 `cover` 模式（`handleDirChange` 传 `'cover'`）—— 否则封面收敛只在第二层生效

### 交互便捷
4. 双击格子打开（单击不打开）
5. 双击封面条目 = 打开里面的**视频**（不是打开那张图片）
6. 封面条目的 `files > 1` 时，点击弹出文件列表 popover
7. 快捷键：`S` 聚焦搜索框 / `F5` 重扫当前目录 / `D` 打开文件夹选择
8. 搜索支持**拼音首字母**（`usePinYin`，取第一个读音）
9. 面包屑点击跳转；进子目录清空搜索词、返回时恢复；返回时恢复滚动位置
10. 视频预览复用缩略图（不走 `/raw`）—— 避免为预览读一遍 5~7 GB 原片

### 导航结构（2026-09-24 晚上收口，别再分叉）
11. **三条入口合一条**：选择文件夹 / 缓存记录 / 从网格下钻，全部经 `handleDirChange` → `pushLevel()`
    - `openHistory(path)` **只看 path，不再看缓存记录的 `mode`** —— mode 是记录属性，不该决定导航形状
    - `levelName(path)` = 路径末段，层级名是**算出来的**，不是调用方传的可选参数（曾因此整层消失）
    - `IOpenInfo.name` **必填**；`openStack.value.push` 全库只有 1 处（在 `pushLevel` 里）
    - 注意：`返回` 按钮的 `v-if="dir"` 是老的判断（`dir` = 选择框的值，与导航栈无关）。栈的真判据是 `openStack.length > 1`

### 架构决策（用户明确拍板，不要再提议改）
12. **保留 HTTP 前后端分离**，不换 IPC
13. **封面缩略图存 DB** —— 第一目标「少碰移动硬盘」
14. **缓存不跨机保留**（原话："那是云端的事情"）
15. 只需保证「A 盘(H:) 拔出、B 盘(H:) 插入不冲突」

### 安全 / 健壮性（2026-09-24 傍晚新增，用户已授权）
16. **本地服务需带口令**（`?t=`，随机生成、不落盘、渲染层经 IPC 取）
    - 为什么不能用 Origin 名单：打包后应用自己就是 `file://`，Origin 是 `'null'`，和恶意页面分不开
    - 为什么走 URL 而不是请求头：`<img src>` 带不了自定义头，缩略图正是 `<img>` 取的
    - `src/utils/request.ts` 的 `apiUrl()` 是**唯一出口** —— 新 URL 必须过它
17. **空状态只有一行浅灰小字**，且失败时**不显示**（不能替失败背锅）—— 加了 `loadFailed` ref 专门管这个
18. **封面解码有 ffmpeg 兜底**：`nativeImage` 只认 PNG/JPEG，解不开时走 ffmpeg 转 PNG 再回到同一条缩放链路
    - `makeDirCover` 必须先 `access` 再解码，否则每个没有 `avatar.jpg` 的目录都会白起一个 ffmpeg 子进程
    - 选封面的正则放行 `webp|psd|svg`，解码器都不支持 —— 这是「承诺 > 能力」的结构性错配，别再只改一边

## 二、最高优先级
**减少对移动硬盘的读写。** 任何优化与它冲突时以此为准。

## 三、协作方式（用户有 ADHD + 阅读障碍）
- 交付极简：**正文 ≤10 行 + 优先一张图 + 需要他做的动作一行**
- 过程、根因、验证数据一律落 `docs/`，**不进对话**；他问"还有哪些没做"时只要剩余清单
- 改主进程代码后必须**重启 dev**；改了扫描逻辑后要按**刷新（↻）**重建那条缓存

## 四、文档索引
- `docs/CHANGES-VS-ORIGINAL.md` —— 我的改动 vs 原版逐项对照（含收敛判据三轮迭代表；第九～十一节是本轮）
- `docs/AUDIT-VERIFY-2026-09-24.md` —— **交叉验证与最终裁决，冲突时以它为准**；第六节已拍板，第七节是图片故障
- `docs/AUDIT-2026-09-24.md` —— 初次审计；**开头有状态看板**；⚠️ 有内容丢失（停在 13:20），不要再对它做增量编辑
- `docs/ARCH-PLAN.md`、`docs/CODE-REVIEW.md`
- `docs/DEPS-UPGRADE-2026-09-24.md` —— **依赖升级的全过程 + 证据 + 四个真 BUG + 回滚方式**
  （动依赖版本前先看它；**第六节是启动崩溃 `util.isDate` 与 `nedb`→`@seald-io/nedb` 的换库取证**）

## 五、已裁决但**不做**的（别重开）
- `CACHE_VERSION` 不用为图片修复而升版（那要全库重扫 = 碰移动硬盘；让用户按一次 ↻ 就够）
- 缩略图内存上限（C3）：**重启即归零，实测全库仅 6.93 MB**。触发条件写在 `AUDIT-VERIFY` 第六节①（单会话累计 >200 MB 再动）
- A4 删死代码 / A5 dev 重建 dist / P1-2 contextIsolation / `/raw` 路径收紧 / 虚拟滚动 / `readFolder` 并发化
- `ABC-01-A/B` 类"多部片子共一张图"的问题：**用数量判定修不好**，要做对只能番号归一化，暂无样本

## 六、依赖与构建链契约（2026-09-24 全量升级后收口，动版本前先读）

当前锁定组合：electron 44.4.5 / electron-builder 26.15.3 / vite **7.3.6** /
vite-plugin-electron 0.29.1 / vite-plugin-electron-renderer 0.14.7 / vue 3.5.43 /
naive-ui 2.45.3 / typescript 5.9.3 / vue-tsc 3.3.11 / @ffprobe-installer 2.1.2 /
@vitejs/plugin-vue 6.0.9 / @types/node 24 / **@seald-io/nedb 4.1.2**（取代 nedb，见契约 4）。
`engines.node` 已收紧到 `>=22.12.0`。

**四条硬契约（破了就是运行时炸，不是编译期报错）**

1. **主进程/预加载不许内联运行期依赖** → `vite.config.ts` 里 main 与 preload 都挂了
   `notBundle()`。vpe 0.29/1.x **默认只外置 node 内置模块**，`dependencies` 会被打进 bundle；
   而 `@ffmpeg-installer/ffmpeg`、`@ffprobe-installer/ffprobe`、`fluent-ffmpeg` 都靠
   `__dirname` 找自己包里的文件（ffmpeg.exe / presets）。一旦内联，`__dirname` 变成
   `dist/electron/main`，`indexOf('node_modules')` 返回 -1 → **抽帧报「找不到 ffmpeg 可执行文件」**。
   自检：`grep 'require("fluent-ffmpeg")' dist/electron/main/index.js` 必须命中，产物约 15–16 kB。

2. **vite 不要上 8**（8 = rolldown）。vite 8 会把渲染层里 `require("electron").ipcRenderer`
   **优化成裸 ESM import**（`import{ipcRenderer as e}from"electron"`）。页面是 `file://` +
   `type="module"`，浏览器解析不了裸标识符 → 整份渲染层脚本报
   `Failed to resolve module specifier "electron"` → `#app` 空的、全白屏。
   `renderer: { resolve: { electron: { type: 'cjs' } } }` **救不了**（实测）。
   vite 7 + renderer 0.14.7 才会保留 `const rt = typeof require<"u" ? require("electron") : ...`。
   自检：`grep -c 'from"electron"' dist/assets/index-*.js` 必须是 **0**。

3. **打包靠 electron-builder 自动收 prod `dependencies`**（`files: ["dist"]` 不排除它们），
   ffmpeg.exe / ffprobe.exe 由它放进 `resources/app.asar.unpacked/node_modules/@*-installer/win32-x64/`。
   所以 `dependencies` / `devDependencies` 的划分**决定打进包的东西**：
   死依赖（`shelljs`、`iconv-lite`）已删；`less` 是构建期工具却挂在 `dependencies`（会多打 136 个文件），
   想瘦身就是把它挪到 devDependencies —— 但那是结构变更，需用户点头。

4. **缓存层是 `@seald-io/nedb` 4.x，不是 `nedb`**（2026-09-24 修启动崩溃时换的）。
   为什么换：Electron 44 = Node **v24.21.0**，`util.is*` 只剩 `isArray`/`isDeepStrictEqual`；
   `nedb@1.8.0`（2016 停更、无更新版）内部用 `util.isDate`/`util.isRegExp` →
   一启动 `dropLegacyRecords()` 的 `count({v:{$ne:2}})` 就抛 `TypeError`。
   **别再往回装 `nedb`**，也别给 `util` 打补丁（`util.isArray` 已是 DEP0044，下轮 Node 升级照样复发）。
   换库时必须记住的三件事：
   - 数据文件格式**双向兼容**（已用真实库副本实测：22 条可读、`$$indexCreated` 同构）；
   - `dropLegacyRecords` 靠 `$ne` 匹配"字段缺失"，换库后**要重验**（实测 3/3 仍命中）；
   - v4 把内部队列异步化了（`executor.push`→`pushAsync`、`persistCachedDatabase`→
     `persistCachedDatabaseAsync`）→ 旧那套私 API `compact()` 会失效，改用公开的
     `compactDatafile(cb)`；`loadDatabase()`/`ensureIndex()` **必须给回调**，否则
     加载失败会变成 UnhandledPromiseRejection（v1 是静默吞掉）；
     `find(query, projection)` 在 v4 的 d.ts 里会被第一个重载吃成 `void`，
     投影要写成 `find({}).projection({data:0})`。

**其它已踩过的坑**

- 数据目录 `%USERPROFILE%\.file-finder`（`electron/config/index.ts`）**与 Electron 版本无关**
  → 升 Electron 不会换库、不会重扫移动硬盘。改 `electron-builder.json5` 时别加 `productName`
  （`app.getName()` 变了会换 userData，同理影响不到本项目，但别制造变量）。
- Electron 二进制**不会**随 `npm install` 自动下载（GitHub 不可达）：
  `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node node_modules/electron/install.js`。
  判据：`node_modules/electron/dist/electron.exe` 存在 + `path.txt` 存在。
- `npm install` 后扫一眼残留：Windows 上文件被占用时 npm 删不掉，把待删的包改名留下。
  **两种命名都要查**（2026-09-24 更正：不只 `*.DELETE.*`）：
  `find node_modules -maxdepth 1 \( -name "*.DELETE.*" -o -name ".*-*" \)`。
  实测中过招的是 `agent-base` / `http-proxy-agent` / `https-proxy-agent` 的 `dist/index.js`
  → 症状是 `electron-builder` 报 `Cannot find module .../dist/index.js`。
  修法：删掉这三个包目录再 `npm install`。
  **但要先看是不是空壳**：本仓库现有 178 个 `.<包名>-<hash>` 残留（跨 2023-09~2026-09），
  `ls -A` 一看全是空的、上面三个包的 `dist/index.js` 也都完整 → **不影响运行**，别慌也别硬删（护栏会拦）。
- 无头/沙箱验证：见 skill `electron-headless-verify`（`_probe_ver` 隔离探针那套做法）。

