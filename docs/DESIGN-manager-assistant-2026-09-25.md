# 管理助手（JAV 封面 / 演员头像抓取）实施方案

> ⚠️ **本文档的 §二 D1 与 §五 Phase 2 已被 `docs/PRD-manager-assistant-2026-09-25.md` 修正**：
> 经高级开发评审，`cf_clearance` 与 IP+UA+TLS 指纹三绑定，**不可**取出来交给 Node `fetch` 复用——
> 抓取全程必须留在 Chromium 网络栈。**以 PRD 为准。** 其余章节仍可参考。

> **For agentic workers:** 本方案分阶段推进，每阶段产出可独立验证；实现时按 Phase 顺序，每个 Phase 结束跑一次 `npm run typecheck`。
>
> **Goal:** 在 file-finder 内部新增「管理助手」模块：用缓存找出没有封面的视频，从 JAV 资源站抓取封面补全；可选地把演员名字缓存下来、由用户按同名聚合、补演员头像。站点提取逻辑用**可视化可编辑的规则**管理，以应对各站元素位置不同、易变的问题，并处理 Cloudflare 等反爬。
>
> **Architecture:** 主进程新增独立模块（抓取层 + 规则引擎 + 存储），通过现有 HTTP 咽喉点 `route()` 暴露接口；渲染层新增一个全屏面板（照抄 `HistoryTable` 的 `setShowModal` 模式）。抓取浏览器复用 **Electron 自带 Chromium（隐藏 BrowserWindow）**，不引入 puppeteer。封面/头像写入**现有已识别的文件名约定**，展示层零改动。
>
> **Tech Stack:** Electron 44 + Vue 3 + naive-ui + `@seald-io/nedb` + Node ≥22 全局 `fetch` + 隐藏 `BrowserWindow`。无新增运行时依赖（除非后续确需）。

---

## 一、现状梳理结论（事实，附证据）

| 项 | 结论 | 证据（路径:行） |
|---|---|---|
| 主数据通道 | **本地 HTTP 服务** `127.0.0.1:3060`，非 IPC | `electron/server/index.ts:1162` |
| 咽喉点 | 所有路由经 `route(path, handler)` 注册，统一错误兜底 | `electron/server/index.ts:1041-1071` |
| 口令 | 请求必须带 `?t=<LOCAL_TOKEN>`，否则 403 | `server/index.ts:1122`；`server/token.ts:12` |
| IPC 用途 | 仅系统能力（对话框/shell/openPath/token），**非数据通道** | `electron/main/index.ts:103-204` |
| 渲染→主 通信 | `nodeIntegration:true`+`contextIsolation:false`，渲染层直接 `import { ipcRenderer } from 'electron'`；HTTP 走 `utils/request.ts` | `main/index.ts:49-50`；`src/utils/request.ts:16,32` |
| 持久化 | **nedb（文档型，非 SQL）**，加密行（aes-256-cbc 确定性） | `electron/server/nedb.ts:149-153,125-147` |
| 缓存 doc | `{_id,v,serial,relPath,mode,count,data:FileInfo[],create_at}`，主键 `(serial,relPath,mode)` | `nedb.ts:40-53` |
| 加密常量 | `CACHE_VERSION=2` / `CACHE_KEY` / `CACHE_IV` **永不可改** | `nedb.ts:30,107,117` |
| 下发白名单 | 一切下发过 `wire()`→`pickFileInfo` | `server/index.ts:511-517,487-499` |
| **目录的脸** | **`avatar.jpg` / `cover.jpg`（两个固定名）**，`makeDirCover` 逐个试 | `server/index.ts:37,197-209` |
| 影片封面 | 影片目录内**与影片同名**的图（如 `ABC-123/ABC-123.jpg`）被收敛成封面条目 | `server/index.ts:32-34` |
| 缩略图 | ffmpeg/ffprobe 抽帧（时长的 1%），ffmpeg 依赖靠 `__dirname` 定位 | `electron/utils/thumbnail.ts:110-124,205-248` |
| 打包契约 | `notBundle()`：运行期依赖**不许内联**；只有 `dependencies` 会被 electron-builder 打包 | `vite.config.ts:34-44`；`package.json:47-54` |
| 路由系统 | **无 vue-router**，单视图应用 | 全仓 grep 零命中；`src/App.vue:7,19` |
| 网络抓取 | **零先例**（无 axios/puppeteer/playwright；主进程无对外 HTTP） | `package.json`；`node_modules` 顶层 |
| Node 能力 | `engines.node >=22.12.0` → 主进程可直接用全局 `fetch` | `package.json:15` |
| 校验 | 无测试框架；命令 `npm run typecheck`（`vue-tsc --noEmit && tsc -p tsconfig.electron.json`）+ `vite build` | `package.json:11-12` |

