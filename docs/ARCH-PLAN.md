# file-finder 收尾规划

> 目标：**合理、没有遗漏、最小改动、以正确的方式修而不是打补丁。**
> 每条都标注了「为什么这么改才叫正确」，而不是「为什么这样更好」。
> 本文只描述要做什么，代码一行未动。

---

## 判据（先说清楚我用什么标准筛掉了大半条候选）

1. **不改已经对了的东西。** 上一轮 review 里 P0-1~P0-4 有几条已经修掉了（`request.ts` 已加 `assertOk`、`DriveChanger` 已删、CORS 已收紧、`listen` 已绑 127.0.0.1）。下面不再重复列。
2. **实测数据优先于直觉。** 我原本认为"该上虚拟滚动"，实测单层条目最大 104 条（平均 5.0，>200 的 0 条）→ 判为**不做**。
3. **和项目第一目标冲突的一律不做。** 第一目标是"少碰移动硬盘"。任何提高移动硬盘随机读的方案都要先过这一关（所以 `readFolder` 并发化不做）。
4. **"结构性不可能发生" > "加了道工序让它不发生"。** 同一个 bug，能用去掉一个状态根除的，就不去加一场 await 仪式。

---

## P0 · 装上类型门禁（必须先做，1 项）

### P0-1 给主进程加 tsconfig

| | |
|---|---|
| 位置 | `tsconfig.json:21-26`（`include` 只有 `src/**`）、`package.json:11` |
| 现状 | `npm run build` 里的 `vue-tsc --noEmit` **只检查 `src/**`**。`electron/**`（唯一能碰文件系统、shell、网络的那半边）**零类型检查** |
| 改法 | 新增 `tsconfig.electron.json`（`include: ["electron/**/*.ts", "src/env.d.ts"]`，`strict: true`）；`package.json` 加 `"typecheck"`，`build` 改成 `npm run typecheck && vite build && electron-builder` |

**为什么这是"正确"而不是"更严格"**：我上一轮那张"还有哪些没完成"的清单，是靠肉眼 grep + 逐条回源码核对写出来的，**还是漏了 9 条**。人眼在 278 个文件里做全称判断是不可靠的，编译器是可靠的。装上这道门禁之后，P1 每一条改动都有机器兜底，而不是靠我"看过了"。

**为什么必须单独一个 tsconfig**：主进程是 Node/CJS 语义，渲染层是 DOM 语义。塞进同一个 `include` 要被迫共用 `lib`，两边都会开始报假错 —— 那就成了"为了装门禁而改代码"，本末倒置。

**验证**：`npx tsc -p tsconfig.electron.json --noEmit` 退出码 0（**已实测通过**；必须带 `src/env.d.ts`，它里面声明了 `@ffprobe-installer/ffprobe`，不带会报 TS7016）。

---

## P1 · 正确性（8 项，每一项都有用户能碰到的现象）

### P1-1 打开文件：从"拼命令行字符串"改成"传路径"

| | |
|---|---|
| 位置 | `electron/main/index.ts:4,121-125`、`src/views/FileFinder/index.vue:186-214` |
| 现状 | 渲染层手工给路径加双引号（`:206`、`:209-212` 还按 `/` 切数组、给倒数第二段再包一层引号），主进程再把它拼进 `child_process.exec()` 交给 cmd |
| 改法 | 主进程改成 `shell.openPath(path.win32.normalize(p))`，用 `ipcMain.handle` 回传错误串；渲染层**删掉全部引号逻辑**（`formatPath`/`split`/`join` 整段没了） |

**为什么这是"正确"**：把"一个路径"当成"一段命令行"往下传，是抽象层级错了 —— 所有引号 hack 都是在给这个错误打补丁，而补丁永远追不上：空格、中文、`&`、`(`, `)`、`'`、`#`、`%`、以及"倒数第二段"这个假设本身。`shell.openPath` 收的就是路径，这些问题**从定义上不存在**，同时命令注入面一起消失。

**同一处还压着三个真实缺陷，一并修**（不是三件事，是同一个错误抽象的三个症状）：

