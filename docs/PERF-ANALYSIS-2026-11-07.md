# 性能分析与优化规划（2026-11-07）

> 只读分析，**代码一行未动**。除文件体积与历史条目数分布外，所有「收益」都是估算，未实测。
> 验证手段沿用项目三件套：`typecheck` 0 error + `docs/probes/` 只读探针 + 真机目视。

---

## 一、先说结论（三条，按重要性）

1. **渲染层的大项已经被实测否决过**，见 `docs/ARCH-PLAN.md:226-237`：
   虚拟滚动 / `readFolder` 并发 / 搜索 debounce / 渲染分页 —— 实测单层条目**最大 104、均值 5.0、>200 的 0 条**。
   这次不重复提，也不建议推翻（推翻需要新的数据，不是新的直觉）。
2. **真正的开销在启动路径**：主进程在窗口显示前要解析整条 `server` 依赖图（24 个 import，含 `assistant/` 19 文件约 5900 行），并在模块求值期就发起 nedb 整库解密。渲染层则把 4 个路由页全部静态打进入口 chunk。
3. **包体积没有优化空间**：`@ffmpeg-installer/win32-x64` 62M + `@ffprobe-installer/win32-x64` 78M，**都是单平台包**，无多平台冗余可裁；148M 的 exe 属 Electron + ffmpeg 的正常区间。

---

## 二、启动路径（收益最明确，风险最低的三件）

| 位置 | 现状 | 机制（为什么能省） | 收益 | 风险 | 证据等级 |
|---|---|---|---|---|---|
| `src/router/index.ts:14-17` | 4 个页面**全部静态导入**，打进入口 chunk | `mount` 前要解析/编译 `Cache`(1476 行) + `Settings`(405) + `Playlists`(336) 三页，用户不点也得付 | 入口 chunk 少约 200KB 源码级（gzip 未实测） | 低：切页首次多一次模块加载，可加 prefetch 抵消 | 静态 |
| `src/main.ts:6` | `file-icon-classic.min.css`(26K/363 条规则) 与 `file-icon-vectors.min.css`(74K/1089 条) **同时引入** | 前者被后者完全包含；代码只用 `fiv-cla`（`index.vue:202`）。重复解析 + 重复 `url()` | 少 26K CSS / 363 条规则匹配 | 极低。**需先验证「完全包含」再删** | 静态（体积已复算）／包含关系待复验 |
| `electron/server/assistant/index.ts:71-854`（19 文件） | 由 `server/index.ts:31` 静态 import ⇒ 主进程模块求值期全量解析 | 用户不开「换封面」也付这份解析成本 | 未实测，按体积估 20–80ms | 中：`avatarApply.ts:17` 反向 `import '../index'` 构成环；`jobs.ts` 的 `JOBS`、`rules.ts` 的 `FILE_STORE` 是进程内存态 ⇒ 延迟加载**必须保证单例且首个请求前完成注册** | 静态 |

补充两条**同源但不宜单独动**的：

- `electron/server/nedb.ts:188-198`：`initBinStore()` 与 `nedb.loadDatabase()` 都在**模块求值期**发起。整库逐行同步 AES 解密会形成一段不可打断的主线程突发，正好和 `createWindow` 抢线程。可延后到 `app.whenReady()` 之后（首个请求前），但必须先确认「闸门」能把早到的请求正确挡住。
- `src/utils/request.ts:18`：模块求值期 `ipcRenderer.sendSync('ff-token')`。这是既定契约（`nodeIntegration` + 同步取口令），**不改**；它只是把主线程的忙碌放大成渲染层的等待，所以修上面两条等于顺带修它。

---

## 三、内存（三个真实的无界点，触发条件都特定）

| 位置 | 现状 | 规模函数 | 可优化点 | 风险 | 证据等级 |
|---|---|---|---|---|---|
| `electron/server/assistant/index.ts:658` + `avatarApply.ts:153` | `previewCache` 只有 **500 条**上限（按条数 FIFO），`avatarApply` 直接 `set` **绕过上限**；存的是原图 Buffer | 批量换头像时 = 张数 × 单张原图 | 加**总字节预算**（如 64MB），超了按 LRU 淘汰。只动这个下载中转 Map，**不碰**「缓存层永不自动删」 | 低 | 静态 |
| `electron/server/nedb.ts:535` `loadMeta` | 每次调用 `find({})` ⇒ nedb 逐条 `deepCopy` 整库（含 `data[]`） | O(全库)，**每次** `/getDisks`、`/getHistory`、**每次 `openFolder` 补目录大小** | 加 projection 只取 meta 字段，或在库内维护 bytes 索引 | 中：改的是核心查询路径，要回归导航与历史 | 静态 + 推理 |
| `electron/server/assistant/siteFetch.ts:182-195` | **每个抓取目标新建一个隐藏 BrowserWindow**，并发 5 | 峰值 +5 个 renderer 进程 | 窗口池复用 | 中高：抓取是核心功能，改窗口生命周期容易引入不稳定 | 静态 |

