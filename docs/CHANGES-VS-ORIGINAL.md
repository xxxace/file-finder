# 我的改动 vs 原版：完整差异对照

**为什么要写这个**：你提醒「先确认清楚是否真的有问题，不要乱修」。我按这个要求把重构前后的 `electron/server/index.ts` 逐函数对照了一遍，
并逐条核对了每一个被我删除的文件在**被删之前的版本**里到底有没有引用。

**最重要的教训（方法论错误）**：
> 我多次是**先改掉调用方，再回头 grep 说"它没被引用"**，然后把它当死代码删掉。
> 这是自证式删除 —— grep 的结果是我自己造成的，不能作为"它是死代码"的证据。
> 正确做法是 `git show HEAD:<路径>` 取**被删之前**的版本再 grep。

---

## 一、裁决结果（2026-09-24）

你说「我不确定这些是不是都要的，因为我不知道你给我加了什么」+「你按对的方式来」。
所以下面每条都是我**重新取回被删之前的原文核完之后**的裁决，每条附依据。

| # | 事项 | 裁决 | 依据（一句话） |
|---|---|---|---|
| ① | 目录树导出（`/getFileTree` + `printTree`） | **已恢复** | 后端 API 在原版是**活的**，`list.txt`（628 KB）就是它产的 |
| ② | `electron/server/read.ts`（查卷标） | **不恢复** | 里面两个函数**函数体自己就是注释掉的**，恢复 = 恢复注释 |
| ③ | `FileFinderDocker`（抽帧落盘） | **不恢复原实现** | 你已定「只恢复效果，不写盘」——见下文 |
| ④ | `getFileType` 靠扩展名判类型 | **已修** | 渲染层只认 `type`，猜错就是"点不动"；`stat.isDirectory()` 本来就在手上 |
| ⑤ | `handleCover` 的 `if (!isVideo(ext))` | **保持删除** | 实测恒为真，删掉行为零差异；留着反而让读代码的人困惑 |
| ⑥ | 封面正则我加的 `/i` | **保持加了** | Windows 文件名不区分大小写，`ABC.JPG` 本来就该算封面；原版是漏了 |
| ⑦ | `files[]` 只留 `{name, size}` | **保持收窄** | 原版 `...整个 fs.Stats` 会把 `dev`（卷序列号）冻进缓存，违反你定的「盘符不是身份」 |

### ① 目录树导出 —— 已恢复

原版是**三层**，只有最下层是活的：

| 层 | 原版状态 | 现在的处理 |
|---|---|---|
| `GET /getFileTree` → `getVideoCodeList` → `collectCodeList` | **活的 API** | **已恢复**，并把 `readdirSync`+`statSync` **同步递归改成异步** —— 原来扫一整块移动硬盘会把主进程按住几十秒 |
| `src/utils/index.ts` 的 `printTree` / `getSpace` / `level_stack` | 活的**导出函数**，但调用方全是注释 | **原样还原**（已 `git diff` 确认与 HEAD 一致） |
| `index.vue` 的 `handleDirRootChange` + `dirRoot` + 模板第二个 `FolderSelector` | **原版就是注释掉的** | **原样还回去** |

`list.txt` 的生成方式（现在也一并还原了）：

```js
// index.vue —— 选一个盘根，控制台输出 URL 编码的树
console.log(encodeURIComponent(printTree(data, 0, 2, ``)))
```

**`list.txt` 我没有重建** —— 重建要重新扫你整块盘。想要的话两种方式：
- 浏览器开 `http://127.0.0.1:3060/getFileTree?path=F:/` 直接拿 JSON
- 或打开 `index.vue` 里那段注释、换回模板里第二个选择器，用控制台导出

### ② `electron/server/read.ts` —— 不恢复

全文只有 6 行活代码，**而且这 6 行里没有一个活引用**：

```ts
import process from 'child_process';
const cmd = {
    getAllDrive: () => 'wmic logicaldisk get deviceid',
    getDriveNameByDeviceId: (deviceid) => `wmic logicaldisk where name="${deviceid}:" get volumename`
}
export type DiskInfo = { deviceid: string; volumename: string }

// export function getAllDrive() { ... }   ← 函数体被注释掉了
// export function readdisk() { ... }      ← 函数体被注释掉了
```

用它的那两个函数自己就是注释。所以它不是"我删掉了卷标能力"，而是**当年就没接上**。

证据一致：`driveIdentity.ts` 里 `label` 恒为空串，你机器 4 块盘的 `disks.json` 实测全是 `"label": ""`。

**如果你真想要「盘列表显示卷标」**，那是**新增功能**（PowerShell `Get-Volume` 或 `wmic` 读一次即可），不是恢复。说一声我做。

### ③ `FileFinderDocker` —— 不恢复原实现（你已定：只恢复效果，不写盘）

原版 `getThumbnail` 的真实链路：

```ts
if (!fileFinderDockerManager.hasDocker(root)) fileFinderDockerManager.mkdocker(root);
const fileDockerPath = fileFinderDockerManager.getFileDockerPath(root);
if (!fileFinderDockerManager.hasFile(root, fileInfo.name + '.png')) {
    await mkthumbnial(filepath, { timestamps: ['1%'], filename: fileInfo.name + '.png', folder: fileDockerPath });
}
return await getBase64(`${fileDockerPath}/${fileInfo.name}.png`);
```