- **a. popover 里双击具体文件，路径必然错。** `:191` 用 `openStack` 顶层的 path 拼父目录，但 popover 里的封面是"子目录收敛"出来的，它的真实父目录比 `openStack` 顶层**深一层** → 拼出 `H:/新建文件夹/"TST-177"/"TST-177-1.mp4"` 这种不存在的路径（`TST-177` 是封面图的名字，不是目录）。正确来源是已经在手的 `popover.cover.dir`。
  **为什么至今没被发现**：`exec` 失败只 `console.log(err)`，用户那边一点动静都没有 —— 静默失败。所以顺带把失败提到界面上（`ipcMain.handle` 回传错误串，渲染层 `notify('error')`），不然修完也还是看不见。
- **b. 没有扩展名的文件会多出一个点。** `:195` 无条件 `item.name + '.' + item.ext`（`getExt` 返回 `''`），"README" 变成 "README."。同一个文件里 `rawUrl()`（`:112`）**写法是对的** —— 说明正确做法就在旁边，只是没被复用。抽成一个 `fileNameOf(item)`，两处共用（去掉第二份真相）。
- **c. 目录条目的 `item.ext` 是空的**，走 `:195` 也会拼出 `"目录名."`。当前不可达（`handleOpen` 里 folder 走另一条分支），但 `fileNameOf` 统一之后这个地雷一起拆掉。

**验证**：纯 Node E2E 断言"传进去的字符串就是原样路径"（不含引号、不含多余 `.`），并用含空格与 `&` 的目录名跑一遍。

---

### P1-2 `contextIsolation: true` + 最小 preload 桥

| | |
|---|---|
| 位置 | `electron/main/index.ts:43-50`、`electron/preload/index.ts`、`src/components/FolderSelector/index.vue:22,43,58-60`、`src/views/FileFinder/index.vue:84,213` |
| 现状 | `nodeIntegration: true` + `contextIsolation: false` → **渲染层一个 `require('child_process')` 就能干任何事**。preload 里完全没有 `contextBridge` |
| 改法 | 关掉这两个开关；preload 暴露**恰好 3 个方法**（`pickDirectory` / `onDirectoryChanged` / `openFile`），不发明新 API 面 |

**爆炸半径已实测**：渲染层只用了 `ipcRenderer` **4 处**、主进程只有 **3 个频道**、渲染层**没有直接用任何 Node 内置模块**。这是可以一次改干净的规模，不是"重构渲染层"。

**为什么这次必须一起处理"主进程 → 渲染层"的语义**：`directory-changed` 现在的 payload 就是 `dialog` 返回的 `string[]|undefined`，而 `FolderSelector:59` 已经在做 `value[0]`。桥接层必须**逐字转发 `value`**（`(_e, value) => cb(value)`），**不能**写成 `(...args) => cb(...args)` —— 后者会把数组摊平成多参数，`value` 变成字符串，`value[0]` 就取到第一个**字符**了。这个错误是静默的（路径变成 `H`），必须写死在注释里。

**顺带治好一个泄漏**：`FolderSelector:58` 的 `ipcRenderer.on` 从不 `off`。桥接方法返回注销函数，调用方 `onUnmounted` 里注销 —— 两个问题一次改动，不是两件事。

**必须原地保留**：`preload` 的 `window.onmessage` / `removeLoading`。`src/main.ts:11` 的 `postMessage({payload:'removeLoading'})` 靠它关掉启动 spinner，删了就是白屏。

**验证方式（含已知风险）**：Electron 20 起渲染进程默认 sandbox，preload 只能用受限的 `require` —— 我们的 preload 只用 `document`/`window`，理论上无影响。若启动后 `window.host` 是 undefined，说明 preload 没加载起来（打包格式或 sandbox 问题），退路是显式 `sandbox: false`。**这条要真跑一次窗口才算数，沙箱里 Electron 起不来，只能你在本机验。**

---

### P1-3 文件夹选择框不再阻塞主进程

| | |
|---|---|
| 位置 | `electron/main/index.ts:113-119` |
| 现状 | `dialog.showOpenDialogSync(win!, ...)` —— **同步**。主进程同时也跑着 3060 的 HTTP 服务，对话框开着期间服务端**不响应任何请求** |
| 改法 | `await dialog.showOpenDialog(win, { properties: ['openDirectory'] })`，取消时仍然发 `undefined`（`:59` 的 `value ? value[0] : ''` 语义逐字不变） |