**最重要的一条：** 封面/头像只要以 `avatar.jpg`/`cover.jpg`（或影片同名图）落进目标目录，**现有 UI 就会自动把它当作目录的脸渲染**，展示层不用改一行。这是本方案能"轻"的根基。

---

## 二、架构决策（含理由，奥卡姆优先）

| # | 决策 | 理由 |
|---|---|---|
| D1 | 抓取浏览器用 **Electron 隐藏 `BrowserWindow`**，不引 puppeteer | 应用本身就是 Chromium；再装一个 puppeteer（含第二份 Chromium，~300MB）纯属重复实体。隐藏窗口能跑 JS、过 Cloudflare 挑战，且能用 `session.cookies` 取 `cf_clearance` 复用 |
| D2 | 抓取放**主进程**，不进渲染层 | 渲染层有"所有 HTTP 出入必须过 `request.ts`"的约定；放主进程也天然挨着存储层、无 CORS 限制 |
| D3 | 站点规则 = **JSON 数据（非代码）**，字段用**候选链** | 各站元素位置不同、易变；把解析逻辑从硬编码 cheerio 提成可 CRUD 的数据。候选链 = 依次试、命中即用（把旧代码 `data-src→data-poster→preview` 的手写 fallback 泛化） |
| D4 | 规则/演员元数据存 **`~/.file-finder/` 下的 JSON**（不加密、不塞进 searchCache.db） | 规则量小、要能导入导出/手改；演员元数据是中转缓存。不加密因为它们不含隐私，且可读性利于排查。若后续查询量变大再迁 nedb |
| D5 | 接口走现有 `route()` 咽喉点，加 `/assistant/*` 前缀 | 遵守既有不变量（统一兜底 + token 校验） |
| D6 | UI 用**全屏 `n-modal` 面板**，照抄 `HistoryTable` | 无 router；独立页面要引 vue-router（新增依赖）。模态最小侵入，且足够容纳规则/预览 |
| D7 | 应用（写盘）**默认只写封面文件**（非破坏）；「文件夹化 + 移动」作为**可选第二阶段** | 写新文件零风险、可回滚；移动有数据风险，且用户已表示分类可自己做 |
| D8 | 封面流程全自动（仅人工确认匹配）；头像流程**可选**、由用户按同名聚合触发，找不到就跳过 | 用户 2026-09-25 确认 |

---

## 三、文件结构（新建 / 修改）

```
新建:
  electron/server/assistant/
    index.ts          # 模块出口：注册路由、编排两条流程
    rules.ts          # 规则模型 + 读写(JSON) + 候选链执行器（纯函数，可单测）
    siteFetch.ts      # 统一抓取器：fetch 轻量路径 + 隐藏 BrowserWindow 路径 + 代理/限速/重试
    cookie.ts         # cf_clearance 等 cookie 的获取与缓存复用
    match.ts          # 文件名→片名解析、演员名归一化、同名聚合（纯函数，可单测）
    apply.ts          # 预览计划生成 + 安全应用（写封面文件 + 回滚日志）
    store.ts          # 演员元数据缓存（JSON）+ 站点规则持久化
  src/components/ManagerAssistant/index.vue   # 全屏面板（规则管理 / 找缺封面 / 预览确认 / 演员聚合）
  src/components/ManagerAssistant/SiteRuleEditor.vue  # 规则编辑（先 JSON + 试跑，后接可视化点选）

修改:
  electron/server/index.ts    # 顶部 import 并调用 assistant 的路由注册；不动既有路由
  src/App.vue                 # 挂载 <ManagerAssistant/>（与 <FileFinder/> 并列，v-if 控制显示）
  src/views/FileFinder/index.vue  # header-bar 工具条加一个入口按钮（照抄 showHistory 按钮）
  package.json                # 仅当确需新依赖时（目标：零新增）
```

**只新建、不重构**：不改动 `nedb.ts`、`wire()`、扫描逻辑、`thumbnail.ts` 任何现有行为。

---

## 四、数据模型（TypeScript）