即：**抽帧结果存到 `<盘>:/file-docker/<视频名>.png`，同一个视频第二次直接读 png，不再抽帧。**

被牵连删除的：`electron/utils/FileFinderDocker.ts`、`electron/utils/ffmpeg.ts` 的 `mkthumbnial`（**它是被 `getThumbnail` 调用的**）、仓库根 `file-docker-list.txt`。

你盘上现状：`D:/file-docker` 还在、但是**空的**（0 个文件）；`file-docker-list.txt` 原内容 35 字节 ≈ `D:/file-docker`。

**原设计的三个代价**（这是不原样恢复的理由）：
1. 往**移动硬盘**写文件 —— 与你的第一目标"少碰移动硬盘"相反
2. 盘上多一个 `file-docker` 目录，而它**不在 `excludedFiles` 里** → 浏览时会看到它
3. 存的是**原图 png 的 base64** → 这是 `searchCache.db` 涨到 107 MB 的成因之一

**它真正值钱的效果**是「重扫不重抽」。这个效果有两种实现，待你选：

- **方案 A**：按 `files[].name` 匹配 DB 里已有的缩略图（简单，但 `示例演员E` 那种目录匹配不上 —— 里面的视频是独立条目、不在任何 `files[]` 里）
- **方案 B**（我倾向）：给 `readFolder` 传一个「本盘已登记缩略图的**盘内路径**集合」，`handleCover` / `readFolder` 遇到文件级视频就复用，**彻底跳过 ffmpeg**

### ④ `getFileType` —— 已修（本轮唯一的真实行为变更）

原版：
```ts
function getFileType(ext?: string): FileKind {
    if (!ext) return 'folder';          // 没有扩展名 → 当目录
    ...
}
```

等于用"文件名里有没有点"猜目录。两个方向都会错：

| 名字 | 原版判定 | 应该是 | 后果 |
|---|---|---|---|
| `README` / `LICENSE` / `Makefile` | `folder` | `file` | 显示成文件夹，点进去是空的 |
| `TST-001.2023` / `v1.2`（目录） | `file` | `folder` | 显示成普通卡片，**点了没反应** |

而渲染层**只认 `type`**：`folder` 才显示文件夹图标、才允许进入；`image`/`video` 才出缩略图。猜错就是硬伤。

现在：
```ts
type: stat.isDirectory() ? 'folder' : getFileType(ext),   // 调用点
function getFileType(ext = ''): FileKind { ... }          // 不再处理"无扩展名 = 目录"
```

`stat.isDirectory()` 是**真实值**而且**已经拿到手**（同一次 `stat`），零额外开销。

**你盘上实测：大写扩展名图片 0 个、无扩展名文件 0 个、带点的目录 0 个 → 当前数据零变化**，修的是将来会错的情况。

### ⑤ ~ ⑦ 保持原样的三处

**⑤ `if (!isVideo(ext))`**：`coverIndex` 的正则只匹配图片扩展名，所以 `isVideo(ext)` 恒为 false，那层判断恒真。
删掉它行为完全不变（已实测）。它的语义我用注释留在了原地。

**⑥ 封面正则的 `/i`**：Windows 文件系统本身不区分大小写，`ABC.JPG` 和 `abc.jpg` 是同一个文件。
原版正则漏了这个标志，导致大写扩展名的封面图会被跳过。加上是对的。

**⑦ `files[]` 收窄成 `{name, size}`**：原版 `{ name, ...整个 fs.Stats }` 会把 `dev`（扫描那一刻的卷序列号）
也序列化进缓存 —— 这套设计的前提是「盘符不是身份、序列号才是」，把 `dev` 冻进数据等于又抄了一份身份进去。
而且渲染层实测只用 `name`（`v-for` 的 key、双击打开、找视频三处都只读 `name`）。

---

## 二、确认删对的（0 引用，可放心）

| 文件/符号 | 在**被删之前的版本**里的引用情况 |
|---|---|
| `src/components/HelloWorld.vue` | 只有它自己 |
| `src/components/ItemFrame/index.vue` | `FolderSelector` 里只出现一个**同名 interface**（`ItemFrameProps`），没有 `<ItemFrame>` 使用；组件本身只渲染 `{{props.src}}`，且 `defineProps<...>({src:'123'})` 是无效写法 |
| `src/views/PageLocking/index.vue` | 0 处 |
| `src/samples/node-api.ts` | 只有被注释掉的 import |
| `src/hooks/useFileTypeIcon.ts` + 16 个图标 svg | 只被 `index.vue` 里**注释掉的** import 引用 → **已按你的选择恢复** |
| `electron/server/read.ts` | 0 处活引用（见 ① ②） |

---

## 三、被我删除、且我判定"新架构下不再需要"的（如果你还要入口，说一声）