**为什么这是正确性问题不是体验问题**：主进程被同步阻塞时，渲染层任何 `/openFolder`、`/thumb` 都会挂住 —— 开着对话框点别处就是卡死。顺带去掉一个 `win!` 非空断言。

---

### P1-4 渲染层数据流（一个概念性修正，消掉 4 个症状）

| | |
|---|---|
| 位置 | `src/views/FileFinder/index.vue:138,216-246,274-296,312-320,330-360` |
| 现状 | 三份状态：`fetchCache`（按 URL 存整份列表）+ `dataSource` + `fileList`；`handleFilter` 被手动调用 5 次 |

**症状 1 —— 插着 B 盘显示 A 盘的数据。** `fetchCache` 的 key 是 `path + mode`，而盘符会被复用：A 挂 `H:/x` → 缓存住；拔 A 插 B，`onBack`/`handleJump` 走 `fetchFolder` → **命中 `fetchCache`，压根不请求服务端** → 用户看到 A 的封面清单，双击"打开"的是 B 盘上那个路径。
服务端这一侧上一轮已经修对了（`findDriveByLetter` 每次 stat 复核盘符现在的主人），**但渲染层这份缓存把那次修复整个绕过去了**。这是两份真相源，且是不受保护的那一份。

**症状 2 —— 搜索词回填的时序竞态。** `onBack`/`handleJump`/`onRefresh` 都是"发请求 → 立刻 `handleFilter` → 响应回来后 `fileList = data`"。过滤结果被后到的响应覆盖：**搜索框里还留着词，列表已经变成未过滤的全部**。现在之所以没暴露，是因为缓存命中那条分支是同步赋值的（先赋值再过滤，顺序恰好对）—— **删掉缓存反而会让它变成必然**。所以这条必须一起修。

**症状 3 —— 每次 F5 都在做无用的存/取搜索词**（`:289,293`），而这只是因为 `fetchFolder:222` 顺手把搜索框清空了。

**症状 4 —— `fetchCache` 无上界**，浏览过的每个目录都留一份完整列表，永不释放。

**改法（按"结构性不可能发生"来重构，而不是加 await 仪式）**：

```ts
// dataSource = 服务端给的完整列表（唯一真相）
// fileList  = 过滤视图，派生出来，不给任何人写
const fileList = computed(() => filterByName(dataSource.value, searchText.value));
```

- `fetchFolder` 只负责取数（`return fetch(...)`，不再顺手清搜索框）；**搜索框清空/恢复由导航动作自己负责**（`handleDirChange`、`openFolderInCover` 清空；`onBack`、`handleJump` 从 `searchStack` 恢复）。
- `handleFilter` 消失，`:26` 的 `@input` 消失 —— `v-model:value` 已经是响应式的。

**为什么这是"正确"而不是"又加了道工序"**：症状 2 的根因是"有个地方会异步写 `fileList`"。用 `await` 把顺序摆对，只是让这一个调用点暂时正确，下一个人再加一个写 `fileList` 的地方就复发。改成 `computed` 之后，`fileList` **没有任何写入口**，这个 bug **在结构上无法存在**，同时还删掉了 `handleFilter` 和它的 5 个调用点。代码更少，不是更多。

**已知差异（提前说明，不让它变成意外）**：删掉缓存后，"返回/前进"每一次都会真的请求服务端。服务端热读实测 **1–2 ms**、响应体 **1.6 KB**，所以交易的是"两毫秒"换掉"串盘风险"。副作用是 `loading` 可能闪一下；**不预先加防闪补丁** —— 如果实际能看到闪动，再加"延迟 120ms 才显示 loading"（约 10 行），这是独立的一件小事。

---

### P1-5 `FileInfo` 去掉 `fs.Stats` 和 `[key: string]: any`

| | |
|---|---|
| 位置 | `electron/server/index.ts:43-64`、`:164-170`、`:248-256` |
| 现状 | 类型是 `fs.Stats & {...}` 且带 `[key: string]: any`；构造用 `Object.assign({}, stat, {...})` |

**先看代码和自己的注释打架**：`:33-37` 的注释明明白白写着「只留渲染层真的会用的字段 —— 把整个 fs.Stats 序列化进去是几十个字段的噪音，而它在每条缓存里都要重复存一遍」，**下面第 164 行干的正是被它否掉的事**。

