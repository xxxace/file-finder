# 补封面：假命中 + 碎图 + 写入产出「没封面的作品」（2026-11-10）

主人原话：
> 即使读回空内容或者是错误的空链接导致，也告诉用户匹配到了，界面都是 img 标签 src
> 内容错误或者空，加载失败的碎裂图片图标，然后我点了写入，居然还可以写入，
> 结果是多了一堆没封面的作品 `A/A.mp4` 没有 A.jpeg/png/webp 任意一种类型的文件作为封面。

---

## 一、两个根因（不是一个）

### 根因 ① 「命中」的定义错了

`grab.ts` 原来的判据是：

```ts
if (f && f.cover) { match = {...}; status:'ok'; appendHit(...); break; }
```

**抽到一个字符串就算命中**。没有验证它是不是 http(s) 绝对地址、能不能下载、字节是不是图。
于是空链接 / `blob:` / `data:` / 相对地址 / HTTP 200 的 HTML 错误页 / 0 字节 / 解不开的假图
全部一路绿灯。而下游三处**无条件信任**这个 `ok`：

| 消费者 | 症状 |
|---|---|
| `coverModel.buildCoverItems` | `state='ok'`、badge `已抓到` / 站点名 ⇒ **谎报命中** |
| 预览代理 `/assistant/preview` | 上游字节原样回给 `<img>` ⇒ **碎图图标** |
| `startApply` / `buildGroups` | `status==='ok' && coverUrl` 就进写盘队列 ⇒ **可以写入** |

更坏的是 `appendHit()` 把这个坏 URL 写进 `assistant-hits.jsonl`，以后 `force=false`
时**秒回同一条死链** ⇒ 重抓一万次还是坏图。

### 根因 ② 破坏性动作排在「封面还没拿到」之前

`runApply` 原来的顺序：

```
① mkdir 番号文件夹 + rename 搬视频   ← 盘已经被改了，rename 不可逆
② download 封面
③ toJpeg → tmp → rename 写封面
④ ok ? 记成功 : 记失败
```

② 或 ③ 一失败 ⇒ `ok=false`，但**视频已经在新建的 `A/` 里、里面没有任何封面文件**。
这正是 `A/A.mp4`。原代码甚至有注释承认这个半成品状态（"失败行也收：分组可能已经
搬完了分卷才在封面这步失败"）—— 它是被默许的设计缺陷，不是偶发异常。

> ⚠️ 抽帧慢、接口慢只是**让窗口变长**；根因是这两个判据/顺序，不是网络。

## 二、修法：一个判据 + 一个顺序

**新增 `electron/server/assistant/coverImage.ts`** —— 把「什么才算一张可用封面」收成一句话：
**能下载、非空、且能解码成 JPEG 的字节，才叫封面。**

- `isUsableCoverUrl()`：只收 http/https 绝对地址；空串、`blob:`、`data:`、相对路径、CSS 碎片全拒
- `getVerifiedCover(url, signal, gate?)`：形态 → 已验证字节缓存 → 下载 → 非空 → `toJpeg()` 解码
- `download()` / `toJpeg()` 从 `apply.ts` 搬过来（原来只有写盘在用，现在三处共用一份实现）
- 已验证的 JPEG 按 URL 存在 `verifiedBytes`（32MB / 200 条）：
  **抓取验过一次，预览和写盘直接复用同一份字节** ⇒ 图片请求总数比改前更少，且
  "预览里看到的那张" 与 "写进盘的那张" 逐字节相同

| 落点 | 改法 |
|---|---|
| `grab.ts` | 站点循环与 `hits.jsonl` 缓存复用**两条来源**都过判据；验不过继续下一个站点，不记 `ok`、不写命中缓存；缓存里的坏 URL 立墓碑并回退真抓。新增 `bad-cover` 状态（≠「站点没有这部片」） |
| `apply.ts` | `buildGroups` 用同一 URL 判据；**下载+解码+封面落盘全部成功之后才搬视频**；失败 ⇒ 盘上零改动（本次新建的空文件夹也收掉）；只有成功组进「同步收藏夹」 |
| `index.ts` | `/assistant/preview` 只回已验证的 JPEG，取不到就明确报错；`startApply` 过滤用同一判据 |
| `coverModel.ts` | `ok` 状态必须有 `coverUrl`；`bad-cover` 显示「封面取不到」 |
| `CoverCard.vue` / `AssistantCoverModal.vue` | `<img @error>` 把卡标成「封面取不到」、不画碎图、不计入 `counts.ready` ⇒ **写入按钮和 picks 都不含它**（抓取时验过 ≠ 渲染时还能取到，浏览器是唯一能观测这一刻的地方） |

**为什么不是给每个调用方补一刀**：三处调的是**同一个** `getVerifiedCover()`，不是各写各的守卫；
`ok` 的唯一生产者在 `grab.ts`，写盘的唯一生产者在 `apply.ts`。新增第四个消费者忘不了判据。

## 三、验证（证据）

- `npm run typecheck` 两段（`vue-tsc` + `tsc -p tsconfig.electron.json`）**0 error**
- `node docs/probes/cover-truth/verify.mjs`（打真源文件，electron/盘根用替身；`net.request`
  故意抛错模拟下载失败；盘根在临时目录）→ **`out.txt`：14 / 14 通过**，其中：
  - 13 种空/错链接全被拒；4 种坏链接在 `file` 形态下 **0 组**
  - **封面下载失败 ⇒ 盘根条目数不变、结果行 `ok:false`、任务正常收尾**
  - 对照组：真 JPEG ⇒ 封面写出、视频搬进 `A/A.mp4`、无 `.tmp` 残留（成功路径没被改坏）
- 既有 `docs/probes/faces/verify.mjs`：**12 条 `buildGroups` 回归全通过**；另有 2 条失败在
  `collectFaces` 全库穷举（真库数据漂移，涉及 `scan.ts` / `nedb.ts` / `match.ts`，本次一行未动）
- **未实测**：真机站点/真实坏链接、`<img @error>` 的目视效果 ⇒ 待主人目视

## 四、⚠️ 已经产生的那批 `A/A.mp4` 不会自动消失

这次修的是「**以后不再产生**」。之前写入留下的空封面文件夹，助手**不会自动清理、也不会回滚**
（不动用户盘上的既有文件是硬约束）。要清的话得单独走一遍只读清单 + 主人确认。
`assistant-hits.jsonl` 里的坏 URL 会自愈：下次抓取验不过 ⇒ 立墓碑 ⇒ 重新真抓。

## 五、验收（重启 dev 后，30 秒）

1. 改主进程代码 ⇒ **必须重启 dev**（热更不覆盖主进程）
2. 跑一次补封面：坏链接的卡应显示「封面取不到」、`…`/碎图不再出现、写入计数不含它
3. 故意塞一条会失败的链接点写入：`apply.log` 记 `fail`，**盘上不新建文件夹、不搬视频**
4. 正常一条：封面与视频一起到位（对照组，探针已跑过）