| 原版 | 作用 | 判定依据 |
|---|---|---|
| `POST /updateDrive` → `updateDrive` + `updatePathOrDir` + `findAllByPath` + `pLimit(4)` | 盘符变了之后，把缓存里所有 `H:/...` 批量改写成 `K:/...` | 新版缓存键是 `(卷序列号, 盘内相对路径, 模式)`，**从根上不存盘符** → 盘符变了不需要改写任何数据。这是在实现你"按盘聚合 + A/B 盘不冲突"的要求时自然替代掉的 |
| `src/components/DriveChanger/index.vue` | `/updateDrive` 的前端入口 | **是上一轮的会话删的**，不是我这一轮；新架构下它没有要改的东西了 |

> 附注：我之前在审计报告里写"整个服务端没有任何并发控制"，这个结论**仍然成立**（`pLimit(4)` 在原版里只用于 `updateDrive` 的批量改写，**不是扫描闸门**）。这一点我核对过了，没有误报。

---

## 四、其余行为语义改动汇总

| 位置 | 原版 | 现在 | 影响 |
|---|---|---|---|
| `handleCover` 里的 `if (!isVideo(ext))` | 恒真 | 删除 | 无行为变化（见 ⑤） |
| `handleCover` 找封面图的正则 | 大小写敏感 | 加了 `i` | 见 ⑥ |
| `files[]` 元素字段 | `{ name, ...整个 fs.Stats }` | `{ name, size }` | 见 ⑦ |
| `FileInfoFiles` 类型 | `fs.Stats & { name: string }` | `{ name: string; size: number }` | 同上 |
| 目录条目的 `info.avatar` | **无条件赋值**（`avatar.jpg` 不存在时是 `''`） | 只在真读到图时才赋该字段 | 语义等价（前端 `!!item.avatar` 判定相同），但下发数据里少一个空字段 |
| `collectCodeList` | `readdirSync` + `statSync` **同步递归** | 异步逐层 | 见 ① |

---

## 五、确认修对的（真实缺陷，改的方向没问题）

| 原版 | 现在 |
|---|---|
| `cors()` 用 `Access-Control-Allow-Origin: *` 且 `Allow-Credentials: true`（浏览器本来就拒绝这个组合，等于白写，而 `*` 让任意网页能读本机服务） | 来源白名单（`file://` 的 `Origin: null` / localhost / 127.0.0.1）+ `Vary: Origin` |
| `app.listen(3060)` 不写 host → 绑所有网卡 | `app.listen(3060, '127.0.0.1')` + `error` 监听（端口占用不再崩主进程） |
| POST 空 body → `JSON.parse('')` 抛异常 → 直接带崩主进程 | 已兜住 |
| `child_process.exec(fullpath)` —— 把路径当命令行 | `shell.openPath(win32.normalize(target))` |
| 对话框用 `showOpenDialogSync`（同期按住主进程事件循环，而 3060 服务在同一进程里） | 异步版 |
| `readFolder` 整个循环包一个 `try` → 一项 `stat` 失败让整个目录返回空 | 逐项 `try/catch`，只跳过失败的那一项 |
| 缓存键 = 完整路径（盘符一变就查不到） | 键 = `(卷序列号, 盘内相对路径, 模式)` |
| 缩略图存**原图** base64 | 存 480px JPEG（DB 从 107 MB → 2.7 MB） |
| 渲染层拼 filter 用 `usePinYin()` 返回的数组直接参与 `+`（隐式 `join(',')`，多音字导致搜不到） | 取 `[0]` |
| `onUnmounted` 写在 `onMounted` 回调内部（永不触发） | 移到 setup 顶层 |

---

## 六、我新增的（原版没有）

- `GET /getDisks`：盘列表 + 每块盘的缓存概况 + **克隆盘检测**（卷序列号重复）
- `GET /thumb?k=`：缩略图按短 key 取，带 `Cache-Control: immutable`
- `GET /raw?p=`：点开放大时取原图（流式）
- `electron/utils/driveIdentity.ts`：卷序列号做盘身份（`fs.Stats.dev`），盘符只当"当前挂载点"
- `~/.file-finder/disks.json`：见过的盘注册表 → 离线盘也能在缓存界面列出来
- `CACHE_VERSION` + 旧格式记录回收
- `electron/utils/thumbStore.ts`：缩略图内存索引（**已知问题：Map 无上限、只增不减**）
- `electron/utils/thumbnail.ts`：480px 统一缩略图管线
- `tsconfig.electron.json` + `npm run typecheck`（原来 `electron/**` 完全不在类型门禁内）

---

## 七、首层不收敛 —— 2026-09-24 下午补修

**现象**：打开 `E:/sample/videos`（第一层）看到的是一堆**文件夹图标**，点进去（第二层）封面就正常了。

**根因是两层叠在一起（原版就有的问题，不是重构引入）**：

**① 首层用的是 `folder` 模式。** `handleDirChange` 里写的是
`openStack.push({ mode: 'folder' })` + `fetchFolder(value, 'folder')`，
而 `handleCover`（封面收敛）**只在 `mode === 'cover'` 时才会被调用** ——
所以封面收敛**从来只在第二层生效**。→ 已改成 `cover`。

**② `handleCover` 的分类依据错了 —— 判据改了三轮才找准。**