次要（收益小，列出备查）：

- `src/views/Shell/index.vue:8`：`<KeepAlive>` 无 `max`，4 页全常驻。加 `max:2` 能少一份整屏数据驻留，但**可能影响「返回恢复滚动位置」**——那是你声明的特性，动之前要确认。
- `src/views/FileFinder/index.vue:546`：`dataSource = ref([])` 深度响应。104 项下 Proxy 开销可忽略（约 0.1MB 级）；**不建议为此改 `shallowRef`**——数据是整体替换，但改动会波及全部读取点，收益不成比例。

**明确不是问题**（避免下次重复怀疑）：缩略图**不是** base64 常驻，走 `/thumb`，主进程只持文件名 `Set`；预览大图不进页面缓存（只有 `sharpKey` 一个值）。

---

## 四、渲染（可做的很少，且都在「量不出来」边缘）

| 位置 | 机制 | 判断 |
|---|---|---|
| `index.vue:192,196` | 网格用 `n-image`，**每个实例都会连带创建一个 `ImagePreview`**（+2 个 watchEffect），即使 `preview-disabled` 后 preview 渲染为 null | 104 项 = 104 个多余实例。**收益真实但很小**；换原生 `<img>` 要自己实现 lazy + 失败回退，风险大于收益 |
| `index.vue:157-165` | 卡片不是子组件，`cursorKey/opening/picked/plMember` 都在同一渲染作用域 ⇒ 每次方向键/点选整组件重渲 | 104 项下约 624 个 vnode 的 patch。同样是「量不出来」 |
| `useGridCursor.ts:269-286` | `scrollIntoView`（写）后同任务内 `probeLayout`（读）⇒ 强制同步布局 | 每次方向键一次；单次开销小 |

结论：**渲染层不动**。理由与 `ARCH-PLAN.md:230-232` 一致——104 条的数据形态下，这一层的优化都在噪声范围内。

---

## 五、包体积（结论：不动）

| 项 | 体积 | 判断 |
|---|---|---|
| `@ffmpeg-installer/win32-x64` | 62M | 功能必需（webp 转码 / 视频抽帧），单平台包，无可裁 |
| `@ffprobe-installer/win32-x64` | 78M | 功能必需（视频时长 / 抽帧），单平台包，无可裁 |
| Electron 运行时 | — | 固定成本 |

唯一能显著降体积的路是「去掉视频抽帧」或「换更小的 ffmpeg 构建」，两者都在砍功能，**不划算**。

---

## 六、需要你定的一件事：`flexible.ts`

- 事实：`rem` 在 `src/**/*.{css,vue}` 里**零消费**；`--item-height` 只剩 `useGridCursor.ts:201` 与 `index.vue:2876` 两句**过期注释**，没有实际定义（实际格高由 `aspect-ratio` + 标题预留决定）。
- 所以 `flexible.ts` 现在的作用只有：resize 时写一次 `documentElement.style.fontSize`，没人读。
- 你此前的裁决是「`flexible.ts` **绝不能删**」。我**不擅自动它**。
- 我的建议：**保留**。它只多一次 resize 写入，成本接近于零；而删掉后万一以后想做 rem 缩放，得重新摸一遍 `--item-height` 的整条链。

---

## 七、建议执行顺序

```
P0 先量（3~5 行埋点，只打 console）→ P1 三件低风险 → P2 三件中风险 → 渲染/包体积：不做
```

**P0：拿到基线（没有这一步，后面的收益都无法证明）**
- 主进程：`whenReady` 入口、`new BrowserWindow` 后、`ready-to-show`、`app.listen` 回调各记一次 `process.uptime()*1000`。
- 渲染层：`main.ts` 顶部记 `performance.now()`；`FileFinder` `onMounted` 记一次；用 `performance.getEntriesByType('paint')` 取 FCP。
- 只看四个差：**require 期 → 窗口可交互 → 服务可用 → FCP**。
- 全部只 `console.log`，不落盘、不改任何契约；量完即可删除。

**P1：三件低风险（可一次做完，每件独立可回滚）**
1. `router/index.ts` 三页改 `() => import()`（首页保持静态）
2. 复验后删 `main.ts:6` 的 classic CSS
3. `previewCache` 加总字节预算

**P2：三件中风险（一件一件做，每件单独真机验收）**
4. `assistant` 路由延迟加载
5. `loadDatabase` 延后到窗口创建之后
6. `loadMeta` 加 projection

**不做**：虚拟滚动、`readFolder` 并发、搜索 debounce、渲染分页（已有实测裁决）、包体积裁剪。

---

## 九、重要更正（2026-11-07 18:00，用户提供）

**`ARCH-PLAN.md:230` 的「单层最大 104 条」判据只对非 flat 模式成立。**

用户说明：**flat 模式一页可能渲染 2000–10000 项**。

