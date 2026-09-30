# Spike S1 结果（实测 · 2026-09-25 真机）

> 对应：`docs/PRD-manager-assistant-2026-09-25.md` §14(S1) ＋ `docs/SPIKE-S1-runbook-2026-09-25.md`
> 脚本：`docs/probes/s1-cf/spike.cjs`（真机 `electron docs/probes/s1-cf/spike.cjs` 产出）
> 原始机读数据：`docs/probes/s1-cf/result.json` ＋ `docs/probes/s1-cf/spike-S1-result.md`

## 0. 结论

**go/no-go：✅ GO —— S1 机制关通过，进入 Phase 1。**

判定依据（PRD §14）：至少 1 站封面命中 ≥70% 且 session 可跨请求复用。
**javbus 货真价实 100%**（真封面 URL、正确选择器、无 CF），单这一站已满足闸门。

⚠️ **诚实修正（重要）**：原脚本输出显示「javbus / freejavbt / javdock 三站 100%」，
但其中 **freejavbt 与 javdock 是假阳性**——抽到的其实是**站点 logo / 主题图**
（`theporndude.png` / `dock/logo.png`），不是影片封面。已修脚本（封面抽取加 `logo/theme/banner`
黑名单），重跑后这两站会如实显示「通道✓封面✗」。所以**真实命中只有 javbus 一站确认**，
其余站的封面抽取要在 Phase 1 按站校准。

---

## 1. 实测环境

- 机器：用户真机（Windows），全局 VPN 已开（虚拟网卡），PowerShell 跑 `electron`。
- 样本：用户提供的真实番号 `TST-218` / `TST-229`（各站 2 条）。
- 机制：隐藏 `BrowserWindow`（`show:false` + `partition:'persist:assistant'`）＋ 真实 Chrome UA ＋ D12 安全配置；
  CF 挑战时同 partition 开可见窗，用户在窗内过验证后**关闭窗口**即继续（已修掉原「等终端回车」卡死 bug）。

---

## 2. 每站结果（如实标注真假命中）

| 站点 | 通道 | 封面命中 | CF | 人工 | 真实情况 |
|---|---|---|---|---|---|
| **javbus** | 2/2 ✅ | **2/2 (100%) 真** | 0 | 0 | 封面 `/pics/cover/*.jpg`，选择器正确，**确认可用** |
| freejavbt | 2/2 ✅ | 2/2 标 100% **但假阳性** | 0 | 0 | 抽到的是主题图 `theporndude.png`，**封面选择器待校准** |
| javdock | 2/2 ✅ | 2/2 标 100% **但假阳性** | 1 | 1 | 抽到 `dock/logo.png`（显式 `.movie img` 命中 logo），**选择器待校准**；CF 已靠 1 次人工过 |
| javwine | 0/2 | 0% | 0 | 0 | spike 用的直链 `javwine.com/{id}` 不对（各站查询方式不同）→ **URL/查询待校准**，非不可达 |
| onejav | 0/2 | 0% | 2 | 2 | **CF 手动过也没破**（可能在可见窗没点完 / 或它更倔）→ 候选源风险，不影响 GO |
| javtext.net(actress) | 0/2 | 0% | 0 | 0 | spike 用 `?type=actress&q={电影番号}` 不对（它是演员站）→ **查询方式待校准**，非不可达 |

> 用户确认：「其实都可以访问的，只不过 DOM 不一样，番号的查询方式不一样」——
> 即 javwine/javtext 的 0% 是 **spike 脚本里 URL/查询写错**，不是站点问题，属 Phase 1-3 按站写规则。

---

## 3. 已确认的事实 vs 待办

**已确认（机制层，S1 要回答的问题）**
- 隐藏窗 + 真实 UA + `persist:assistant` partition 能稳定加载 javbus/freejavbt/javdock 详情页。
- Cloudflare **可过**：javdock 靠 1 次人工过验证即通过；javbus/freejavbt 无需过。
- session（cf_clearance）落在 partition，**跨请求/跨窗口复用**成立（人工过一次后隐藏窗 reload 即得内容）。
- **≥1 站真命中 100%** → 满足 go/no-go。

**待办（不是 S1 闸门，是 Phase 1-3 的活）**
1. **封面抽取做对**：freejavbt / javdock 的选择器当前抽到 logo；要按真实 DOM 写准（用 PRD「规则试跑闸门」校准）。
   脚本已加 logo/theme 黑名单防假阳性，重跑可验证。
2. **javwine / javtext 的正确查询方式**：先探清楚这两站怎么用番号查到影片/演员页。
3. **onejav 的 CF**：要么找到稳定过的办法，要么先把它从首版候选源拿掉（不影响 GO，已有 javbus）。

---

## 4. go/no-go 判定

- 判定标准：至少 1 站封面命中 ≥70% 且 session 可复用。
- 实际：**javbus 真命中 100%** ≥70% 且 session 可复用 → **GO ✅**。
- 不需要回退 fetch-only / 换源（那是无 GO 时的预案）。直接进入 **Phase 1**。

---

## 5. 下一步

按 PRD §11，S1 过了进 **Phase 1**：规则引擎 + 抽取执行器 + 单站跑通 + `/assistant/*` 路由（无写盘）。
Phase 1 的首要子任务就是把上面「待办」的封面抽取与站点查询校准掉，让命中率数字经得起复核。

---

## 6. 证据等级

- 网络 / Electron 启动 / CF 可过 / javbus 真命中：✅ **实测**（真机跑出）。
- freejavbt / javdock 假阳性、javwine / javtext 查询待校准、onejav CF 待破：✅ **实测暴露**，结论明确。
- 各站最终校准后的命中率：⏸️ 待 Phase 1 规则写准后复测。