| 轮次 | 我用的判据 | 用户的反例 | 判据为什么塌 |
|---|---|---|---|
| 1 | 有没有图片 / 视频 | `示例演员E`、`示例演员C` 归错 | 完全没看目录结构 |
| 2 | 里面还有没有子目录 | `示例演员A` 归错 | `示例演员A`（2 部片子、无子目录）和 `示例演员E`（13 部片子、有子目录）本来就是**同一类** —— 都是"演员目录，里面直接放着多部片子"，只是片子数不同 |
| 3 | **这个目录里是一部片子还是多部片子** | — | 站住了 |

关键证据都是目录里的真实内容：

| 目录 | 内容 | 几部片子 |
|---|---|---|
| `TST-024/` | `TST-024.jpg` + `TST-024.mp4` (5.2 GB) | **1 部** |
| `示例演员A/` | `TST-205.mp4` (6.1 GB) + `TST-206.mp4` (7.1 GB) | **2 部** |
| `示例演员B/` | `TST-142.wmv`、`TST-0646.mp4` … 共 5 个 | **5 部** |
| `示例演员E/` | 11 个视频（TST-020、TST-208…）+ 2 个子目录 | **13 部** |

**「摊开」这个行为本身就不该存在。** 它会把多部片子的目录打平到上一层 ——
`示例演员A/` 摊开后第一层冒出两个裸视频，和「番号目录收敛成封面」混在一起，粒度完全乱掉。
（原版就是这么写的，但原版这个分支从来没在第一层跑过，所以谁也没发现。）

**最终实现：**

| 顺序 | 条件 | 结果 |
|---|---|---|
| 1 | 里面还有子目录 | **保持目录** |
| 2 | 纯文件目录、有图片 | 收敛成封面条目 |
| 3 | 纯文件目录、无图片 | **保持目录**（含空目录）|

即：**收敛需要同时满足「没有子目录」和「有图片」，其余一律保持目录。**

**改完后的首层**（实测）：34 个子目录 → **34 格**

| 外观 | 数量 | 例子 |
|---|---|---|
| 封面缩略图 | 9 | `TST-024`、`TST-433`（图名 = 目录名）|
| 文件夹图标 | 25 | `示例演员E`、`示例演员C`、`示例演员F`、`示例演员A`、`示例演员B`、`示例演员D`（空）|

**格子数正好等于子目录数（34 = 34）** —— 第一层的粒度终于和"一级子目录"对齐，这就是最好的验证信号。

**边界（当前数据没出现，先记着）**：若将来出现「有图片 + 多部片子」的目录，
按现在的实现会被收敛成一张封面（吃掉那几部片子）。真遇到了再收紧成「视频数 ≤ 1 才收敛」。

**遗留（当日已修，见第八节）**：`示例演员C` / `示例演员H` / `示例演员I` / `示例演员J` 这 4 个目录里有
`cover.jpg`（演员封面图），但 `readFolder` 只认硬编码的 `avatar.jpg` ——
所以它们现在是纯文件夹图标，`cover.jpg` 没被用作缩略图。

**缓存要重建**：`~/.file-finder/searchCache.db` 里 `videos|cover` 那条是旧逻辑扫的。
**打开后点一下刷新（↻）** 就会走 `noCache` 重扫。

### 方法论教训（比这个 bug 本身值钱）

上一轮我"验证过特性完好"，但那次验证**只复刻了 `handleCover` 的判定逻辑** ——
证明了「规则本身算得对」，**完全没验证「这条规则有没有被调用」**。
规则躺在第二层睡大觉，我却拿第一层的现象得出"一切正常"。

**复刻纯逻辑只能证明「判定对」；要证明「行为对」，必须一路查到调用链和 mode 参数。**

另一条：**探针必须复用被测代码的判定函数**。我第一版探针用 `VID.test(getExt(n))` 去测
已经去掉点的扩展名（`VID.test('mp4')` 恒为 false），差点把结论读反；
实际代码用的是 `VIDEO_EXT.includes(ext)`。**探针里"顺手改写"的判定，就是结论里埋的雷。**

**第三条：判据要选「正在被表达的那件事」，不是它最容易观察到的影子。**

这一条我改了三轮才站住，每轮都是被用户的下一个反例打回来的：

| 轮次 | 判据 | 反例 | 为什么塌 |
|---|---|---|---|
| 1 | 数"图几个、视频几个" | `示例演员E`、`示例演员C` | 完全没看结构 |
| 2 | 看"里面还有没有子目录" | `示例演员A` | `示例演员A`（2 视频、无子目录）和 `示例演员E`（11 视频 + 2 子目录）本来就是一类：**演员目录，里面直接放着多部片子**。"有没有子目录"只是"多部片子"的一个**影子** |
| 3 | 看"**里面是一部片子还是多部片子**" | — | 站住 |

> 影子判据能解释一部分样本，会让你误以为找到了答案 —— 直到下一个反例出现。
> 而且它往往比真判据**更容易观察**（数文件名 vs 判断"这里有几部片子"），所以特别有诱惑力。

**配套动作：分类前先把每个对象的完整"形状"打出来**（内容清单 + 层级 + 体量），
不要只统计数量 —— 数量接近的两个对象，结构可以完全不同。

