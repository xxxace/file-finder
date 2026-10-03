# 垃圾文件 / 死代码 / 会误导人的过期结论 · 2026-10-03

> ⚠️ **处理顺序与连带项以 `docs/VERDICT-2026-10-03.md` 为准**（第三版，含两路独立核查后的修正）。
> 本文件的删除清单**不完整** —— 漏了 4 处"删了必须一起删"的连带项（注释块 / 私有成员 / 模板孪生兄弟），
> 详见 VERDICT §三。保留原文供追溯。

---

> 证据等级：**实测**（全部用 `grep` / `ls` / `stat` 逐条核过，不是回忆）。
> 判据：① 零引用且**不可能**被运行时用到；② git 未跟踪、纯占盘；③ **结论已被推翻但没标记**（最危险的一类）。
> ⚠️ 本文件**只列证据，不动任何东西** —— 删不删、什么时候删由主人定。

---

## 零、A类：**会误导人的过期结论**（最该先处理）

### A1. `docs/CHANGES-2026-10-02.md` §七 —— 把"相关"写成了"真根因"

**原文（第 346-348 行）**：

> **真根因（静态证据）**：`require.resolve('app-builder-bin')` → `MODULE_NOT_FOUND`，
> `node_modules` 里只剩 npm 的暂存目录 `.app-builder-bin-YaNL61c1` ⇒ 图标转换那一步必然调不到工具。

**实测反驳（2026-10-03）**：

| 核什么 | 结果 |
|---|---|
| 那个暂存目录的 mtime | **2022-09-12**（`stat` 实测）⇒ 四年前的旧版残留 |
| 里面的版本 | `app-builder-bin@4.0.0` |
| `electron-builder@26.15.3` 依赖表里有它吗 | **没有** |
| 全库真 `require('app-builder-bin')` | **0 处**。只有 `certInfo.js:321` / `yarn.js:146` 两处**注释**提到 |
| 主人 2026-10-03 反馈 | 「可以跑啊我都跑完了」 |

⇒ **它与打包失败没有因果关系。** 真实卡点是同段列的 1、2 两条
（safe-delete 阈值 50 > 81 文件、沙箱拦 EPERM 改名），**不是** `app-builder-bin`。

**危害**：它写成了「真根因（静态证据）」这种**加粗断言**，
我 2026-10-03 第一轮评估**直接把它当成了事实**，还据此排了"第 1 优先级"。
**一个"静态证据"标签就能骗过我一次，就能骗过以后的我。**

**建议**：加一行撤回标记（不必删原文，它是决策历史的一部分）。
**这是本文件里唯一一条"改一个字就能防止再犯"的。**

### A2. `docs/probes/icon-render/out-build.txt` + `README.md` —— 同一错误根因的副本

同一结论的另两份落盘（探针原始输出 + 解读）。
`out.txt` 是探针证据按惯例**不可改**（原始记录），但 **`README.md` 里的解读需要加撤回标记**。

### A3. `README.md` —— 整个文件是 electron-vite 模板残留

- 标题 `electron-vite-vue`、描述 `Really simple Electron + Vue + Vite boilerplate.`
- `package.json` 的 `description` 也是同一句
- 末尾 `## ToDo` 五条：全是**已完成或已否决**的事（"视频第一帧当封面 √"、"右键菜单 √"…）
- Features / Quick Start / Directory / FAQ 全被 `<!-- -->` 包着

**危害**：新会话（我或主人自己）读 README 会以为这是"某教程项目"，不知道真实功能。
`package.json` 的 `description` 还会进 exe 的文件属性。

### A4. `CHANGELOG.md` —— 2021-2022 年模板的版本记录

四条记录全是 `electron-vite-vue` 上游的，**没有一条是这个应用的**。
从 2022-06 跳到 2026-10，中间 **104 个提交**（全部真实工作）一个字没记。

**危害**：比"没有 CHANGELOG"更坏 —— 它**看起来**像有历史。

---

## 一、B类：**死代码**（零引用，运行时不可能用到）

### B1. `src/hooks/useFileTypeIcon.ts` —— 整个文件没人用 ✅ 确认可删

```
grep -rn "useFileTypeIcon" src/ electron/   →  只有它自己
```

**主人 2026-10-03 的反问：「那出现其它类型的文件时怎么办？不用吗？」**
这个问题救回了一个错误判断 —— 核查结论：

- **未知类型走的是另一条路**：`index.vue:168` 的 `` `file-cover fiv-cla fiv-icon-${item.ext}` ``
- 那套 `fiv-*` 图标来自 **`file-icon-vectors`**（`main.ts:4-5` 引入 CSS），
  `dist/file-icon-vectors.min.css` 与 `file-icon-classic.min.css` **各含 363 种类型**
- ⇒ **出现任何扩展名都有图标**，而且是 CSS 背景图、**零额外请求、零读盘**

