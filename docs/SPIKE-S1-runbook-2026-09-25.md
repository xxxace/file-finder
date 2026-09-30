# Spike S1 运行手册（新会话 · 真机）

> 目标：验证「隐藏 `BrowserWindow` 能否过目标站 Cloudflare + 单站封面命中率 ≥70%」。
> 这是 PRD 的**最后一个 go/no-go 闸门**。通过才进 Phase 1。

## 一句话流程
**开新会话 → 丢这句话给它 → 你在场（可能要人工过一次验证）→ 看结论：**

> 读 `docs/PRD-manager-assistant-2026-09-25.md` §14 和 `docs/SPIKE-S1-runbook-2026-09-25.md`，按它执行 S1 抓取 spike，最后产出 `docs/spike-S1-result.md`。

## 前置
- **目标站（均无账号）**：封面 `freejavbt` / `javwine` / `javbus` / `javdock` / `onejav`；演员 `javtext.net`。
- **环境**：真机 + 真网络。`npm run dev` 可选（也可写独立 spike 脚本起隐藏窗）。

## 步骤（新会话里照做）
1. 写 spike 脚本（放 `docs/probes/s1-cf/`，**不碰主程序代码**）：起
   `new BrowserWindow({ show:false, webPreferences:{ partition:'persist:assistant', nodeIntegration:false, contextIsolation:true, sandbox:true, userAgent:<真实Chrome UA> } })`。
2. 对每站，加载一个**真实番号**的详情页 URL；**轮询目标选择器是否出现**（不能只等 `did-finish-load`——挑战页会先完成），再取 `document.documentElement.outerHTML`。
3. 记录每站：是否被 CF 拦、是否需**人工过一次**（若需要：用同 `partition` 开一个**可见**窗口点一下，之后复用该 session）、是否需 cookie。
4. 每站对 **10 个真实番号**统计：能否取到含目标节点的 HTML / 能否抽出封面 URL。
5. 产出 `docs/spike-S1-result.md`：每站一张表（通道 / 是否需人工 / 命中 n/10）+ 一句话结论。

## go/no-go
- ✅ **过**：至少 **1 站 ≥70%** 且 session 可跨请求复用 → 进入 **Phase 1**。
- ❌ **不过**：回退 fetch-only，或换源（必要时试代理），并**重估整体**。

## 分工
- **你要做的（就一件）**：如弹出验证，**人工点一下**。
- 其余交给新会话的 AI。

## 产物
- `docs/spike-S1-result.md`（每站结果表 + 结论）
