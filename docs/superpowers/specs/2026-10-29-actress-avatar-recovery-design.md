# 设计文档 · 女优目录头像回收（基于 Gfriends 开源库）

> 日期：2026-10-29  
> 状态：已确认，待用户审批（Approved Gate）  
> 关联：`docs/PRD-manager-assistant-2026-09-25.md`  

---

## 1. 背景与目标（Intent & The Why）

### 1.1 背景
用户使用 file-finder 浏览与管理外置移动硬盘中的 JAV 收藏。用户的文件组织习惯以“女优目录”为分类单位（例如 `H:/JAV/三上悠亚/`、`H:/JAV/河北彩花/`）。
由于外部拷贝或历史原因，大量女优目录内部缺少 `avatar.jpg` 或 `cover.jpg`，导致在主界面的网格卡片中仅显示默认的文件夹图标（无脸），无法一眼识别女优。

### 1.2 目标（Goals）
1. **零读盘定位直属目录**：仅从现有内存缓存（`searchCache.db`）中，检索**当前浏览目录下的直属子文件夹**中所有缺少头像的项（`type === 'folder'` 且 `!avatar`）。
2. **番号目录精准剔除**：复用项目现有的 `parseTitle(name).id` 引擎，若目录名自身被判定为影片番号（如 `SSNI-001`、`IPX-123`），自动排除，确保进入候选池的均为纯女优目录。
3. **Gfriends 高效匹配**：接入开源社区的 Gfriends 演员头像索引（包含上万名女优的高清方形免冠照），在本地建立索引缓存并支持多 CDN 镜像，实现秒级高命中率匹配。
4. **名称清洗与别名容错**：对目录名进行清洗（去除 `[厂牌]`、日期、常见括号等杂质），结合简繁转换与别名映射，准确识别女优真实姓名。
5. **独立弹窗与预览确认**：在顶部操作栏下拉菜单中提供独立的「女优头像回收」入口，弹窗表格化展示目录名、识别女优、头像预览与状态；支持全选、反选、行内手动修改姓名或粘贴图片 URL。
6. **原子写入与即时生效**：将确认的头像安全写入 `<女优目录>/avatar.jpg`（若已有旧文件则先备份），并主动失效对应目录缓存触发 `makeDirCover`，无需重启或重新插拔盘即可在网格中即时“长脸”。

### 1.3 明确不做（Non-Goals & Anti-Goals）
1. **不做自动分拣/移动视频**：用户已明确指出“不同时期不同艺名、多人演出归属主观性强，自动分拣不可行”。坚决不碰视频文件的物理位置，绝不执行跨目录移动。
2. **不做全局女优墙**：用户无脱离硬盘的抽象聚合需求；头像回收严格锚定在“当前盘/当前目录内直属的女优文件夹”。
3. **不做静默写盘**：任何写盘动作必须经过用户在预览表格中的确认。

---

## 2. 约束条件（Constraints）

1. **在线盘闸门（用户特别强调）**：**仅允许对当前在线（已挂载）的盘执行头像写入与缓存失效；离线盘坚决不允许操作**。若当前浏览路径处于离线锚点（`#<serial>/...`）或盘符未就绪，界面禁用写入操作并给予明确提示。
2. **少读盘铁律**：扫描候选目录和计算匹配时，**磁盘读取次数必须为 0**（基于内存缓存）。
3. **文件名与渲染契约**：严格遵循 `dirCover.ts` 中的契约 `DIR_COVER_FILES = ['avatar.jpg', 'cover.jpg', ...]`。写入目标固定为 `avatar.jpg`（小写），图片格式经 Node/Chromium 转码为标准高质量 JPEG。
4. **HTTP 咽喉点契约**：服务端路由统一挂载在 `route()`（`127.0.0.1:3060`，带 token 校验）。
5. **组件解耦契约**：不侵入现有的 `AssistantCoverModal.vue`（已高度复杂），新建独立的 `AssistantAvatarModal.vue`，实现业务隔离和零回归风险。

---

## 3. 备选方案对比与选型（Approaches）

在方案设计初期，评估了三种技术路线：

| 方案 | 数据源与原理 | 优势 | 劣势 | 结论 |
|---|---|---|---|---|
| **方案 A：Gfriends 开源库** | 使用开源 Gfriends 静态索引与 CDN 图片 | 极速、零反爬、无 Cloudflare 困扰、头像比例为统一免冠方图、无占位图骚扰 | 少数极新出道女优可能有更新滞后 | **采用（用户确认）** |
| **方案 B：动态爬虫** | 现有隐藏 Chromium 窗爬取 JavBus/JavDB | 紧跟资源站最新番号 | 极慢、频繁触发 CF 阻断、大量默认占位图（`uid=0`）误报 | 放弃 |
| **方案 C：双源混合** | Gfriends 优先 + 爬虫兜底 | 覆盖率最高 | 复杂度高，需要管理两套反爬状态 | 降级为在预览表中提供手动填 URL |

---

## 4. 详细技术方案（Architecture & Specifications）

### 4.1 核心数据结构

#### 4.1.1 Gfriends 索引模型
Gfriends 维护的 `Filetree.json` 记录了日文原名、简繁中文别名到具体文件路径的映射：
```ts
export interface GfriendsIndex {
    version: string;
    updatedAt: number;
    // 归一化名字 (小写/去除空格) -> 图片在仓库中的相对路径 (如 "Content/A/三上悠亜.jpg")
    actors: Record<string, string>;
}
```