⚠️ 我核查时还犯过一个错：第一遍用 `grep "fiv-icon-mp4:"` 找，**17 个扩展名全报"不存在"** ——
因为压缩后的 CSS 选择器是 `fiv-icon-mp4{...}`（**没有冒号**）。
**改正后 mp4 在库里。** 若按第一遍结果下结论，就会误删整套图标体系。

⚠️ **`fileTypeIcon/` 里 17 个 svg（7z/avi/mkv/pdf…）确实零引用**，可以删：
- 活着的只有 `folder.png`（`index.vue:247` 直接 import）+ `blank.svg`（`index.vue:1805` 作 CSS 兜底）
- `useFileTypeIcon.ts:12/14` 也引用这两个 —— 删 hook 时一起清掉

**判断**：能力**没有被牺牲**（fiv 库 363 种类型覆盖更广），只是**删掉了一套没接线的备用实现**。
若你想**留个保险**（比如 fiv 库不认的罕见扩展名），也可以只删 hook、留 svg 文件 ——
但那样 17 个文件就是纯死重量，**我倾向一起删**。

### B2. `src/utils/index.ts` 的 `printTree()` —— 死函数

```
printTree -> 4 处命中，其中 3 处是：
   src/utils/index.ts:67        ← 它自己递归调用自己
   src/views/FileFinder/index.vue:889-891  ← 全部在注释块里（handleDirRootChange）
```
唯一真实调用方 `handleDirRootChange` 已被整段注释（`index.vue:884-898`）⇒ **零外部引用**。

### B3. `src/utils/index.ts` 的 `parseSize()` —— 死函数

```
parseSize -> 0 处使用
```
⚠️ 它是**已知的坏函数**（记忆里：`parseSize` 曾把 TB 截断，因为写的是 `% 1024` 而非 `1024 ** 3`，
已由 `formatBytes` 取代）。**留着它 = 留着一个人人知道有 bug、谁都不知道有多错的函数** ——
下一个人（或以后的我）很可能重新用它。**这比死代码更危险。**

### B4. `src/views/FileFinder/index.vue:884-898` —— 注释掉的 `handleDirRootChange`

15 行注释代码，唯一用途是调 `getFileTree` + `printTree`（B1/B2 的消费者）。
模板里还有一处 `<!-- <n-space> <FolderSelector v-model="dirRoot" .../> </n-space> -->`（约 76-78 行）。

### B5. `electron/server/index.ts:456` `getFileTree()` —— **注册着的活路由，但零调用方**

```
route('/getFileTree', getFileTree);   ← 注册了
前端引用：只有 index.vue:885 的注释
```

**为什么它排在死代码类的前面**：它是**活的**（注册进 `route()` 咽喉点、能被真实请求打到），
而且**会递归 `stat` 整块盘**（`collectCodeList`）。
有口令闸（`?t=` 校验，`server/index.ts:1325`）所以**不是安全漏洞**，
但它是一条**没人用、却能整盘读盘**的路由 —— 与最高优先级铁律直接冲突。

**建议**：删掉路由 + `collectCodeList`（约 40 行）。若主人想保留"导出目录树"这个能力，
那就**明确保留并加注释说明它有代价**，别半悬着。

### B6. ~~`src/utils/flexible.ts` 死文件~~ ❌ **已撤回，保留！差点删错**

**我第一版的推理**：它算 rem，但全项目只有 2 处 rem（`grep [0-9]rem` = 2）⇒ 判定空转。

**反证（实测）**：
- `flexible.ts` 设的是 `docEl.style.fontSize = clientWidth/10` ⇒ **`1rem` 是响应式基准**，不是死值
- `index.vue:1703` 的 **`--item-height: 1.5rem`** 消费了它 ⇒ `height: var(--item-height)`（1710/1711 行）
- 1280 窗口下 `1rem = 128px` ⇒ `1.5rem = 192px`，且**随窗口宽度缩放**
- 删掉它 ⇒ 浏览器默认 `1rem = 16px` ⇒ **格子高度从 192px 塌到 24px**，网格彻底崩

⚠️ **另外它还有两个副作用**（也被查了）：
- `.hairlines`（0.5px 边框支持）—— 项目**未消费**（`grep hairlines` 只命中它自己）
- `body.style.fontSize = 12*dpr` —— 样式里全部显式写了 `font-size: 12px/14px`，**未消费**

⇒ **结论：文件必须保留**（`1rem` 基准在用）。
那两个未消费的副作用只是"无害的多余代码"，**不是删文件的理由**。

**教训**：**"grep 到 rem 的用法只有 2 处"不等于"这个 rem 机制没用"** ——
要问的是**那个基准值是谁提供的**。`flexible.ts` 是**提供者**，不是**消费者**；
只查消费者会得出反向结论。
**判据固化**：判"某个机制有没有用"，必须同时查**生产者**和**消费者**，只看一侧会得出反向结论。