```ts
// electron/server/assistant/rules.ts

/** 单个字段的一次抽取尝试：按 order 依次试，命中即用 */
export interface FieldCandidate {
  /** 'css' = cheerio 选择器取属性；'regex' = 对整页/脚本做正则；'meta' = 取 meta 标签 */
  kind: 'css' | 'regex' | 'meta';
  /** css: 选择器；regex: 正则字符串；meta: meta 的 name/property */
  selector: string;
  /** css: 取哪个属性(默认 src)；regex: 取第几个捕获组(默认 1) */
  attr?: string;
  group?: number;
}

/** 一个字段的完整抽取策略（候选链） */
export interface FieldRule {
  candidates: FieldCandidate[];
}

export interface SiteRule {
  id: string;                 // 稳定 id
  name: string;               // 展示名，如 'javbus'
  enabled: boolean;
  /** 详情页 URL 模板，{q} 为查询词。如 'https://www.javbus.com/{q}' */
  detailUrl: string;
  /** 搜索页 URL 模板（可选）；无则直接用 detailUrl */
  searchUrl?: string;
  /** 用哪种抓取通道 */
  transport: 'fetch' | 'browser';
  /** 该站需要的域名 cookie / 代理（可选） */
  needsCookie?: boolean;
  fields: {
    cover?: FieldRule;        // 封面图 URL
    title?: FieldRule;        // 标题
    actress?: FieldRule;      // 演员名（可多个）
    actressLink?: FieldRule;  // 演员页链接
  };
}

/** 抓取结果（一条视频） */
export interface GrabResult {
  videoRelPath: string;       // 目标视频（盘内相对路径）
  coverUrl?: string;          // 命中的封面 URL
  coverLocal?: string;        // 下载到本地临时路径
  title?: string;
  actresses?: { name: string; link?: string }[];
  hitSite?: string;           // 命中的站点 id
  status: 'ok' | 'no-match' | 'blocked' | 'error';
  message?: string;
}
```

```jsonc
// ~/.file-finder/assistant/rules.json  —— 一条 JAV 站规则示例
{
  "id": "javbus",
  "name": "javbus",
  "enabled": true,
  "detailUrl": "https://www.javbus.com/{q}",
  "transport": "browser",        // 该站有 Cloudflare，走隐藏窗口
  "needsCookie": true,
  "fields": {
    "cover": {
      "candidates": [
        { "kind": "css", "selector": ".screencap .bigImage img", "attr": "src" },
        { "kind": "meta", "selector": "og:image" }
      ]
    },
    "actress": {
      "candidates": [
        { "kind": "css", "selector": ".star-name a", "attr": "text" },
        { "kind": "regex", "selector": "<a[^>]*class=\"star-name\"[^>]*>([^<]+)</a>", "group": 1 }
      ]
    }
  }
}
```

---

## 五、分阶段落地

### Phase 0：确认封面文件名契约（先读，再动）
- **动作**：读 `electron/server/index.ts:313-413`（`handleCover`）与 `:197-209`（`makeDirCover`），确认：
  1. 影片目录（内含 `ABC-123.mp4` + `ABC-123.jpg`）时，tile 用哪张图？
  2. 只有 `cover.jpg` 时用哪张？
  3. 演员目录用 `avatar.jpg` 是否就是"目录的脸"？
- **产出**：在本文档追加"封面文件名结论"小节，锁定 apply 写哪个名字。
- **验证**：手造一个临时目录，放进这三种情况，跑起来看 tile。**未实测前不写 apply。**

### Phase 1：骨架 + 规则引擎 + 单站跑通（封面）
- **文件**：`assistant/rules.ts`、`assistant/match.ts`、`assistant/siteFetch.ts`（先只做 `transport:'fetch'`）、`assistant/index.ts`；注册路由 `/assistant/rules`(GET/POST/DEL)、`/assistant/preview`(POST)。
- **关键接口**：
  ```ts
  // rules.ts —— 纯函数，便于单测
  export function runFieldRule(html: string, rule: FieldRule): string | undefined;
  export function loadRules(): SiteRule[];
  export function saveRule(rule: SiteRule): void;
  export function deleteRule(id: string): boolean;

  // match.ts —— 纯函数
  export function parseTitle(fileBaseName: string): { title: string; year?: string; part?: number };
  export function normalizeActorName(name: string): string;

  // siteFetch.ts
  export function fetchAsBrowser(url: string, opts?: { cookie?: string; timeoutMs?: number }): Promise<string>; // 先抛未实现
  export function fetchText(url: string, opts?: { cookie?: string; proxy?: string }): Promise<string>;
  ```
- **路由**：`/assistant/preview` 接收 `{ serial, relPath, siteId }` → 返回 `GrabResult[]`（只查、不写盘）。
- **验证**：`npm run typecheck`；用一条 fetch 型规则，对 1~2 个真实 URL 跑 `runFieldRule`，确认能拿到底图 URL。