#### 4.1.2 候选与匹配条目模型
```ts
export interface ActressAvatarTarget {
    /** 目标目录在盘内的相对路径（如 "JAV/三上悠亚"） */
    relDir: string;
    /** 原始文件夹名称（如 "[S1] 三上悠亚"） */
    folderName: string;
    /** 清洗后提取出的女优名字（如 "三上悠亚"） */
    cleanName: string;
    /** 匹配到的官方归一化名字（如 "三上悠亜"） */
    matchedName: string | null;
    /** 头像下载 URL（CDN 地址） */
    avatarUrl: string | null;
    /** 状态：'matched' | 'unmatched' | 'manual' */
    status: 'matched' | 'unmatched' | 'manual';
}
```

### 4.2 后端模块与接口设计

新建 `electron/server/assistant/gfriends.ts` 与 `electron/server/assistant/avatarScan.ts`，路由挂载至 `server/assistant/index.ts`。

1. **`GET /assistant/avatar/index-status`**
   - 检查本地 Gfriends 索引缓存（`~/.file-finder/gfriends/filetree.json`）是否存在、版本与更新时间。
   - 若不存在或用户请求更新，后台拉取官方源或 CDN 镜像（支持 jsdelivr / GitHub Raw / cdn.jsdelivr.net 等多镜像自动回退）。

2. **`POST /assistant/avatar/scan`**
   - 入参：`{ serial: string, relPath: string }`
   - 逻辑：读取该盘内存中的缓存记录（`searchCache.db`），**仅筛选当前 `relPath` 下一级的直属子目录**中 `type === 'folder' && !item.avatar` 的项。
   - 过滤：对目录名使用 `parseTitle(name).id` 校验，如果属于影片番号，则直接忽略。
   - 返回：待处理目录清单 `targets: { relDir, folderName, cleanName }[]`。

3. **`POST /assistant/avatar/match`**
   - 入参：`{ names: string[] }`
   - 逻辑：对每个名字执行规则清洗（去方括号/特殊词），在 Gfriends 索引中比对（支持简繁转换映射）。
   - 返回：匹配结果 `{ [rawName]: { matchedName, avatarUrl } }`。

4. **`POST /assistant/avatar/apply`**
   - 入参：`{ serial: string, items: { relDir: string, avatarUrl: string }[] }`
   - **在线性校验**：通过 `getDrives()` 检查 `serial` 对应的盘是否在线。若处于离线状态，坚决拒绝写入（返回 400），且不触动任何缓存。
   - 逻辑：
     - 并发受控下载图片（限制 3~5 并发）。
     - 转码为合法 JPEG 字节。
     - 写入目标文件 `${diskPath}/${relDir}/avatar.jpg`。若已存在旧文件则先备份至 `~/.file-finder/backups/`。
     - 仅对在线盘失效受影响目录的缓存（`removeCache(serial, relDir)`），并触发该目录生成新的缩略图签名（长脸）。
     - 返回写入结果统计与日志。

### 4.3 名称清洗与别名算法
女优目录命名常见格式处理：
1. **标签过滤**：正则去除开头的 `^\[(.*?)\]\s*`、末尾的 `\s*\[(.*?)\]$` 或 `\((.*?)\)`，例如 `[S1] 三上悠亚 (2020)` -> `三上悠亚`。
2. **番号与纯数字过滤**：复用 `parseTitle(name).id`，若命中番号则丢弃；若清洗后为空或纯数字，同样丢弃。
3. **简繁归一化**：内置常见高频简繁汉字映射（如 `亚->亜`、`爱->愛`、`绘->絵`、`咲->咲`、`泷->滝`）。
4. **别名兜底**：Gfriends 自带别名表若命中，则直接指向主图。

### 4.4 前端交互设计（`AssistantAvatarModal.vue`）

1. **入口扩展**：
   - 在 `FileFinder/index.vue` 顶部操作栏下拉菜单中新增「女优头像回收」选项（与“重新读取”、“补封面”、“换封面”并列）。
2. **界面状态流转**：
   - **Step 1 - 扫描准备**：显示当前浏览路径（如 `H:/JAV/`），提示“将扫描此目录下的直属子文件夹”，点击 `[开始扫描]`。
   - **Step 2 - 匹配中**：进度条展示 `正在匹配 Gfriends 索引 (45/120)...`。
   - **Step 3 - 结果预览表**（`n-data-table`）：
     - 列 1：多选框（默认全选命中项，未命中项不勾选）。
     - 列 2：头像缩略图预览（`n-image`，带预览大图）。
     - 列 3：目录原始名称。
     - 列 4：识别女优（可原地输入修改重新匹配）。
     - 列 5：匹配状态（`n-tag`：已命中、未找到、已手动指定）。
     - 列 6：行内操作（“手动填图片链接”、“重新检索”）。
   - **Step 4 - 批量写入**：
     - 底部显示 `已选择 N 个目录`，点击 `[写入头像到目录]`。
     - 二次确认后执行写入，显示实时进度条。
     - 完成后提示 `成功写入 N 个目录头像`，并自动触发主界面网格刷新。

---

## 5. 留给构建者的设计决策（Left to Builder）

1. **CDN 镜像列表与超时重试策略**：由构建者在 `gfriends.ts` 中配置默认的 CDN 列表（如 jsdelivr、ghproxy 等）及 5 秒超时切换机制。
2. **简繁转换轻量实现**：优先采用内置静态替换表或极简 map，避免引入巨大的第三方分词/转换字典库。
3. **预览表分页与虚拟滚动**：若当前目录内子文件夹超过 200 个，由构建者使用 naive-ui 虚拟滚动或分页保证 UI 帧率流畅。