**实测这条到底带进去什么**（读真实库第一条记录）：

```
"dev":4270644338,"mode":33206,"nlink":1,"uid":0,"gid":0,"rdev":0,"blksize":4096,
"ino":1917999644672,"blocks":2048,"atimeMs":...,"mtimeMs":...,"ctimeMs":...,
"birthtimeMs":...,"atime":"...","mtime":"...","ctime":"...","birthtime":"..."
```

**17 个渲染层一个字都不看的字段，每条记录都要写进 nedb，再原样发给渲染层。**

**两个不只是"胖"的问题**：`dev` 就是扫描那一刻这块盘的卷序列号 —— 它被**冻在缓存记录里**。这套设计的核心是"盘符不是身份、序列号才是"，而这里等于把身份又抄了一份进数据，将来谁读 `item.dev` 当下判断就会拿到过期的盘身份。另外 `[key: string]: any` 让整个类型失去多余属性检查 —— `item.thmb` 这种拼错编译器一句话不说。

**改法**：`FileInfo` 改成独立 interface（不再 `extends fs.Stats`），保留渲染层真正会用的字段：`dir` `name` `isDirectory` `ext` `type` `size` `files[{name,size}]` `thumb` `avatar`（+ 两个只存不发的 `thumbData`/`avatarThumbData`）。构造改成逐字段赋值，不再 `Object.assign({}, stat, ...)`。

**验证**：E2E 断言下发条目里**不再出现** `dev`/`ino`/`mode`/`nlink`/`uid`/`gid`/`rdev`/`blksize`/`blocks`/`atime*`/`mtime*`/`ctime*`/`birthtime*`；同时断言渲染层需要的字段一个不缺。

---

### P1-6 `readFolder` 的 `dir` 由调用方声明，非盘符路径也登记缩略图

| | |
|---|---|
| 位置 | `electron/server/index.ts:92-95,135,164,233,248,292-293,333-336` |
| 现状 | `item.dir` 由 `readFolder` 内部的 `relOf(dir)` 隐式决定；降级分支 `:335` 直接 `sendJson(readFolder(...))`，**不走 `toWire`** |

**两个问题**：

1. **走 `/openFolder` 但拿不到盘身份的路径（UNC、网络位置），缩略图从不登记。** `putThumb` 只在 `toWire` 里被调用，降级分支绕过了它 → 前端拿到的 key 请求 `/thumb` 全是 404 → **整个网格的图全是白框**。这是"两条出口各自处理"，正确做法是**只有一条出口**：抽出 `wire(items)`（登记 + 剥内部字段），缓存命中路径再补一步 `dir` 补盘符。
2. **`item.dir` 的存储形态靠字符串操作隐式决定。** `relOf()` 会把盘符剥掉；降级分支里对"有盘符但 stat 不到卷号"的情况（空光驱）就剥出了一个相对路径，前端再拼 `/raw?p=影片/x.jpg` 就是 400。改成 `readFolder(..., storeDir)` 由**调用方显式传入要存什么**：缓存路径传 `relPath`，降级路径传原样绝对路径。签名必填 → 编译器强制两个调用点都表态，`relOf` 直接删掉。

**诚实标注**：问题 2 里那个空光驱场景**几乎不可达**（无卷号的盘上 readdir 本来就会失败，返回空列表，前端什么都看不到）。我把它和问题 1 放在一起，只是因为它们是同一个函数上的一次签名修正，顺手，不是为了它本身值多少。

---

### P1-7 拼音搜索被逗号污染

| | |
|---|---|
| 位置 | `src/hooks/usePinYin.ts:64`、`src/views/FileFinder/index.vue:347` |
| 现状 | `usePinYin()` 返回 `string[]`，`:347` 里当字符串参与 `+` 拼接 → 隐式 `join(',')` |

**为什么平时看不出来**：不含多音字时 `makePy` 返回的数组只有一个元素，`['AL'] + 'BB'` 恰好是对的。一旦首字命中 `oMultiDiff` 里那 375 个多音字，`['DZ','DC'] + rest` 就变成 `'DZ,DC...'` —— 中间多一个逗号，匹配串再也搜不到。