### Phase 2：抓取层（含 Cloudflare）
- **文件**：`assistant/siteFetch.ts` 增 `fetchAsBrowser`；`assistant/cookie.ts`。
- **做法**：
  - `fetchAsBrowser`：创建 `new BrowserWindow({ show:false, webPreferences:{ offscreen:true } })`，`loadURL` → 等 `did-finish-load` → `webContents.executeJavaScript('document.documentElement.outerHTML')` 取 HTML；超时销毁。
  - `cookie.ts`：`session.defaultSession.cookies.get({ url })` 取 `cf_clearance`，缓存到内存并复用；轻量请求带上它走 `fetch`。
  - 限速：模块级 `p-limit` 风格串行队列（不新增依赖，手写 8 行令牌队列亦可）；重试：指数退避。
- **验证**：对一个已知上 CF 的站，`fetchAsBrowser` 能拿到含目标节点的 HTML（用 `pnpm`/`node` 起 Electron 手测，或走 `electron-headless-verify` skill 的无头手法）。

### Phase 3：可视化规则编辑（先 JSON + 试跑）
- **文件**：`src/components/ManagerAssistant/SiteRuleEditor.vue`。
- **MVP**：JSON 编辑器（可内置轻量 textarea，或后续引 CodeMirror）+「输入样例 URL → 试跑 → 显示命中的字段值」面板。**保存前必试跑通过**。
- **后续（可选）**：接入可视化点选（用一个可见 `BrowserWindow` 或 iframe 渲染样例页，点击元素生成选择器）。**先不做，等 JSON 版稳定。**

### Phase 4：演员元数据 + 分组 + 可选头像
- **文件**：`assistant/store.ts`（`~/.file-finder/assistant/actors.json`）、`match.ts` 增 `groupByNormalizedActor()`；路由 `/assistant/actors`(GET)、`/assistant/actors/avatar`(POST)。
- **流程**：抓封面时顺手存 `{ actor normName, rawNames[], links[], movies[] }` → 面板按归一名分组展示 → 用户点某组「补头像」→ 抓 `avatar.jpg` 写进对应演员目录（若目录已存在）。**找不到就跳过，不报错。**

### Phase 5：预览确认 + 安全应用
- **文件**：`assistant/apply.ts`；路由 `/assistant/apply`(POST)。
- **做法**：`preview` 返回计划（哪条视频 → 下载哪张图 → 写到哪个路径）；用户确认后 `apply` 执行：下载图到临时文件 → 校验为有效图片（`nativeImage` 能解）→ 写入目标名（Phase 0 锁定）→ 记一行回滚日志 `~/.file-finder/assistant/apply.log`。**默认只写封面文件，不移动/不删视频。**
- **验证**：对一个小目录跑完整链路，检查 tile 是否变成抓取的封面；检查日志可回滚。

---

## 六、验证策略

- 每个 Phase：`npm run typecheck` 必须 exit 0。
- **纯函数**（`runFieldRule` / `parseTitle` / `normalizeActorName` / `groupByNormalizedActor`）值得单测 → 建议引入 `vitest`（devDependency，不影响打包），这是本方案唯一建议新增的依赖。
- 主进程行为（抓取、写盘）用无头手法验（参考项目已有 `docs/probes/` 与 `electron-headless-verify` skill）。
- 界面/观感必须**真机目视**（无头验不了）。

---

## 七、开放决策（已给推荐，等用户点头即可开工）

1. **UI 入口**：推荐**全屏 `n-modal` 面板**（D6），工具条加一个按钮。若你更想要独立页面，需要引 vue-router。
2. **应用行为**：推荐**默认只写封面文件**、移动/文件夹化列为可选（D7）。
3. **浏览器层**：推荐**Electron 隐藏窗口**替代 puppeteer（D1）。若你坚持 puppeteer，需新增依赖并注意打包契约。

## 八、风险
- **ToS / 合规**：抓取部分站点可能违反其服务条款；代理与限速只能降低封禁概率，不改变性质。建议优先用对用户开放的源、控制频率。
- **站点结构漂移**：这正是规则引擎存在的理由，但要接受"规则偶尔要维护"。
- **打包体积**：若最终不得不引 puppeteer，会显著增大安装包（D1 就是为规避它）。
- **ffprobe 超时回收**：项目已知问题（见 MEMORY §六），与本模块无直接耦合，但抓取并发时注意别叠压主进程事件循环。
