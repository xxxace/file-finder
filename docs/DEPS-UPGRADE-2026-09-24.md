# 依赖全量升级（2026-09-24）

> 触发：用户「你看下 package.json，分析哪些包要升级、哪些不用，确定好后开始升级」。
> 本文是过程与证据的落地处；对话里只留结论。

## 一、最终版本（已安装，`npm install` exit 0）

| 包 | 升级前 | 升级后 | 备注 |
|---|---|---|---|
| electron | 20.1.0 | **44.4.5** | Chromium 104 → 152，Node 16 → 24.21 |
| electron-builder | 23.3.3 | **26.15.3** | |
| vite | 3.0.9 | **7.3.6** | **有意不上 8**，见第二节② |
| @vitejs/plugin-vue | 3.0.3 | **6.0.9** | |
| vite-plugin-electron | 0.9.1 | **0.29.1** | 上了 `.`/`simple`/`plugin` 三入口的新形态 |
| vite-plugin-electron-renderer | (0.9.0 传递) | **0.14.7** | |
| vue | 3.2.37 | **3.5.43** | |
| naive-ui | 2.34.4 | **2.45.3** | |
| typescript | 4.8.2 | **5.9.3** | 不上 7.0.2（native 版，vue-tsc 未跟上） |
| vue-tsc | 1.0.9 | **3.3.11** | |
| @types/node | 16.11.56（传递） | **24.9.0**（显式） | 修 TS 5.9 下 `Buffer`/`ArrayBufferLike` 报错 |
| @ffprobe-installer/ffprobe | 1.4.1 | **2.1.2** | 二进制 2021-08 → 2023-02 |
| dayjs / less / fluent-ffmpeg | 1.11.7 / 4.1.3 / 2.1.2 | 1.11.23 / 4.9.1 / 2.1.3 | |
| @vicons/ionicons5 | 0.12.0 | **0.13.0** | |
| @types/fluent-ffmpeg、@types/nedb | 2.1.20、1.8.13 | 2.1.28、1.8.16 | |
| `engines.node` | `^14.18 \|\| >=16` | **`>=22.12.0`** | vite 7 与 electron 44 的硬要求 |

**删除（全库含 HEAD 零引用）**：`shelljs`、`@vicons/material`、`iconv-lite`
（`iconv-lite` 只在 `vite.config.ts` 的 renderer 名单里出现过名字，源码零 import；
那个名单本身也是坏的 —— 见第二节③）。

## 二、升级中抓到的三个「能编译、运行期炸」的真 BUG

### ① vpe 1.x/0.29 默认把 `dependencies` 打进主进程 bundle → 抽帧必失败

- **现象**：`vite build` exit 0，但 `dist/electron/main/index.js` 从 16.17 kB 变成 137.32 kB，
  里面出现了 `__dirname.substr(0,__dirname.indexOf('node_modules'))`。
- **根因**：`@ffmpeg-installer/ffmpeg`、`@ffprobe-installer/ffprobe`、`fluent-ffmpeg`
  都用 `__dirname` 定位自己包内的文件（`ffmpeg.exe` / `presets`）。
  内联后 `__dirname` = `dist/electron/main`，`indexOf('node_modules')` 返回 **-1**
  → 三个候选路径全不中 → 抛 `Could not find ffmpeg executable`。
- **为什么旧版没事**：vpe 0.9.1 默认外置 package.json 的依赖（产物里是 `require("fluent-ffmpeg")`）。
  v1 起默认只外置 node 内置模块。
- **修法**：官方开关 `notBundle()`（`vite-plugin-electron/plugin`），main 与 preload 各挂一个。
  → 产物回到 **15.63 kB**，`require` 列表与升级前逐项一致。
- **证据**：`grep -o 'require("[^"]*")' dist/electron/main/index.js | sort -u`

### ② vite 8(rolldown) 把渲染层的 `require("electron")` 优化成裸 ESM import → 整页白屏

- **现象**：无头探针加载 `dist/index.html` 后 `#app` 子节点数 **0**，控制台
  `Uncaught TypeError: Failed to resolve module specifier "electron"`。