**改法**：`usePinYin(...)[0]`。**取第一个读音**是与其它行为一致的语义（单个读音就是它自己）；改成"任一读音都算命中"是**新功能**，不在本次范围。

---

### P1-8 卡在 `onMounted` 回调里的 `onUnmounted`

| | |
|---|---|
| 位置 | `src/views/FileFinder/index.vue:362-380`、`:7` |
| 现状 | `onUnmounted(() => window.removeEventListener(...))` 写在 `onMounted` 的回调**内部** |

**为什么是 bug**：`onUnmounted` 必须在 setup 同步执行期注册才有效。写在 `onMounted` 回调里，本次生命周期已经过了注册窗口 —— 那个注销回调**根本不会被调用**，`keyup` 监听永久留在 window 上。改法是把 `onUnmounted` 挪到 setup 顶层。同类型问题 `HistoryTable:310` 已经修过一次，这里是漏网的那处。

**同一处还有一个同类问题**：`:7` 面包屑的 `:key="folder.name"`。**key 不能只用显示名** —— 链上出现两个同名目录（`H:/新建文件夹/新建文件夹`）会触发 Vue 复用错的实例，点面包屑跳到错误的层级。`:48` 的图片格子上一轮已经因为这个改过了（当时实测 107 条记录里有 1 条真的撞了），这是同一个根因的最后一处。改成 `folder.path`（同一个链上路径必然唯一）。

---

## P2 · 清理（不改变任何行为）

| 项 | 位置 | 依据 |
|---|---|---|
| `electron/server/read.ts` | 31 行 | 全文注释，无一行有效代码 |
| `electron/utils/FileFinderDocker.ts` | 66 行 | **0 处外部引用**（已被 `driveIdentity` 取代） |
| `src/components/ItemFrame/index.vue` | 20 行 | 0 处 import（`FolderSelector:24` 那个 `ItemFrameProps` 只是重名，不是引用） |
| `src/components/HelloWorld.vue` | — | 0 处 import，模板脚手架残留 |
| `src/hooks/useFileTypeIcon.ts` | 15 行 | 只在被注释掉的代码里出现（`index.vue:78,269`） |
| `src/samples/node-api.ts` | 13 行 | 只在被注释掉的 `main.ts:6` 里出现 |
| `main-process-message` 那一对 | `main/index.ts:62-64` ←→ `node-api.ts:5` | 发消息的人和收消息的人**都是死代码**，一起删 |
| `src/utils/index.ts` 的 `printTree` + `level_stack` | — | 只为已不存在的 `/getFileTree` 服务；`list.txt` 那份 628 KB 的乱码就是它的输出 |
| `main/index.ts:98-111` `ipcMain.handle('open-win')` | 14 行 | 无任何调用方（preload 里没暴露） |
| `index.vue:49` `\|\| ''` | 1 行 | `item.name + ' ' + ...` 永远是真串，`\|\| ''` 死分支 |
| `vite.config.ts:42-53` 的 `renderer.resolve` | 8 行 | 渲染层**不使用任何 Node 模块**（已实测），列 `iconv-lite`/`fluent-ffmpeg` 是模板残留 |
| 根目录 `list.txt` 628 KB / `file-docker-list.txt` | — | 前者是 `printTree` 的调试输出；后者只被 `FileFinderDocker` 读（`.gitignore` 已忽略） |
| 未引用的本地资源 ≈23 个 | `src/assets/{electron,vue,vedio}.png`、`vite.svg`、`mp4.svg`、`fileTypeIcon/*.svg`(18) | `fiv-icon-*` 类来自 `file-icon-vectors` 这个 npm 包，不是这些本地 svg；本地只用到 `blank.svg` 和 `folder.png`。**收益很小，可选** |
| `src/views/PageLocking/index.vue` | — | 疑似未引用，删前 grep 复核 |

**`electron/utils/ffmpeg.ts` 不能删**：9 处引用，且 `main/index.ts:6` 的 `import '../utils/ffmpeg'` 是**副作用导入**（负责 `setFfmpegPath`/`setFfprobePath`）。

### 数据文件（需要你点头，我不会自己动）

