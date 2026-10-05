# FIX-2026-10-05 · 面包屑 `.crumb-text` 顶部被裁切（1-2px）

**改动**：`src/views/FileFinder/index.vue` 的 `.crumb-text` 加一行
`line-height: var(--n-height, 1.4)`（含 3 行判据注释）。**只此一处**。

## 症状（业主报）
面包屑 `.crumb-text`（路径块里 `.n-tag__content` 内的文字）**文字上半部分被裁 1-2px**，
加粗 + 缩略（省略号）叠加时最明显。

## 根因（实测，非推理）
`naive-ui` 的 `.n-tag { line-height: 1 }` **继承**进 `.crumb-text`。
省略号的前置条件是 `overflow: hidden`，于是**裁剪盒只有 `1em` = 14px**，
而字体自己的内容区（ascent + descent）实测 **16~20px** ⇒ 盒子比字形矮 2~6px，
墨迹被压在裁剪边界上。

| 字体（主字体 / 文字） | 墨迹顶到裁剪盒顶的余量 | 被裁 |
|---|---|---|
| 应用字体链 / 新建文件夹 | 0.5px（= 0 行） | 否（刀锋） |
| Segoe UI / Verdana / Tahoma / 雅黑 / MS Gothic / Georgia … | 0.5~1.5px | 否（刀锋） |
| **Courier New / 新建文件夹** | **-0.5px** | **顶行被切（28px 墨迹 @ 相对 tag 顶 6px）** |
| 对照：把裁剪盒压到 0.9em | -0.2px | 顶+底被切 |

⇒ 业主机器上的字体组合落到了被裁那一侧。**加粗**只是让被切的那一行更粗更显眼，
**省略号**只是提供了那个 `overflow:hidden` 裁剪盒 —— 病根是 `line-height:1`。

## 修复与验证
`line-height: var(--n-height, 1.4)` → 裁剪盒 = tag 自身内高 28px：

- 顶余量：`chain` 0.5 → **7.5px**；`courier` -0.5 → **6.5px**；20 组正规组合 **0/20 被裁**
- `tag` 高**恒 28px**（定值 + 行盒居中）⇒ **零布局影响**，字形位置逐像素不变
- `text-overflow: ellipsis` 与水平截断行为**未变**
- 回退值 `1.4`：万一 naive-ui 改了 CSS 变量名也不会退回 `line-height:1`

**证据**：`docs/probes/crumb-clip/`（真 Chromium + 真 naive-ui + **真实编译产物** CSS）
→ `out.txt`（结论）· `README.md`（判据与三个探针坑）· `zoom-*.png`（8× 目视）。
复跑：`bash docs/probes/crumb-clip/run.sh`

**证据等级**：实测（真 Chromium 真 naive-ui 真实 scoped CSS）。
⚠️ **未在应用实体内复跑**（探针用的是 DOM 复刻 + 真实 CSS）⇒ 待业主在 dev 里目视复核。

## 遗留 / 备注
- `npx vue-tsc --noEmit` 有 3 个错误，全在**未提交的新文件** `AssistantRulesModal.vue`
  （`notification.warning/error/success` 不存在）——与本次改动无关，是业主在做中的「站点规则」功能。
- `git diff src/views/FileFinder/index.vue` 里除本次 `line-height` 那一段外，其余是业主在做中的
  `AssistantRulesModal` 接入（「站点规则」菜单项 / ref / import）。
- 现状复跑时若 `旋钮生效校验` 里「修复前」不是 14px ⇒ 探针旋钮失效，整轮结论作废（踩过）。
