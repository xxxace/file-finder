# Spike S1 结果（实测 · 2026-09-25T05:37:23.385Z）

> 由 `docs/probes/s1-cf/spike.cjs` 在真机运行产出。
> go/no-go：最佳站点封面命中 **100%** → **GO ✅**

## 每站结果

### javbus

| 指标 | 值 |
|---|---|
| 样本数 | 2 |
| 通道通 | 2/2 |
| 封面命中 | 2/2 (100%) |
| CF 拦截 | 0 |
| 需人工过验证 | 0 |
| 通道通但需 cookie/选择器 | 0 |
| 错误 | 0 |

<details><summary>逐条明细</summary>

| 番号 | URL | 状态 | 封面 |
|---|---|---|---|
| TST-218 | https://www.javbus.com/TST-218 | 封面✓ | /pics/cover/c6b1_b.jpg |
| TST-229 | https://www.javbus.com/TST-229 | 封面✓ | /pics/cover/c8s4_b.jpg |

</details>

### freejavbt

| 指标 | 值 |
|---|---|
| 样本数 | 2 |
| 通道通 | 2/2 |
| 封面命中 | 2/2 (100%) |
| CF 拦截 | 0 |
| 需人工过验证 | 0 |
| 通道通但需 cookie/选择器 | 0 |
| 错误 | 0 |

<details><summary>逐条明细</summary>

| 番号 | URL | 状态 | 封面 |
|---|---|---|---|
| TST-218 | https://freejavbt.com/TST-218 | 封面✓(兜底) | https://freejavbt.com/theme/freejavbt/images/theporndude.png |
| TST-229 | https://freejavbt.com/TST-229 | 封面✓(兜底) | https://freejavbt.com/theme/freejavbt/images/theporndude.png |

</details>

### javwine

| 指标 | 值 |
|---|---|
| 样本数 | 2 |
| 通道通 | 0/2 |
| 封面命中 | 0/2 (0%) |
| CF 拦截 | 0 |
| 需人工过验证 | 0 |
| 通道通但需 cookie/选择器 | 0 |
| 错误 | 0 |

<details><summary>逐条明细</summary>

| 番号 | URL | 状态 | 封面 |
|---|---|---|---|
| TST-218 | https://javwine.com/TST-218 | 失败 | - |
| TST-229 | https://javwine.com/TST-229 | 失败 | - |

</details>

### javdock

| 指标 | 值 |
|---|---|
| 样本数 | 2 |
| 通道通 | 2/2 |
| 封面命中 | 2/2 (100%) |
| CF 拦截 | 1 |
| 需人工过验证 | 1 |
| 通道通但需 cookie/选择器 | 0 |
| 错误 | 0 |

<details><summary>逐条明细</summary>

| 番号 | URL | 状态 | 封面 |
|---|---|---|---|
| TST-218 | https://javdock.net/TST-218 | 封面✓ | /wp-content/themes/dock/logo.png |
| TST-229 | https://javdock.net/TST-229 | 封面✓ | /wp-content/themes/dock/logo.png |

</details>

### onejav

| 指标 | 值 |
|---|---|
| 样本数 | 2 |
| 通道通 | 0/2 |
| 封面命中 | 0/2 (0%) |
| CF 拦截 | 2 |
| 需人工过验证 | 2 |
| 通道通但需 cookie/选择器 | 0 |
| 错误 | 0 |

<details><summary>逐条明细</summary>

| 番号 | URL | 状态 | 封面 |
|---|---|---|---|
| TST-218 | https://onejav.com/TST-218 | CF拦 | - |
| TST-229 | https://onejav.com/TST-229 | CF拦 | - |

</details>

### javtext.net(actress)

| 指标 | 值 |
|---|---|
| 样本数 | 2 |
| 通道通 | 0/2 |
| 封面命中 | 0/2 (0%) |
| CF 拦截 | 0 |
| 需人工过验证 | 0 |
| 通道通但需 cookie/选择器 | 0 |
| 错误 | 0 |

<details><summary>逐条明细</summary>

| 番号 | URL | 状态 | 封面 |
|---|---|---|---|
| TST-218 | https://javtext.net/?type=actress&q=TST-218 | 失败 | - |
| TST-229 | https://javtext.net/?type=actress&q=TST-229 | 失败 | - |

</details>

## 结论

- 是否至少 1 站 ≥70% 且 session 可复用：是
- go/no-go：**GO ✅**
- 若 NO-GO：按 PRD §12/§14 回退 fetch-only 或换源（必要时试代理），并重估整体。