| 文件 | 大小 | 判断 |
|---|---|---|
| `D:\code\file-finder\searchCache.db` | **87 MB** | 2023-05-29 遗留。运行时库在 `~/.file-finder/`（`electron/config/index.ts:5`），**这个文件程序从不读**，`.gitignore` 里 `*.db` 也把它忽略了 |
| `%USERPROFILE%\.file-finder\searchCache-20240630.db` | **123 MB** | 2024-06-30 的备份，同类备份只此一份（不会持续增长）。旧格式（无 `serial`），**新代码读进来也会当脏数据清掉**，留着没用 |
| `%USERPROFILE%\.file-finder\searchCache.db` | **107 MB** | **这是活库，不用手动处理** —— 我读了它的第一条记录，还是旧格式（`{"path":"H:\\...","dev":...}`），下次启动 `dropLegacyRecords()` 会自动备份 + 回收（E2E 实测 103 MB → 72 B，7.5 s） |

**注**：活库回收时会在同目录再生成一份当天备份（约 107 MB）。所以清理完会有 **123 MB + 107 MB 两份备份**，加起来 230 MB。要不要一起删，你说了算。

---

## 明确不做（含理由，这部分和信息一样重要）

| 候选 | 为什么不 |
|---|---|
| **虚拟滚动** | 实测：107 条缓存记录里单层条目数**最大 104**、平均 **5.0**、**>200 的 0 条**。104 条约 3.1 屏高，收益极小。为一个量不出来的收益引入一层复杂度，是自杀 |
| **`readFolder` 改并发** | 会提高移动硬盘的随机读。项目第一目标是"少碰移动硬盘"，这条直接冲突 |
| **搜索加 debounce / 拼音加缓存** | 最坏情况 104 条 × 每次按键；`makePy` 只做 `charCodeAt` + 字符串索引，多音字（375/20902 ≈1.8%）命中后组合数也只有 3。**量不出来，不加** |
| **把打开文件也改成 HTTP** | 用户已明确"保留 HTTP 是因为要前后端分离"，而 `shell.openPath` **必须在主进程**（渲染层没有 shell）。这条本来就不是"前后端分离"的管辖范围 |
| **`readFolder` 里预判 `avatar.jpg`** | 现在是一个失败 open。换成先 `readdir` 子目录反而更贵。**当前写法已经是这个场景下最省的** |
| **收紧 `/raw` 的路径校验** | 已经有 `splitPath` + `..` 拦截，而且用户本来就有整块盘的浏览权限，再收紧只是麻烦 |
| **给 `/backup` 加保留策略** | 手动触发 + 同日覆盖，增长由用户驱动，不是隐患 |
| **渲染层按需分页** | 服务端已经把响应体从 674 KB 压到 1.6 KB，分页解决的是另一个问题，而那个问题（列表过长）实测不存在 |

---

## 执行顺序与验证

```
P0  →  P1-1..P1-8  →  P2（清理 + 数据文件需你确认）
 ↑
 先装门禁，后面每条改动都由编译器兜底
```

**验证方式（沿用已经建立的两套，不新增依赖）**：

1. **纯 Node E2E**（不上 Electron，绕开沙箱起不来 GPU 的问题）：把服务端打包成 CJS，用 `fs/promises.stat` 打桩模拟多块硬盘共用同一个盘符。上一轮 **91 项全绿**，本次复用并新增 3 组断言：
   - 下发条目字段白名单（P1-5）
   - 非盘符路径的缩略图**能取到**（P1-6）
   - "打开文件"收到的字符串是原样路径（P1-1）
2. **定向类型检查**：`npx tsc -p tsconfig.electron.json --noEmit` + `npx vue-tsc --noEmit`，两个都要 0 退出。

**只有一件事必须你在本机做**：P1-2 之后跑一次真实窗口，确认 ① `window.host` 存在 ② 启动 spinner 会消失 ③ 选文件夹、双击打开文件都正常。沙箱里 Electron 起不来（GPU 崩溃），这一条我验不了。

---

# 执行记录（2026-09-24）

## 已完成

