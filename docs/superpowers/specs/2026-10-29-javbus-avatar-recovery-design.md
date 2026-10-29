# 女优头像回收 · JavBus 官方高清数据源升级设计方案

## 1. 背景与目标

当前女优头像回收功能依赖社区整理的 Gfriends 开源仓库。用户反馈：
> "获取头像的数据源我不认可，很多头像都很随便，还不如人家那些jav数据库网站的好，能不能切换升级？"
> "先以javbus吧"

社区库存在较多粉丝二创、日常自拍照或截取图，规格与质感参差不齐。而 JavBus 收录的均为 DMM / SOD / S1 摄影棚出品的**官方标准正脸大头照**，具备统一白底/影棚背景、极高清晰度与标准化构图。

本方案将女优头像回收的数据源升级为 **JavBus 官方高清大头照**，同时保留 Gfriends 作为备选兜底，实现：
1. **官方品质**：优先提取 JavBus 官方演员大头照（`pics/actress/{id}.jpg`）；
2. **简繁/日文汉字自动归一化**：自动通过现有汉字与别名映射表将简体中文文件夹名转换为 JavBus 日文官方名进行搜索；
3. **本地缓存（0ms 重复命中）**：检索过的演员头像映射持久化至本地 `~/.file-finder/javbus-actresses.json`，二次扫描无需网络请求；
4. **防盗链穿透**：通过 Chromium `net.request` 自动携带 `Referer: https://www.javbus.com/`，解决外链 403 阻断；
5. **UI 数据源切换**：弹窗默认使用 JavBus，支持在 JavBus 与 Gfriends 之间无缝切换。

---

## 2. 核心架构设计

```
[前端: AssistantAvatarModal.vue]
    │  选择数据源: 'javbus' (默认) | 'gfriends'
    │  点击「扫描直属目录」或行内「重新匹配」
    ▼
[后端端点: /assistant/avatar/scan & /assistant/avatar/match]
    │
    ├── 若 source === 'javbus':
    │     ├── 1. 查本地缓存 ~/.file-finder/javbus-actresses.json (0ms 命中)
    │     ├── 2. 未命中则汉字清洗归一化 (三上悠亚 -> 三上悠亜)
    │     ├── 3. 请求 JavBus 演员搜索: https://www.javbus.com/searchstar/{name}
    │     ├── 4. 解析 .avatar-box img 提取官方头像
    │     └── 5. 写入本地缓存并返回
    │
    └── 若 source === 'gfriends':
          走原有的 Gfriends 离线索引匹配
    │
    ▼
[头像预览与落盘: /assistant/preview & /assistant/avatar/apply]
    │
    ├── Chromium net.request 注入 Referer: https://www.javbus.com/
    ├── 预览图自动进 previewCache 内存缓存
    └── apply 时复用内存缓存原子写入 avatar.jpg 并失效 NeDB 缓存
```

---

## 3. 详细技术实现

### 3.1 JavBus 爬取与解析器 (`electron/server/assistant/javbus.ts`)
- **搜索路径**：
  `https://www.javbus.com/searchstar/${encodeURIComponent(cleanName)}`
  （备选路径 `https://www.javbus.com/search/star/${encodeURIComponent(cleanName)}`）
- **请求通道**：
  使用 `net.request` 发送 HTTP GET 请求，带上真实 Chrome UA 及 `Referer: https://www.javbus.com/`。
  若被 Cloudflare 拦截，通过 `siteFetch.ts` 隐藏 BrowserWindow 兜底抽取。
- **HTML 解析**：
  选择器 `.avatar-box`：
  - 头像地址：`img.getAttribute('src')`（相对路径补全为完整 URL）
  - 演员名字：`img.getAttribute('title') || span.textContent`
  - 演员 ID：从 `a[href]` 提取 `/star/{starId}`
- **名称匹配优化**：
  利用 `KANJI_MAP`（亚->亜、泽->沢、爱->愛、优->優等）进行双向匹配，精确匹配优先，包含匹配次之。
- **本地持久化缓存**：
  `readJavBusCache(dataDir)` / `writeJavBusCache(dataDir, cache)` 存储在 `~/.file-finder/javbus-actresses.json`。

### 3.2 穿透防盗链 (`electron/server/assistant/apply.ts`)
- 在 `download(url, signal)` 中检测：若 URL 包含 `javbus`、`buscdn`、`/pics/actress/` 等特征，自动附带请求头：
  `req.setHeader('Referer', 'https://www.javbus.com/')`
- 本地代理 `/assistant/preview?url=...` 自动继承该 Referer，渲染层 `<n-image>` 正常加载大头照。

### 3.3 扫描与匹配服务适配 (`electron/server/assistant/avatarScan.ts` & `index.ts`)
- `scanActressFolders(serial, relPath, dataDir, source: 'javbus' | 'gfriends' = 'javbus')`
  - 并发度限制：5 个 Worker 并发向 JavBus 检索，避免被反爬限流。
  - 自动兜底策略：若 JavBus 未搜到且启用了 fallback，回退 Gfriends。
- `/assistant/avatar/scan` 与 `/assistant/avatar/match` 接收可选字段 `source`。

### 3.4 前端界面增强 (`src/views/FileFinder/AssistantAvatarModal.vue`)
- 顶部增加数据源切换器：
  `JavBus 官方大头照 (推荐)` vs `Gfriends 社区库`
- 表格状态标签展示匹配来源，如 `JavBus 官方`。

---

## 4. 验证与测试策略
1. **单元测试探针**：`docs/probes/avatar/javbus-test.mjs`
   - 测试 HTML `.avatar-box` 解析逻辑；
   - 测试 `KANJI_MAP` 汉字转换匹配；
   - 测试本地缓存持久化与读取。
2. **完整扫描与落盘探针**：
   - 验证 `applyActressAvatars` 配合 JavBus 头像 URL 正常落盘并备份。
3. **TypeScript 静态检查**：`npm run typecheck` 0 错误。
