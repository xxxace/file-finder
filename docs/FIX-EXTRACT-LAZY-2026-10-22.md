# 站点规则抽不到封面：CF 误判 / 懒加载 / 属性回退 / 现场证据（2026-10-22）

> 现场：javhdporn 配 `.data-no-lazy` + `srcset`，试跑显示「页面：被站点验证拦住了」
> 「封面：没有命中任何候选」「页面上的图：0 张」。而用户用「打开页面看看」时**页面渲染得好好的**。

## 一、三层原因，最致命的是第一层（代码 bug）

**① CF 判定误伤正常页面 —— 抽取脚本一次都没执行。**
`CF_DETECT` 原来最后一条是：

```js
|| /cf-chl-|challenge-platform|turnstile/i.test(document.body.innerHTML)
```

在**整页 HTML 里全文搜**这些词。可是正常站点的登录 / 评论 / 埋点组件也会用 Cloudflare
Turnstile —— 页面里带个 `turnstile` 字样就被判成"挑战页"。判成挑战之后 `runExtract` 直接
`continue`，**抽取脚本永远不执行** ⇒ `fields = null` ⇒ 界面显示"被拦 + 0 张图"，
而实际页面完全正常。这与用户"打开页面看看能渲染"直接对上了：那个入口不跑这个检测。

**② 判定错了还带否决权，没有第二次机会。**
就算真是挑战页，"抽不到"才是最终事实。原逻辑是"cf ⇒ 不抽"，应该改成"先抽，抽到就是好的"。

**③ 选择器自带时机陷阱 + 属性可能选错（次要，但会叠加）。**
`lazyloaded` 是**懒加载完成后**才追加的类，不是 HTML 天生带的。抓取窗是 1000×720、`show:false`
的隐藏窗，**不滚动** ⇒ 首屏外的图永远不进视口 ⇒ 类名不加、`src` 还是占位图，真地址留在 `data-src`。
F12 里能看到，是因为那是滚过、跑完脚本之后的页面。

## 二、改了哪五处

1. **收紧 CF 判定**（`siteFetch.ts` 的 `CF_DETECT`）：只认挑战页专有的三个强信号 ——
   标题（`just a moment` / `attention required` / …）、`#cf-challenge-running, .cf-challenge,
   #challenge-form, form[action*="__cf_chl"]`、`window._cf_chl_opt`。**删掉整页全文搜索**。
   判据宁可漏判也不能误判 —— 漏判由"抽不到"兜底。
2. **cf 从"否决权"降级为"解释"**（`runExtract` + `runSteps`）：即使判定为挑战页也先抽一次，
   抽到就返回成功（`cf` 一并置 false）；两条通道都不再因为 cf 提前 return。
3. **抽不到时自动滚一下页面**（`lazyNudge` + `LAZY_SCROLL_SCRIPT`）：第 3 轮滚到底、第 4 轮滚回顶
   （靠轮询分成两拍，否则 IntersectionObserver 的回调还没跑就离开了）。**只在抽不到时才滚**，
   正常站点第一轮就命中，零影响。`runExtract` 与 `runSteps` 都接，否则同类问题会在另一条路上复发。
4. **`tryCss` 支持属性回退链 + `srcset`**（`rules.ts`）：`attr` 允许 `src|data-src|data-original`，
   按序取第一个非空；`srcset` 形如 `a.jpg 1x, b.jpg 2x`，取第一个地址（与 `rawSrc` 同一套解析）。
   新建候选默认就带这条回退链（`RuleCoverList.vue`）。既有规则写的是单个属性，行为不变。
   另加 `looksUrl`：`attr:'style'` 会把整串 `background: url(...) 0% 0% / cover;` 当值返回，
   它非空、不含黑名单词 ⇒ **算命中**并堵死后面本来能用的 `og:image`；现在这类值直接跳过（`data:` 放行）。
5. **抓不到就留现场证据**：`SNAPSHOT_SCRIPT` 把当时的 `url / title / html`（截 800KB）拍下来，
   落盘到 `~/.file-finder/assistant/fail/fail-<时间>.html`（只留最近 5 份，写数据目录、不碰移动硬盘），
   试跑面板显示路径 + 页面实际停在哪 + **当前页面标题**。
   挑战页的标题是 `Just a moment...`，正常页面的标题带着番号 —— 一眼分清"真被拦"还是"选择器不在页面上"。

顺带：被拦时的红字原来叫用户"先去「补封面」过一次验证" —— 但补封面面板的验证按钮
只在抓到被拦结果之后才出现，照做会扑空。改成「打开页面看看 → 在那个窗口里过验证 → 回来重试」。

## 三、验证

- `npm run typecheck` → 0 error。
- 页面脚本是**字符串**，TS 查不到语法，单独跑过（esbuild bundle + electron stub → node，临时脚本未入库）：
  1. 三个脚本（`CF_DETECT` / `SNAPSHOT_SCRIPT` / `LAZY_SCROLL_SCRIPT`）语法 **PASS**
  2. 正常页面**含 `turnstile` 字样** → `cf = false` **PASS**（旧代码这里会是 true）
  3. 标题为 `Just a moment...` 的真挑战页 → `cf = true` **PASS**
  4. `src|data-src` 回退链（只有 `data-src`）→ 取到真地址 **PASS**
  5. `src|srcset` → 取到第一个地址 **PASS**
  6. `attr:'style'` 的整串 CSS 被挡 **PASS**
  7. 相对路径 `/pics/cover/x.jpg` 按页面地址补全 **PASS**
- **未实测**：真机上这个站的实际命中（需在 dev 里跑）。

## 四、这个站现在该怎么配

| 项 | 值 |
|---|---|
| 选择器 | `.data-no-lazy`（**去掉 `.lazyloaded`**；一页命中多张时加父级限定，`querySelector` 只取第一个） |
| 属性 | `src\|data-src\|data-original\|srcset` |
| 下一步候选 | `og:image`（meta，兜底最稳） |

重启 dev 后直接试跑。若还不中，面板会给「页面上的图」和「现场 HTML 路径」——
有这两样，"被拦"还是"选择器不对"不用猜。