**第四条：用户给的反例，每一个都要能被同一条规则解释 —— 缺一个就说明规则还不对。**
第一轮我拿 `TST-024`（要封面）和 `示例演员F`（要目录）对上就收工了，
用户马上补了 `示例演员E` 和 `示例演员C` —— 这两个一放进来，原来的规则立刻塌掉。
**验规则要用「用户点过的全部样本」，不是「恰好能对上的那几个」。**

---

## 八、目录封面（目录自己的脸）—— 2026-09-24 下午

### 现象

演员目录（`示例演员C`、`示例演员H`、`示例演员I`、`示例演员J`）渲染的是**文件夹图标**，
而不是它们自己的封面图。点进去反而会看到一张赤裸的 `cover.jpg` 条目。

### 根因：机制在，开关是个硬编码名字

`readFolder` 的目录分支**本来就把目录封面做完了**：

```ts
if (info.type === 'folder') {
    const avatar = await makeThumb(`${filepath}/avatar.jpg`, 'jpg');   // ← 名字写死
    if (avatar) { info.avatar = newThumbKey(serial); info.avatarThumbData = avatar; }
}
```

渲染层那条分支也一直在（`index.vue:51`，且排在 `type === 'folder'` **之前**）：

```vue
<n-image v-else-if="!!item.avatar" :src="thumbUrl(item.avatar)" ... />
```

链路是通的：`wire()` 会 `registerThumb(item.avatar, item.avatarThumbData)` 登记进内存索引，
`scanAndCache()` 把带 `avatarThumbData` 的原文**原样**写进缓存，从缓存读回来时 `wire()` 再登记一次。
**唯一的问题就是名字写死成 `avatar.jpg`，而盘上叫 `cover.jpg`。**

### 连带的第二个 bug

`handleCover` 里选"影片封面"用的是**图片扩展名正则**，`cover.jpg` 也符合：

```ts
if (coverIndex === -1 && /\.(jpe?g|png|...)$/i.test(file)) { coverIndex = i; continue; }
```

现在这 4 个目录都还有子目录，会在第一关就 `return null`，所以没发作。
但**一旦某个演员目录里直接放片子（没有子目录）**，`cover.jpg` 就会被当成影片封面去收敛 ——
一张演员头像吃掉里面所有片子，首层只剩一张脸。

一句话：**`avatar.jpg` / `cover.jpg` 是"目录的脸"，不是"某部片子的封面"，这两个语义不能共用一个名字池。**

### 改动（四处，都在 `electron/server/index.ts`）

| 位置 | 改法 |
|---|---|
| 常量区 | 新增 `DIR_COVER_FILES = ['avatar.jpg', 'cover.jpg']` |
| 辅助函数 | 新增 `isDirCover(name)`，大小写不敏感 |
| `handleCover` 过滤行 | 加入 `isDirCover(name)` —— 在选封面**之前**摘掉，杜绝"吃片子" |
| `readFolder` 跳过行 | `file === 'avatar.jpg'` → `isDirCover(file)`，点进去不再看到 `cover.jpg` 条目 |
| `readFolder` 目录分支 | 抽出新函数 `makeDirCover(filepath, serial)` |

`makeDirCover` 采用**逐个名字盲试**，不先 `stat`/`readdir` 确认存在：

```ts
async function makeDirCover(dirPath: string, serial: string) {
    for (const name of DIR_COVER_FILES) {
        const data = await makeThumb(`${dirPath}/${name}`, 'jpg');
        if (data) return { key: newThumbKey(serial), data };
    }
    return null;
}
```

为什么盲试反而更省：`makeThumb` 对图片这一支就是一次 `nativeImage.createFromPath`，
文件不存在时它就是一次失败的 open —— 和"先探测存在性、再解图"**同样的 IO 次数**，
少一次多余的调用。命中一个立刻返回，所以常态是 1 次（命中）或 2 次（都没有），
不会把候选表整个试一遍。

为什么只认这两个**固定名字**、不取"目录里第一张图"：目录里第一张图通常是**影片封面**
（`ABC-123/ABC-123.jpg`），拿它当目录图标等于把一个影片目录画成了自己。
`avatar.*` / `cover.*` 是唯一明确表达"我是这个目录的脸"的写法，名字固定还有个好处：探测不需要列目录。

### 实测（electron headless 探针，真跑 `nativeImage` 解码）

```
示例演员C     -> 命中 cover.jpg  原图 100x100  缩略图  3.2KB
示例演员H -> 命中 cover.jpg  原图 250x250  缩略图 12.5KB
示例演员I -> 命中 cover.jpg  原图 100x100  缩略图  3.5KB
示例演员J -> 命中 cover.jpg  原图 300x300  缩略图 12.6KB
示例演员F      -> 无目录封面（文件夹图标）
示例演员A     -> 无目录封面（文件夹图标）
示例演员E     -> 无目录封面（文件夹图标）
示例演员D   -> 无目录封面（文件夹图标）
```

4 个命中、其余正确降级为文件夹图标。缩略图 3.2~12.6 KB，存进 DB 完全无压力。

