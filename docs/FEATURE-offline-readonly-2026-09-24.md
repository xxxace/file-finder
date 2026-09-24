# 离线盘「只读浏览缓存」—— 设计与实测（2026-09-24 晚）

> 用户原话：**「至少让我只读也可以啊」**。
> 即：盘拔了，缓存记录里那些目录**要能点进去看**（只读），不要求打开原文件。
> 开工依据：`MEMORY.md §五` 末条把这件事记为"属新特性，等用户点头" —— 这就是点头。

## 一、为什么以前点不开（不是 bug，是设计）
1. `getHistory` 对离线盘给 `path: null` + `online: false`（注释写明"故意不给点不开的路径"）；
2. 渲染层 `HistoryTable.openDir` 见 `!item.online || !target` → 提示"盘未插入"、**根本不发请求**。
两道闸 `HEAD` 里就有。**根因**：离线时没有任何办法把"路径"变成"这块盘"——
`findDriveByLetter('H')` 给 `null`，而 `H:` 现在可能是**另一块盘**。

## 二、方案：只读锚点 `#<序列号>/<盘内相对路径>`
```
H:/videoz          →  在线：实时路径（原样，未改动）
H:/videoz（盘不在） →  #4A1F9E2B/videoz   只读锚点 = 缓存主键 (serial, relPath, mode)
```
- **为什么不记住"上次的盘符"**：盘符不是身份，只是当前挂载点（`driveIdentity.ts` 开头那段就是讲这个）。
  给离线盘编一个 `H:/…` 是在**编造身份**，另一块盘插到 H: 时那个地址就指向别人了。
  锚点用的 `serial` 正是缓存主键，**唯一准确的地址**。
- **为什么不给接口加一组参数**：渲染层的导航栈、面包屑、双击下钻、返回全都只认一个字符串
  （`item.dir + '/' + name`）。让锚点长得像路径 → **导航那一整块一行都不用改**，
  也不会出现"路径寻址 / 序列号寻址"两套并行导航。`#` 在 Windows 路径里永远不合法，撞不上真路径。
- **只读是结构性的，不是 UI 拦出来的**：锚点这一支只走 `findCache` —— 不 `readdir`、不
  `scanAndCache`、不写库、忽略 `noCache`；`/raw` 天生拒绝锚点（`splitPath` 拆不开 `#`）
  → **锚点没有任何读到磁盘文件的通道**。

## 三、逐处改动

| 文件 | 改动 |
|---|---|
| `electron/server/index.ts` | 新增 `ANCHOR_PREFIX` / `parseAnchor` / `toAnchorPath` / `toAnchor`；`openFolderController` 最前面加 ⓪ 锚点分支（缓存未命中 → 抛 `kind:'notCached'`，由 `route()` 变 500）；`getHistory` 离线盘的 `path` 由 `null` 改为锚点 |
| `electron/server/nedb.ts` | `BrowseHistory.records[].path`：`string \| null` → `string`（两种盘都有地址），补注释说明两种形态 |
| `src/components/HistoryTable/index.vue` | 离线行的目录按钮**不再禁用**；`openDir` 去掉 `!item.online` 拦截（只留"没有地址"这一道）；盘符标签改为 `online ? path.slice(0,2) : '??'`（否则锚点会被切出 `#F`）；离线行文字改「（盘未插入 · 只读）」 |
| `src/views/FileFinder/index.vue` | ① `isReadOnlyPath()` + `readOnlyLevel`（判据=路径前缀 `#`，不另加状态字段）② `BANNER_KINDS` 常量（`offline/unreadable/notCached` 收成一处）③ 横幅新增只读说明（info）与 `notCached`（warning），**失败优先于只读说明** ④ 只读层禁用「补全这一片 / 重读这一片 / 刷新」 + `onRefresh` 守卫（F5 也拦）⑤ `previewUrl` 只读层降级成缩略图 ⑥ `openFile` 见锚点直接提示，不把假路径交给系统 |

## 四、实测（`docs/anchor-probe-2026-09-24.log`，可复跑）
`node run-anchor.cjs out/after-p1.cjs <真实目录>` —— **18 条判据全 PASS**：

| 组 | 判据 |
|---|---|
| A 面板入口 | 离线记录的 `path` = `#DEADBEEF/videoz`（不再是 null）；`online` 仍为 false |
| B 按锚点打开 | 200 / 条目数 2 / 每条 `dir` = 锚点（下钻靠它）/ 未下发 `thumbData` / 缩略图 200 image/jpeg |
| E 下钻 | 二级缓存层同样能打开（不是只能看一层） |
| C 未缓存层 | 500 + `kind:'notCached'` —— **不是** `unreadable`，证明它根本没碰盘 |
| D 只读成立 | 带 `noCache` 也走缓存且不报错；**库文件大小 + 时间戳全程未变**（零写入） |
| F 回归 | 真实路径仍是完整路径、`dir` 带盘符（原有行为没坏） |
| G 安全 | `/raw` 拒绝锚点（400） |

- 造"离线盘"的办法：**服务启动前**往探针数据目录写一份 `serial=DEADBEEF` 的库
  （nedb 启动整库进内存，启动后插是看不见的 —— 这条是已有实测结论）。
  加密钩子与 `nedb.ts` 逐字相同 → 写出来就是合法库，不碰真实 `~/.file-finder`。
- 其它校验：`vue-tsc --noEmit` + `tsc -p tsconfig.electron.json` 双 exit 0；
  `vite build` 通过；两条构建契约自检通过（main 命中 `require("fluent-ffmpeg")`、渲染层 `from"electron"` = 0）。

## 五、⚠️ 未实测 / 已知取舍（**要用户目视**）
1. **界面部分无头验不了**（本仓库反复确认过）：只读横幅的观感、三个按钮的禁用态、
   缓存记录里"（盘未插入 · 只读）"那行、缩略图降级——都只做了类型与编译级验证。
2. **只读层永远只读**：盘插回来之后，那一层仍走锚点（读缓存），要实时视图得从
   「缓存记录」重新打开那一行。这是刻意的（服务端不替前端猜"盘回来了没有"），
   代价就是"插回盘后当前这屏不会自动复活"。
3. **文件夹选择框里会显示 `#4A1F9E2B/videoz`**：那是它真实的身份，但对人不友好。
   没做美化，因为任何"显示名"都要再引入一个字段，而导航栈里只流动路径一个字符串。
4. 只读层里双击原文件/看大图都会降级或提示（**打不开**是预期的，不是 bug）。

## 六、复算方法（探针在 `%TEMP%`，不进仓库）
```bash
cd C:/Users/<user>/AppData/Local/Temp/ff-p0b-probe
node sync-after.cjs                                    # 从主仓库刷新副本 + 三处特化
NODE_PATH=D:/code/file-finder/node_modules node build-after.cjs
NODE_PATH=D:/code/file-finder/node_modules node run-anchor.cjs \
  "C:/Users/<user>/AppData/Local/Temp/ff-p0b-probe/out/after-p1.cjs" "D:/code/file-finder/docs/probes"
```
⚠️ 两个坑（都实测踩过）：
- `require('esbuild')` / `@seald-io/nedb` 在 `%TEMP%` 下**解析不到** → 必须给 `NODE_PATH`。
- **nedb v4：不先 `loadDatabase` 就 `insert`，回调永远不来**，而事件循环里没有别的句柄
  → node **静默 exit 0、一行输出都没有**（现象是"探针什么都没打印却成功退出"）。
