# grid-cursor-focus · 焦点隔离与键盘归属（真 Chromium）

```bash
bash docs/probes/grid-cursor-focus/run.sh
```

**验什么**：三件**静态读代码读不出来、只有真浏览器能证**的事：

1. 焦点落在文件列表弹层里时，方向键**不会**动网格选择器（两个选择器不打架）
2. 预览层开着时按回车**只**定位、**不**打开（keydown 的 bail 真挡住了 keyup 那条）
3. 弹层关闭后焦点**真的**回到 body —— 否则方向键永久失灵且看不出原因

**为什么必须真浏览器**：这三条全是 **DOM 焦点归属 + 事件冒泡**。`getBoundingClientRect`
在 happy-dom 里恒为 0，冒泡/焦点规则更没法模拟。

**手法**：**两处判据都是真源码注入**，页面里不复刻：
- `build.mjs` → `src/utils/index.ts` 的 `isGridKeyBlocked`
- `build-decide.mjs` → `src/views/FileFinder/openDecision.ts` 的
  `decideOpen` / `isDirCard` / `isMultiFileCard`

## ⚠️ 两次踩坑（都在 `out.txt` 里留了痕）

**① 守卫被这套探针改过两次，两次都是真 bug**

| 版本 | 写法 | 症状 |
|---|---|---|
| v1 | `t !== document.body` | 合成事件 target 是 `window` ⇒ 方向键**全被误挡**（11 PASS / 7 FAIL）|
| v2 | `closest('body')` + 单独判 `isContentEditable` | `input.closest('body')` 也是 body ⇒ 守卫对 `<input>` **完全失效**（15 PASS / 3 FAIL）|
| **v3（现）** | `target ∈ {body, document, window}` ⇒ 放行，其余挡住 | 23 PASS / 0 FAIL |

**② 探针复刻判据 ⇒ 判据效力为零**

第一版页面里**手抄**了一份守卫。改成注入真源码后回退 `src/utils/index.ts`，
探针**依然 19 PASS / 0 FAIL** —— 因为改探针不改真代码，断言的只是"我抄的那份对不对"。

⇒ 补法有两条，缺一不可：
- `build.mjs` 打包真 `utils/index.ts`（`run.sh` 里预先打好 —— 在 Electron 主进程里
  `execFileSync(node …)` 会撞 `EBUSY`）
- **每个分支都要有一条直接调用的断言**（T8 那组）。经事件派发的那些断言不够：
  `key()` 往 `activeElement` 派发，target 恒为 body ⇒ 少写两个节点也照样全绿。

**判据效力已验**：回退真源码（去掉 `document`/`window` 两节点）⇒ **21 PASS / 2 FAIL**；
恢复 ⇒ 23/0。

## 环境坑（照抄 `header-width/run.cjs`，那里注释更全）

1. `env -u ELECTRON_RUN_AS_NODE` 不能省（设空串没用）
2. 独立 userData + 禁 GPU
3. `show:false` 要配 `offscreen` + 关后台节流
4. 别急着 `win.destroy()`