### B7. 模板残留资源（`src/assets/` + `public/`）—— 约 3.5 MB

| 文件 | 大小 | 引用数 |
|---|---|---|
| `public/electron-vite-vue.gif` | **3.4 MB** | 0 |
| `public/node.png` | 16 KB | 0 |
| `src/assets/electron.png` | 61 KB | 0 |
| `src/assets/vite.svg` | 1.5 KB | 0 |
| `src/assets/vue.png` | 6.7 KB | 0 |
| `src/assets/mp4.svg` | 5.0 KB | 0 |
| `src/assets/vedio.png` | 700 B | 0 |

⚠️ `mp4.svg` / `vedio.png` 特别危险：**名字看起来像业务资源**，实际项目用
`@vicons/ionicons5` 的 `<Search />` + `fileTypeIcon/mp4.svg`（0 引用）。
**只按名字判断会误删在用的东西。**

---

## 二、C类：**占盘但 git 之外**（不影响仓库，只占本机空间）

`git check-ignore` 确认全部在 `.gitignore` 内，**仓库只有 6.4 MB，干净**。

| 路径 | 占用 | 说明 |
|---|---|---|
| `release-verify/` | **901 MB** | 图标验证的临时打包产物，任务已完成 |
| `release/` | **681 MB** | 2022-11 的老构建产物（mtime 2022-11） |
| `searchCache.db` | **78 MB** | ⚠️ **真数据**，见下 |
| `.deps-backup/` | — | 依赖升级回滚备份，`.gitignore` 已挡 |

⚠️ **`searchCache.db` 不能当垃圾删** —— 它是**唯一的真实缓存库**
（实测 208 记录 / 1202 条目 / 4 块盘）。但它出现在**仓库根目录**这件事本身很可疑：
正式运行时 `config.userBasePath` 指向哪？如果真跑起来用的是 `%APPDATA%`，
那这份就是**开发期遗留的孤儿副本**（78191 字节 × … = 78 MB）。
**这一条要查证才能动，我没查。**

---

## 三、D类：**文档层面**（不是垃圾，但会误导判断）

| 现象 | 事实 | 影响 |
|---|---|---|
| `docs/` 36 份 md，其中 17 份是 `09-24` | 当天批量产出 | 大量中间态设计稿，**没标"已实施/已作废"** |
| `SPIKE-S1-runbook` / `spike-S1-result` | 09-25 的**一次性探针** | spike 做完就该归档，不是活文档 |
| `UPGRADE-PLAN` / `DEPS-UPGRADE` / `BATCH2-*` | 依赖升级批次记录 | 09-24 那一波已结束 |
| `AUDIT-*` / `VERIFY-*` / `CODE-REVIEW` | 审计与评审 | **含 A1 那种过期结论**，是误导源的主要产地 |
| `PROJECT-MEMO` / `DESIGN-CONVERGED` | 记忆索引里标为"开工先读" | 若含过期事实 ⇒ **污染每一次开工**（风险最高，需优先核对） |

**建议一条规则**（不删任何文件）：
> 每份 docs 顶部加一行状态标记：`[已实施] [已作废] [历史参考]`。
> 记忆索引里"开工先读"的那几份必须先核对状态。

---

## 四、建议的处理顺序（**我没有动任何东西，等你点头**）

| 序 | 做什么 | 收益 | 风险 |
|---|---|---|---|
| **1** | **给 A1 那一行加撤回标记** | 一行字，**断掉"静态证据"标签的欺骗链** | 无 |
| 2 | A3+A4：README / CHANGELOG 重写或标注 | 新会话不再被模板残留带偏 | 无（README 反正已不可用） |
| 3 | B5：删 `getFileTree` 路由 + `collectCodeList` | **消掉一条"没人用却能整盘读盘"的活路由** | 无调用方，`route()` 是唯一出口，删干净即可 |
| 4 | B1+B2+B3：删 `useFileTypeIcon.ts` / `printTree` / **`parseSize`** | 少 3 个陷阱，其中 `parseSize` 是**已知有 bug 的** | 无引用；但 19 个图标文件随之失去"引用者"（它们本来就不加载） |
| 5 | B6：删 `flexible.ts` + `main.ts:3` 那行 import | 去掉"算了但没人用"的 rem 计算 | 需确认将来不用 rem |
| 6 | B4：删注释块 | 减 15 行噪音 | 无 |
| 7 | B7：删 7 个模板资源（**3.4 MB 的 gif 优先**） | 减 3.5 MB | ⚠️ 按**引用数**删，不按文件名猜 |
| 8 | 查 `searchCache.db` 到底是孤儿还是活库 | 可能减 78 MB | **必须先查证**，它是真数据 |
| 9 | C 类加状态标记 | 新会话不再误读历史设计稿 | 无 |