> 附带发现：我的 bash 环境注入了 `ELECTRON_RUN_AS_NODE=1`，会让 electron 退化成纯 node、
> `require('electron')` 返回一个路径字符串，`app` 直接 undefined。
> 跑 electron 探针要 `env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe x.cjs`。

### 判据讨论：`ABC-01-A` / `ABC-01-B` 怎么办

先纠正一个措辞：我此前说判据是「**里面是一部片子还是多部片子**」，那是**我脑子里的说法**，
代码里的**实际判据是「有没有图片」**：

| 目录内容 | 结果 |
|---|---|
| 有子目录 | 保持目录 |
| 无子目录 + 有图 | 收敛成一张封面（图片作封面，其余文件进 `files` 清单） |
| 无子目录 + 无图 | 保持目录 |

那么 `ABC-01/` 里 `ABC-01.jpg` + `ABC-01-A.mp4` + `ABC-01-B.mp4`（无子目录）：
**收敛成一张封面，A/B 两段进 `files` 清单** —— 这正是想要的（一部片子分两个文件）。

**真正会被吃错的是另一类**：无子目录 + **多部**片子 + **只有一张**图，
例如 `AAA-01.jpg` + `AAA-01.mp4` + `BBB-02.mp4` —— 会被收敛成一张封面，`BBB-02.mp4` 藏进清单里。

当前 F 盘数据里**没有这类样本**（无子目录的目录只有两种形态：`1 视频 + 1 图` ×9，
或 `多视频 + 0 图` ×2）。**所以本轮不动它** —— 没有样本就加规则是脑补约束。

而且要注意：这类问题**用数量判定修不好**。「视频数 ≤ 1 才收敛」会让 `ABC-01-A/B` 变成目录，
正好和直觉相反。要做对只能看**番号归一化**（`ABC-01-A`/`ABC-01-B` 去掉 `-A`/`-B` 后同名 = 同一部），
那是另一个层级的复杂度，没样本不值得引入。


## 九、封面解不开的格式（2026-09-24 傍晚）—— 一条真实故障

**现象**：`D:/sample/videos/TST-PPV-1000001` 在网格里是一张**空白卡片**。

**定位过程（每一步都是实测，不是推理）**：

| 步骤 | 证据 |
|---|---|
| 1. 它是目录 | `ls` 确认 `TST-PPV-1000001.jpg`(8042B) + `TST-PPV-1000001.mp4`(3,858,147,030B) |
| 2. 收敛判定是对的 | 缓存记录里它 `type=image`、`files=1` 个、`size` = 片子总和 ✓ |
| 3. **缩略图是空的** | 同条记录里另外 40 个条目都有 `thumbData`，**只有它没有** —— 不是普遍问题 |
| 4. 文件头不是 JPEG | `od` 出 `52 49 46 46 ... 57 45 42 50` = `RIFF....WEBP` —— **是一个改了 `.jpg` 后缀的 WebP**（750×421） |
| 5. 确认解码器不支持 | electron 探针：`nativeImage.createFromPath` → `isEmpty=true, 0×0`；同字节改名 `.webp` 仍 `true`；**对照组**真 JPEG → `800×539` ✓（说明扩展名无关，是内容格式） |
| 6. 确认规模 | 扫 D:/sample/videos（45 目录/31 图）+ E:/sample/videos（34 目录/13 图）→ **44 张封面里只有这 1 个 WebP**，个例不是系统性问题 |
| 7. 确认兜底可行 | 内置 ffmpeg 能解：输出 480×269 真 JPEG |

**根因不是"WebP 不支持"，是"承诺 > 能力"**：`server/index.ts` 选封面的正则是
`/\.(jpe?g|png|bmp|gif|svg|psd|webp)$/i` —— **放行 webp/psd/svg**，而 `nativeImage`
这三样一个都解不了。于是这些封面被正常收敛成条目、却拿到空缩略图；渲染层按 `type`
分支（`:49`），`type==='image'` 就画 `<n-image src="">` → **空白卡片，零报错**。

**改法（修在咽喉点，不是补丁）**：

| 文件 | 改动 | 为什么 |
|---|---|---|
| `electron/utils/thumbnail.ts` | 新增 `runFfmpeg(cmd, what, src)` —— 把「超时 + SIGKILL 强杀 + settled 防重复 resolve」抽成**唯一**一处 | 原来这段只写在 `extractFrame` 里；加图片兜底等于要抄第二份，抄漏一处就少一层保护 |
| 同上 | `imageThumb` 改成 `async`：nativeImage 解不开 → **先确认文件存在** → ffmpeg 转 PNG（`scale='min(960,iw)':-2`）→ 交回**同一条** `scaleToThumb` | 只扩宽"能读进来的输入格式"，缩放规则（只缩不放）和输出质量**仍只有一处定义** |
| 同上 | `videoThumb` 里 `return imageThumb(frame)` → `return await imageThumb(frame)` | `imageThumb` 变异步后，不 await 会让 `finally` **先**删掉临时帧，解码读到不存在的文件 |
| 同上 | `FRAME_TIMEOUT_MS` → `FFMPEG_TIMEOUT_MS`（抽帧和转码共用） | 同一类保护，同一个值 |
| `electron/server/index.ts` | `makeDirCover` 从"盲试解码"改成**先 `access` 再解码** | 兜底必须先分得清"文件不存在"和"解不开"。`makeDirCover` 逐个名字盲试，库里绝大多数目录只有 `cover.jpg` → 不挡掉会给**每个目录**白起 1~2 个 ffmpeg 子进程。而 `access` 是 1 次 stat，**和原来那次失败的 open 次数相同** → 常态成本不变 |
| 同上 | `makeThumb` 里 `imageThumb` 加 `await` | 同上 |