据此修正：
- 「虚拟滚动不做」「渲染层分页不做」两条的**前提已变**，不能直接沿用。
- 但**暂不改结论**——等 P0 埋点真实数据出来，再按 flat 模式重新评估（候选：`content-visibility:auto`、窗口化、分屏加载）。
- 「`readFolder` 并发不做」**仍成立**（与"少碰移动硬盘"第一目标冲突）。
- 「搜索防抖不做」**需重算**：flat 模式下是 10000 项 × 每键 O(N) + 拼音，量级完全不同。

## 十、本日执行记录（P0 + P1）

| 项 | 状态 | 说明 |
|---|---|---|
| P0 埋点 | 已加，**等你重启 dev 跑一次** | `[PERF]` 6 个时刻：`require-done` / `whenReady` / `window-created` / `ready-to-show`（主进程）、`server-listen`（服务可用）、`renderer-mount`+`fcp`、`filefinder-mounted`（渲染层）。量完整段删除 |
| 路由懒加载 3 页 | 已落地 | `router/index.ts`：三页改 `() => import()`，首屏页保持静态 |
| 删重复 CSS 引入 | 已落地 | `main.ts` 去掉 `file-icon-classic.min.css`（25,615 B / 369 条，逐条比对确认为 vectors 的子集） |
| 全局样式归并 | 已落地 | `App.vue` 的 `#app` 块并入 `tokens.css`，删掉整个 style 块 |
| CSS 结构去重 | 已落地 | `.scan-progress/.scan-hint` 合一；Cache 三处纵向 flex 骨架合一（注释同步合并）；两处 `.disk-dot` 底座合一 |
| 硬编码色收口 | 已落地 | `#a1a1a1` × 6 → `--ff-text-muted`（值不变，纯去重） |
| `previewCache` 字节上限 | 已落地 | 新增 `assistant/previewCache.ts`：`CappedPreviewCache extends Map`，64MB / 500 条。**继承 Map 使调用方签名零改动**，`avatarApply` 绕过条数闸的路径也被覆盖 |
| `flexible.ts` | 已删 | `rem` / `hairlines` 全仓零消费；**但 `body.style.fontSize = 12×dpr` 有隐式视觉依赖**，已搬进 `main.ts` 两行，视觉不变 |
| 过期注释 | 已修 | `useGridCursor.ts:201` 的 `--item-height` 改为实际机制（`--ff-cover-ratio` + 标题固定两行）。`index.vue:2874` 那处是**历史教训**，保留 |
| 验证 | `typecheck` 0 error | 运行时未实测 |

**未做（等 P0/P1 结果后再议）**：P2 三件（助手延迟加载 / 库解密延后 / 元数据 projection）；flat 模式下的渲染方案。

## 十一、实测结果（2026-11-07 19:25，dev 模式，稳态一次）

| 时刻 | 值 | 含义 |
|---|---|---|
| modules-evaluated | 1206ms | 全部模块加载+求值（**dev 按需编译，打包版小一个量级**） |
| renderer-mount | +27ms | Vue 挂载 |
| filefinder-mounted | +33ms | 文件页 setup+mount |
| window-shown | ≈1277ms | 窗口真正出现 |
| **list#1** | **4056ms** | 首屏数据落地（104 项） |

**从窗口出现到看到图 ≈ 2.8 秒**，与用户体感「不到 10 秒」吻合。

⚠️ 之前两次测到的 8.0s / 30.2s 是**异常值**（主进程侧一次性任务 + Vite 冷编译），不能当基线。

### 已确认并修掉的唯一生产性开销

`binStats()` 原来**对 bin 目录每个文件串行 `await stat`**（约 3000 个文件 ⇒ 约 270ms），而它挂在 `/getDisks` 上 ⇒ 每次首屏白等一次，且启动了两次 ⇒ 约 540ms。

修法：`initBinStore` 的 readdir 之后**后台**把总字节算一遍（不阻塞 listen），`putBin` 写入时增量维护；`binStats` 直接读内存。
**实测 `rest` 从 273ms → 2ms / 1ms。**

### 未定案、且**不建议继续治**的部分

dev 下 `filefinder-mounted`(1252) → 首个 `/getDisks`(4023) 之间有 **2.7 秒空窗**，期间只有 `/playlists`（22ms）一个请求。
判断：这是 **Vite dev 按需编译模块**的开销，打包版不会重复付。
⇒ 想在 dev 上抠这 2.7 秒是优化一个用户感知不到的成本。

## 十二、埋点已清理（2026-11-07 19:28）

探针全部移除（`Grep PERF` 零命中），`electron/perfMarks.ts` 已删，`/getDisks` 的 `__perf` 字段已撤。
`typecheck` 0 error。

**保留的改动**（都是真优化，不是探针）：`binStats` 后台化、路由懒加载 3 页、CSS 去重、`previewCache` 字节上限、`flexible.ts` 删除。

## 十三、CSS 去重的边界（本次定下的判据）

不同组件 `<style scoped>` 里的**同名 class 是合法隔离，不算冗余**（如 `Playlists` 与 `Settings` 都有 `.page-head`）。
只有「全局样式之间」或「同一文件内」的重复才合并——否则是在破坏组件封装，不是在去重。