| 项 | 说明 |
|---|---|
| P0-1 | 新增 `tsconfig.electron.json` + `npm run typecheck`，接进 `build`。**装上就立刻抓到一个错**（`read.ts` 的隐式 any —— 而且证明我之前说它"全文注释"是错的，前 6 行是活代码） |
| P1-1 | `child_process.exec` → `shell.openPath(win32.normalize(p))` + `ipcMain.handle` 回传失败；渲染层引号 hack 全部删掉；**顺带修掉 3 个同源缺陷**（见下） |
| P1-3 | `showOpenDialogSync` → `await showOpenDialog`；取消时仍发 `undefined`，语义逐字不变 |
| P1-4 | 删 `fetchCache`；`fileList` 改 `computed`；`fetchFolder` 只取数不再清搜索框；`onRefresh` 缩到 4 行 |
| P1-5 | `FileInfo` 去 `fs.Stats & {...}` 与 `[key:string]:any`，改显式字段表；`type` 收成字面量联合。**下发字段 24 → 7 个** |
| P1-6 | `readFolder(..., storeDir)` 参数化（`relOf` 删除）；抽出唯一的 `wire()`，非盘符路径不再漏登记缩略图 |
| P1-7 | `usePinYin(...)[0]` |
| P1-8 | `onUnmounted` 移到 setup 顶层；面包屑 key 改 `folder.path` |
| P2 | 删 8 个死代码文件 + 21 个未引用资源 + `printTree`/`level_stack` + `thumbCount`/`canThumbImage`/`findDriveBySerial`；仓库根 `searchCache.db`(87 MB)、`list.txt`、`file-docker-list.txt` |
| 新增 | `CACHE_VERSION` 缓存格式版本（见下） |

## 执行中新查出的问题（原规划没有的）

1. **popover 里双击文件，路径必然错**（`index.vue` 原 `:191`）。父目录取了 `openStack` 顶层的 path，但 popover 的封面是"子目录收敛"出来的，真实父目录比它**深一层** → 拼出 `E:/sample/videos/"TST-131"/"xxx.mp4"` 这种不存在的路径（`TST-131` 是封面图名不是目录名）。**至今没人报，是因为 exec 失败只 console.log** —— 静默失败。
2. **`handleOpen` 里目录的路径用 `dir.value` 拼，也是错的**（同类）。`dir` 是"当前选中的根"，进到子目录之后它还是最初那个，会拼出少一层的路径。改用 `item.dir`。
3. **库里已有的旧记录没人管。** 新代码只保证**新写入**的记录干净；上一版写进去的胖记录（每条多带 17 个 `fs.Stats` 字段，含扫描当刻的卷序列号 `dev`）既不会报错也不会自己消失，只是悄悄违反"缓存里不存盘身份"这条不变量。
   → 引入 `CACHE_VERSION`，`dropLegacyRecords` 的条件从 `{serial: {$exists: false}}` 换成 `{v: {$ne: CACHE_VERSION}}`。**已用真实 nedb 验过 `$ne` 会匹配"字段不存在"的文档**，所以一个条件覆盖"从没有过版本号的旧库"和"以后版本再变"两种情况。实测：重启后 **缓存库 107 MB → 72 B**，记录数归零。
4. **`stripThumbData` 的返回类型在撒谎**（写 `T`，实际剥掉了两个字段）。改成 `Omit<T, 'thumbData'|'avatarThumbData'>` —— 顺带不需要 `Record<string, any>` 那个约束了，而 `interface` 没有隐式索引签名，硬套它反而会把结构化类型卡住。
5. **删除文件夹选择后界面还留着上一个目录的内容**（`handleDirChange` 的 `!value` 分支没清 `dataSource`）。补上。

## 两处**我自己规划错了**，已纠正

1. **`vite.config.ts` 的 `renderer.resolve` 块现在不能删。** 原计划把它列在 P2。实际上渲染层还在 `import { ipcRenderer } from 'electron'`，那个块正是让它能被解析的东西 —— 现在删会直接构建失败。**必须等 P1-2（contextIsolation）那一批，把渲染层对 `electron` 的 import 全部去掉之后，才能一起删。**
2. **P2 的"删备份保留策略不用管"这个判断要补一句。** `cacheBackup()` 的文件名是 `searchCache.db-YYYYMMDD.db` —— **同一天多次备份会互相覆盖**。本次就发生了：第一次重启的 107 MB 备份被第二次重启的 360 KB 覆盖了。不影响正确性（2024 那份 123 MB 还在，且被覆盖的本来就是要丢弃的旧格式数据），但要知道"想留住某个时刻的备份就得当天先拷走"。

## 验证结果