**实测（真实服务端 E2E，数据库指向临时目录、不碰真实缓存）**：

```
FC2 条目的 thumb:  修前 (无)          →  修后 B6C5-muf4hgi8-54yqrn
/thumb 取图:        —                →  HTTP 200 / 12155 B / image/jpeg / 头 ffd8ffe0
无缩略图条目:       15（14 文件夹 + FC2） →  14（全是文件夹，零回归）
中转临时文件残留:                        0
```

**你还需要做一件事**：缓存里那条旧记录还是空的，`findCache` 命中就不会重扫。
对那个目录**按一次 ↻**（或 `noCache`）即可 —— 之后它就一直在了。

---

## 十、本地服务的访问口令（2026-09-24 傍晚）

**问题**：这是个裸 HTTP 服务，**任何网页**都能朝 `127.0.0.1:3060` 发请求。
浏览器会拦掉"跨域**读**响应"，但**请求本身照样打进来并被执行**：

| 后果 | 谁做得到 |
|---|---|
| 递归遍历整块盘（`/getFileTree` 零校验）→ 界面卡住、硬盘狂响 | **任意网页**一个 `<img>` 或 `fetch` 就够 |
| **真正读走**任意目录内容 | 本地 `file://` / `data:` 页面 —— 它们的 `Origin` 是 `null`，而 `null` **在白名单里** |
| 探测"某文件存不存在" | `evil.com` |

**为什么不用"收紧 Origin 名单"**：打包后**应用自己就跑在 `file://`**，
它的 `Origin` 就是字面量 `'null'` —— 和任意恶意 `file://` 页面**无法区分**。
拿一个自己都伪造得出的东西当凭证，等于没校验。

**改法**：

| 文件 | 改动 |
|---|---|
| `electron/server/token.ts`（新增） | `crypto.randomBytes(24).toString('hex')` —— 启动时随机生成，只活在主进程内存、**不落盘** |
| `electron/server/index.ts` | 在 `http.createServer` 回调里校验 `?t=` —— 那是**所有请求的唯一入口**，顺序放在 OPTIONS 之后 |
| `electron/main/index.ts` | `ipcMain.on('ff-token', e => e.returnValue = LOCAL_TOKEN)` |
| `src/utils/request.ts` | `ipcRenderer.sendSync('ff-token')` 取口令；新增 `apiUrl()`，**所有对本地服务的 URL 都由它产生** |

**两个关键设计约束**：

1. **口令必须走 URL（`?t=`）而不是请求头** —— 缩略图和预览图是靠 `<img src>` 取的，
   而**浏览器不给 `<img>` 加自定义请求头**。放 URL 里才能让 fetch 和 `<img>` 共用同一个机制。
   代价是口令出现在 URL 上：本地服务、无任何对外跳转，暴露面是零。
2. **`apiUrl()` 是唯一出口** —— 新调用方想漏都漏不了。

**实测**：

```
无口令 → 403   错口令 → 403   空串 → 403   对口令 → 200
无口令 /getFileTree (最危险那条) → 403  (2ms 内拒绝，不再递归整盘)
/thumb 对口令 → 200 / 12155B / ffd8ff      /thumb 无口令 → 403
IPC 通道: ipcMain.on('ff-token') ↔ sendSync('ff-token') 频道名一致 ✓，渲染层确实拿到口令 ✓
```

---

## 十一、空状态提示（2026-09-24 傍晚）

**问题**：三种情况在界面上**长得一模一样**（一片空白）：目录真的空 / 搜索没匹配到 / 请求失败。

**改法**：`FileFinder/index.vue` 加一个 `emptyTip` computed + 一行浅灰小字。
不加边框、不加图标、不加按钮。**优先级顺序就是代码里的顺序**：

1. `loading` / `loadFailed` → 不显示（失败已经有错误通知了，空白处再写"这个目录是空的"是**在骗人**）
2. 搜索有词但零结果 → 「没找到匹配的内容」 ← 最容易让人以为程序坏掉的情况，排最前
3. 还没选目录 → 不显示（提示是噪音）
4. 其余 → 「这个目录是空的」

顺带新增 `loadFailed` ref（失败时置真、每次取数开头清掉）—— 它**只服务一件事**：
别让空状态替失败背锅。

## 十二、从缓存记录打开没有面包屑 / 返回（2026-09-24 傍晚）

**现象（用户报的，附他自己找到的线索）**：
「如果是从选择文件夹进入的可以正常触发，但是我从缓存记录打开的，比如打开 videos 再打开 videos/xxx
就不会有类似文件夹的多层级的那种面包屑和返回了」