- **产物对比**：
  - vite 3：`const Sa = require("electron")` ✅
  - vite 8：`import{ipcRenderer as e}from"electron"` ❌（`file://` + `type="module"` 解析不了裸标识符）
  - vite 7：`const rt = typeof require<"u" ? (function(){return require("electron")})() : ...` ✅
- **试过并否掉的修法**：`renderer: { resolve: { electron: { type: 'cjs' } } }` —— 实测无效。
- **修法**：留在 **vite 7** + renderer **0.14.7**。
- **证据**：`grep -c 'from"electron"' dist/assets/index-*.js` 必须为 **0**。

### ③ npm 在 Windows 上静默丢了 3 个文件 → 打包直接报错

- **现象**：`electron-builder` 报 `Cannot find module .../node_modules/http-proxy-agent/dist/index.js`。
- **根因**：文件被占用时 npm 会把待删文件改名成 `index.js.DELETE.<hash>` 然后删不掉
  → 包残缺。中招的是 `agent-base` / `http-proxy-agent` / `https-proxy-agent` 的 `dist/index.js`
  （都在 `builder-util` 这条链上）。
- **修法**：删掉这 3 个包目录后 `npm install`。
- **自检**：`find node_modules -name "*.DELETE.*"` 必须为空。

## 三、验证证据（都是真跑的，不是推理）

| 门禁 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npm run typecheck` | exit 0（`vue-tsc --noEmit` + `tsc -p tsconfig.electron.json`） |
| 构建 | `npx vite build` | exit 0；主进程 15.63 kB、渲染层 `from"electron"` = 0 |
| 无头主进程 | 隔离探针（Electron 44 + 真实 `electron/server` 代码，端口 3061、数据目录隔离） | 无口令 **403** / 带口令 **200** `hi! i\`m ace.` / 未知路由 404 / 错口令 403；`electron=44.4.5 node=24.21.0 chrome=152.0.7977.130` |
| nativeImage | 同一探针 | `folder.png` → 76×64、不存在路径 → `isEmpty=true`（降级契约成立）、`resize+toJPEG` 正常 |
| 渲染层（产物） | 隐藏窗口 `loadFile(dist/index.html)` | `#app` 子节点 **1**，正文 `请选择文件夹(D) 搜索 S`，`sendSync('ff-token')` 正常 |
| 渲染层（dev） | 隐藏窗口 `loadURL(http://127.0.0.1:3344/)` | `[vite] connected` + 同样渲染成功（用 `VSCODE_DEBUG=1` 阻止 vpe 自动弹窗） |
| 打包 | `npx electron-builder --dir -c.directories.output=release-verify/${version}` | exit 0；包内 `fluent-ffmpeg`/`nedb`/`dayjs` 都在、`shelljs` **0 条**；`app.asar.unpacked` 里 `ffmpeg.exe`/`ffprobe.exe` **仍在** |
| 安全 | `npm audit` | 36 → **5** 条（剩的是 `lodash`/`lodash-es`/`nedb`/`underscore` 链上的传递依赖） |

**数据安全**：探针全程用 `_probe_ver/data`，用户真实库 `%USERPROFILE%\.file-finder`
的 `searchCache.db` 时间戳（14:26:22）早于探针运行（≈14:48）→ **未被触碰**。

## 四、未做 / 未实测

- **界面渲染得对不对、交互对不对**：无头环境验不了（能证明的只有"能加载、能执行、能挂载"）。
  需要用户重启 `npm run dev` 目视。
- **vite 8**：不上，理由见第二节②。
- **`@ffmpeg-installer/ffmpeg`**：1.1.0 已是该包最新（2021 年后停更），但它自带的
  `ffmpeg.exe` 是 **2018-12-17** 的版本。要真正更新只能换包（如 `ffmpeg-static`）——
  那会动 `app.asar.unpacked` 的布局与 `setFfmpegPath` 的调用，属结构变更，未动。
- **`less` 挂在 `dependencies`**：构建期工具，却让包内多出 136 个文件。挪到 devDependencies
  属结构变更，等用户点头。
- **Node 24 弃用警告**：`electron/server/index.ts` 的 `url.parse`、`nedb` 的 `util.isArray`。
  现在只是 warning，未来会移除；未动用户代码。