```
npx tsc -p tsconfig.electron.json   exit 0
npx vue-tsc --noEmit                exit 0
vue/compiler-sfc 编译 4 个 SFC        失败 0
服务端断言                             PASS 50 / FAIL 0
  探过条目 142 | 校验缩略图 54 | 图片 raw 19 | 视频条目 35
  下发字段无 fs.Stats 泄漏 / files[] 无多余字段 / dir 都带当前盘符
  /thumb 全部 200 + image/jpeg
  图片的 /raw 是 image/* ；视频的 /raw 不是（证明渲染层必须绕开它）
  重扫后所有缓存记录都带 v=2
```

## P1-2 的最终裁决：**不做**（结论已推翻，见下）

原本把它列为"唯一剩下的待办"，并给出"值得做"的判断。**该判断已被推翻**，依据是两条查证结果：

- **全库搜 `v-html` / `innerHTML` / `outerHTML` / `eval(` / `new Function` / `dangerously*` → 0 处命中。**
- **`FolderSelector` 那个不注销的 `ipcRenderer.on`，其宿主组件在应用生命周期内只挂载一次**（没有 `v-if`，`FileFinder` 是唯一视图）。

`contextIsolation` 挡的是"渲染层里跑着**外来内容**"。这两条成立意味着外来内容没有入口 ——
`electron/main/index.ts` 里那句 `// Warning: Enable nodeIntegration and disable contextIsolation is not secure in production`
是模板自带的通用话术，对本项目的实际形态不成立。

于是收益与代价是：

| | 内容 | 量级 |
|---|---|---|
| 安全 | 0 处注入入口 → 关掉 nodeIntegration 防不到任何真实攻击 | **收益 ≈ 0** |
| 解耦 | 渲染层少 4 处直连 `ipcRenderer`（可测试性） | 收益很小 |
| 代价 | 改"主进程 ↔ 渲染层"通信协议，改错白屏，且验证必须由用户在本机做 | **是真的** |

按"为做对的事，不为加而加"：花真实代价换 ≈0 收益，**不做**。

下面那节保留为**待命方案**（万一将来渲染层开始加载外部内容 —— 比如嵌入网盘预览、远程封面 URL —— 它立刻从"不做"变成"必做"）。届时的施工要点：

- 桥接层必须**逐字转发 `value`**（`(_e, value) => cb(value)`），**不能**写成 `(...args) => cb(...args)` —— 后者把数组摊平成多参数，`FolderSelector:54` 的 `value[0]` 会取到第一个**字符**，`F:/x` 变成 `F`，而且是静默的。
- `preload` 的 `window.onmessage` / `removeLoading` 必须原地保留：`src/main.ts` 的 `postMessage({payload:'removeLoading'})` 靠它关启动 spinner，删了就是白屏。
- 改完可一并删掉 `vite.config.ts:42-53` 的 `renderer.resolve` 块（现在删不了，渲染层还在 `import { ipcRenderer } from 'electron'`）。
- 爆炸半径：渲染层 4 个 `ipcRenderer` 使用点、3 个频道，未直接使用任何 Node 内置模块。

## 数据文件（已处理）

| 文件 | 原大小 | 状态 |
|---|---|---|
| `%USERPROFILE%\.file-finder\searchCache-20240630.db` | **123 MB** | **已删除**（2026-09-24，用户确认）。2024-06-30 的旧备份，旧格式无 `v` 字段，即使恢复也会被 `CACHE_VERSION` 在启动时全部清空 —— 可用价值为 0。压缩试过只到 92.5 MB（内容几乎全是 base64 缩略图，压不动），所以连备份一并清掉 |
| `%USERPROFILE%\.file-finder\searchCache-20260924.db` | 360 KB | 保留。今日重启时自动生成的备份（正常机制；注意同日会覆盖） |
| `%USERPROFILE%\.file-finder\searchCache.db` | 2.7 MB | 活库。已被自动回收过一轮（107 MB → 72 B），现随实际使用回升到 2.7 MB，属健康区间 |

`.file-finder` 目录合计：**123 MB → 3.0 MB**。

## 到此为止：本轮全部收束

P0（1 项）、P1（8 项中 7 项）、P2（全部）均已完成并验证；P1-2 经查证判定为**不做**。
没有遗留的代码待办。