### 先证明：这不是本轮改动引入的

`git show HEAD:src/views/FileFinder/index.vue`（用户自己的提交 `65516c5 添加备份功能`）里就已经是：

```
:148  const openFolderInCover = (path: string, name?: string) => {
:153      openStack.value.push({ path, mode: 'cover', name });     ← 不设 dir
:287  const openHistory = (path: string, mode: OpenMode) => {
:288      if (mode === 'folder') { handleDirChange(path); }        ← 这条路会设 dir
:290      else { openFolderInCover(path); }                        ← 这条路不设 dir、也不传 name
:13   <n-button v-if="dir" ...>返回</n-button>
```

**原有缺陷**，与本轮（图片兜底 / 口令 / 空状态）无关。

### 根因是**两处独立的不一致**叠在一起

**① 返回按钮显示条件用错了变量**

```html
<n-button v-if="dir" @click="onBack">返回</n-button>
```

`dir` 的含义是「文件夹选择框里选了什么」—— 一个**和导航栈无关**的变量。
而 `onBack` 自己判断的是 `openStack.length === 1`。
两条入口对 `dir` 的处理不一样：

| 入口 | 是否设 `dir` | 返回按钮 |
|---|---|---|
| 选择文件夹 → `handleDirChange` | ✅ `dir.value = value` | 显示 |
| 缓存记录 · `mode==='folder'` → `handleDirChange` | ✅ | 显示 |
| 缓存记录 · `mode==='cover'` → `openFolderInCover` | ❌ **从不设** | **不显示** |

**② 层级名是「可选参数」，靠调用方记得传**

```html
<n-tag v-if="!!folder.name" ...>
```

`IOpenInfo.name` 原来是 `name?: string`。三条件入口里只有「从网格下钻」传了它：

| 入口 | 传 name？ |
|---|---|
| 从网格下钻 → `openFolderInCover(path, item.name)` | ✅ |
| 选择文件夹 → `openStack.push({ path, mode:'cover' })` | ❌ |
| 缓存记录 · cover → `openFolderInCover(path)` | ❌ |

于是 `v-if="!!folder.name"` 把这两条入口的层级**整个吃掉** → 看起来就是"没有面包屑"。

**更根本的一层**：`openHistory` 在按 `mode` 分叉。而 `mode` 说的是
「这条缓存记录当初是怎么被扫出来的」——它是**缓存记录的属性**，不该决定**导航长什么样**。
（`handleDirChange` 本来就已经把首层统一成 `cover`，见那边的注释。）分叉本身就是错的。

### 改法（全部收口，不打补丁）

| 改动 | 为什么 |
|---|---|
| `openHistory(path)` → 直接 `handleDirChange(path)`，**不再看 mode** | 打开一个目录 = 以它为根开始一次浏览。两条入口合成一条 |
| 新增 `levelName(path)`：层级名 = 路径末段 | 名字本来就能从路径算出来 → 从「可选参数」变成「算得出来的值」，没人能再漏传 |
| 新增 `pushLevel(path, mode)`：**唯一**的建栈出口 | 原来建栈有两处、名字传法不一致。收成一处的另一个好处：`name` 必填 |
| `IOpenInfo.name` 从 `?` 改成必填 | 让「某一层没名字」在**类型上**就不可能 |
| `openFolderInCover(path)` 去掉 `name` 参数 | 参数没了，调用方想漏也漏不了（两个调用点同步） |
| `handleDirChange` 的 `openStack.push(...)` → `pushLevel(...)` | 同上 |

**故意没动的一处**：返回按钮那句 `v-if="dir"` 原样保留。

它的语义确实不对（更该是 `openStack.length > 1`），但那是**既有行为**：只要选过文件夹，
首层就显示「返回」，而首层点击因为 `onBack` 开头的 `length === 1` 守卫而没有效果。
这属于"原来就长这样"，不属于本次缺陷 —— 本次要修的是**两条入口对 `dir` 处理不一致**，
而不是 `dir` 该不该当判据。按"特性不动、有问题先讨论"处理，不顺手改。

**实测**：

```
levelName 用真实路径跑 25 例（含中文、尾斜杠、盘根 E:/、重复分隔符）→ 判错 0
vue-tsc --noEmit exit 0        tsc -p tsconfig.electron.json exit 0
openStack.value.push 全库只剩 1 处（在 pushLevel 里）→ 建栈确实收口了
openFolderInCover 的两参调用 0 处
```

### ⚠️ 两件你需要知道的事

1. **有一条观感会变**：「选择文件夹」那条路，**第一级现在也会在面包屑上显示**（以前不显示）。
   这是同一个 `name` 缺陷的另一半 —— 修了它才能出现你说的"多层级面包屑"
   （`videos › xxx`）。如果你更习惯以前那样（首级不显示），说一声，只回退这一半。
2. **你的 dev server 已经没在跑了**（`3344` / `5173` 都没有 vite；`[::1]:5173` 上那个是代理，
   返回 `502 upstream connect failed`）。所以这次的修复**还没进你的界面**，
   需要重新 `npm run dev`。