- **`release-verify/`**：沙箱回收站对大目录失败（`trash operation ... aborted`），删不掉，
  已加进 `.gitignore`，需用户在资源管理器删。

## 五、回滚

`.deps-backup/`（已 gitignore）里有升级前的 `package.json` 与 `package-lock.json`：

```bash
cp .deps-backup/package.json.bak package.json
cp .deps-backup/package-lock.json.bak package-lock.json
npm install
```

注意：electron 20 的二进制仍在 `~/AppData/Local/electron/Cache`（2022 年的 zip），可离线回滚。

---

## 六、运行期崩溃修复：`nedb` → `@seald-io/nedb`（2026-09-24 15:10 起）

### 现象

升级后一启动就抛（用户截图）：

```
Uncaught TypeError: util.isDate is not a function
    at Datastore.getCandidates (nedb/lib/datastore.js)
    at Cursor._exec (cursor.js) ... at Persistence.loadDatabase
    at electron\server\nedb.js:64          ← 项目自己的 nedb 模块
```

### 根因（实测，不是推理）

Electron 44 自带 Node **v24.21.0**，`util.is*` 只剩两个：

```
$ ELECTRON_RUN_AS_NODE=1 electron.exe -e "console.log(Object.keys(require('util')).filter(k=>k.startsWith('is')))"
["isArray","isDeepStrictEqual"]
```

而 `nedb@1.8.0` 内部用了 `util.isDate`（datastore.js、model.js）和 `util.isRegExp`（model.js），
**没有任何更新版可升**（`npm view nedb version` = 1.8.0，2016 年后停更）。

**最小复现**（真实库副本）：

```
$ ... -e "db.count({v:{$ne:2}})"
TypeError: util.isDate is not a function
    at isPrimitiveType (nedb/lib/model.js:149)      ← 实测
```

启动时的触发链：`electron/server/index.ts:810` 的 `dropLegacyRecords()` → `count({v:{$ne:2}})`。
用户截图里的 `getCandidates` 与这条 `isPrimitiveType` 是同一个 `util.isDate` 的两个调用点。

> **这是上一轮的漏测**：探针只打了 `/` 健康检查，**没走到 nedb 查询路径**，所以没暴露。

### 修法：换掉这个死依赖，而不是给 `util` 打补丁

| 方案 | 代价 | 实测/判定 |
|---|---|---|
| A. 给 `util.isDate` / `isRegExp` 打补丁 | 6 行、不动依赖 | ❌ **打补丁**。Node 已把 `util.isArray` 标成 DEP0044，下次 Node 升级同样复发；责任放错位置（改的是运行时契约，不是问题所在） |
| **B. 换 `@seald-io/nedb@4.1.2`（社区续作）** | 依赖 +1.2 MB | ✅ **采用** |
| C. 换其他嵌入式存储 | 改动最大 | ❌ |

**B 的取证（全部跑在用户真实 8.2 MB `searchCache.db` 的副本上，不动原件）**

1. **数据文件双向兼容**：载入 22 条；`findOne(serial,relPath,mode)` 命中且 `data` 13 条完整、
   `data[0]` 带 `thumbData`；写出的仍是同一套 NDJSON，`$$indexCreated` 标记一致。
2. **`dropLegacyRecords()` 的正确性前提仍在**：`{v:{$ne:2}}` 仍匹配"字段不存在"的文档 ——
   拿旧的 `searchCache-20260924.db` 验：总 3 条、无 `v` 的 3 条、`count({v:{$ne:2}})` = **3** ✅
3. **`compact()` 必须重写**：v4 把内部队列全异步化了（`executor.push`→`pushAsync`、
   `persistCachedDatabase`→`persistCachedDatabaseAsync`），原来那套私 API 写法**直接失效**
   （实测：两个字段都取不到）；而公开 `compactDatafile(cb)` 现在**收回调**，内部走的就是同一条队列
   （`executor.pushAsync(persistCachedDatabaseAsync)`）→ 改用公开 API，不再引用任何私有字段。
4. **公开 API 形状 9/9 通过**：`loadDatabase` / `ensureIndex` / `findOne` / `insert` /
   `remove`(两种形态) / `count` / `find().projection().sort().exec()` / `remove({_id:{$in}})`。

### 改了什么

| 文件 | 改动 |
|---|---|
| `package.json` | `nedb@^1.8.0` → `@seald-io/nedb@^4.1.2`；删 `@types/nedb`（新包自带 `index.d.ts`） |
| `electron/server/nedb.ts` | ① import 换包；② `loadDatabase()`/`ensureIndex()` 补回调；③ `loadMeta()` 投影改走 Cursor；④ `compact()` 改用公开 API。其余 9 处调用一字未动 |

两处必须说明的**行为对齐**（不是加功能）：

- **补回调**：v4 把"不给回调"实现成"promise 建了没人接"
  （`datastore.js`:`if (typeof callback === 'function') callbackify(() => promise)(callback)`），
  而旧版是 `var callback = cb || function () {}` —— 静默吞掉。实测：损坏的库会泄漏
  `unhandledRejection`（`100% of the data file is corrupt`）。补回调 = 维持"加载失败不把进程带走"，
  顺带把静默失败变成一行可见日志。
- **投影走 Cursor**：v4 的 `index.d.ts` 第一个重载是 `find(query, projection, callback?) => void`，
  两个参数的形式会被它吃掉 → `.sort()` 在类型层面不存在。改成
  `find({}).projection({data:0}).sort(...)` 后类型通过；行为实测一致（22 条无一带 `data`，整包 3213 B）。

### 验证（本轮实测）

| 项 | 命令 | 结果 |
|---|---|---|
| 类型 | `npm run typecheck` | exit 0 |
| 构建 | `npx vite build` | exit 0；主进程 **15.45 kB**（依赖未被内联） |
| 产物自检 | `grep -o 'require("[^"]*")' dist/electron/main/index.js` | 有 `@seald-io/nedb`、**无** `nedb`；渲染层 `from"electron"` **0 条** |
| 模块级 e2e | 真实 `nedb.ts`（esbuild `--packages=external`，与生产 `notBundle()` 同契约）+ 真实库副本 | **12/12**：原崩溃点 `dropLegacyRecords()` OK、`loadMeta()` 22 条无 `data`、`findCache()` 命中、写链路、`compact()` 且压缩后数据仍在 |
| 应用级启动 | 无头启动**构建产物主进程**（隔离数据目录 + 真实库副本），打它自己的 3060 | `GET /` 200；`GET /getHistory` **200，total=22**（真实记录、无 `data`）；`GET /getDisks` 200；**全程无 `util.isDate`** |

### 未实测（如实标注）

- **`npm run dev` 的窗口目视**：没跑（会弹窗）。主进程 nedb 层与构建产物逐字相同，但**界面要用户看一次**。
- **打包**：`electron-builder --dir` 本次**失败**，原因是沙箱批量删除护栏
  （`SAFE_DELETE_BULK_CONFIRM_REQUIRED count:79`，它要清上一轮遗留的 `release-verify/`），**与本次改动无关**；
  该目录在本环境删不掉（回收站对大目录 `aborted` → FAIL_CLOSED，`rm` / PowerShell 都被挂钩）。
  侧面证据：生产依赖树（`npm ls --omit=dev --all`，70 项）里 `@seald-io/nedb`、`@seald-io/binary-search-tree`
  与 `util` polyfill 链都是 production 分类 → 会被打进 asar。用户删掉 `release-verify/` 后可自行跑 `npm run build` 复核。

### 顺带发现（未处理，不影响运行）

`node_modules` 里有 **178 个 npm 残留空壳目录**（`.ajv-TDkZqkPI`、`.agent-base-isAIeedt` …），
时间跨 2023-09 ~ 2026-09。**上一轮记的判据 `*.DELETE.*` 不是本环境的命名** —— 真实命名是 `.<包名>-<hash>`。
已核对 `agent-base` / `http-proxy-agent` / `https-proxy-agent` 的 `dist/index.js` **都完整**；
清理 178 个目录会被护栏拦，留给用户决定。
