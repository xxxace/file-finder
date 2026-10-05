# 可视化规则编写器 · P3.1 实施计划

> **给执行者**：按 Task 顺序逐条做，每条做完就跑验证命令。本计划使用项目的**验证三件套**（`typecheck` + `docs/probes/` 只读探针 + 真机目视），**不写 TDD 式假测试**（本项目无测试框架）。
> 规格来源：`docs/DESIGN-RULE-BUILDER-2026-10-05.md`（v1，已批准）。

**目标**：让用户能在界面上**新增/编辑站点规则并试跑通过**；后端支持**动作序列（输入/点击/等待）**——即 P3.1 结束时应能"手填一条规则抓通一个新站"。

**架构**：三段式（入口 / 动作 / 抽取）。动作与抽取**分两条通道**：抽取幂等可重试，动作有副作用只能执行一次。
前端新增一个独立面板（**不动**既有 `AssistantCoverModal.vue` 的结构）；后端在既有 `rules.ts` / `siteFetch.ts` / `assistant/index.ts` 上做加法。

**技术栈**：Electron 44 + Vue 3 + TS + naive-ui；抓取全程 Chromium 隐藏窗（`persist:assistant`）；零新依赖。

---

## 文件结构（锁定的边界）

| 文件 | 职责 | 动作 |
|---|---|---|
| `electron/server/assistant/rules.ts` | 规则模型 + `buildStepScript()` 纯函数 | 改（加类型 + 一个纯函数） |
| `electron/server/assistant/siteFetch.ts` | 窗口与网络栈；新增 `runSteps()` | 改（追加，不动 `runExtract`/`passChallenge`） |
| `electron/server/assistant/index.ts` | 路由；`dryrun` 增强 | 改（就地增强，保持向后兼容） |
| `src/views/FileFinder/AssistantRulesModal.vue` | 四步向导面板 | **新建** |
| `src/views/FileFinder/index.vue` | 面板入口按钮 | 改（加一个入口，不动其它） |
| `docs/probes/rule-builder/probe.cjs` + `out.txt` | 纯函数探针 | **新建** |

**不做（本轮）**：录制动作、点选图片、反推模板（全部 P3.2）；JSON 高级编辑；列表页批量。

---

## Task 1：数据模型扩展（类型）

**Files:** Modify `electron/server/assistant/rules.ts:17-66`

- [ ] **Step 1：加类型与两个可选字段**

在 `QueryTransform` 定义之后、`SiteRule` 之前插入：

```ts
/** 动作序列的一步。⚠️ 有副作用：每步**只执行一次**（与幂等的抽取不同） */
export type ActionStep =
    | { act: 'type'; selector: string; value: string }   // value 支持 {q}
    | { act: 'click'; selector: string }
    | { act: 'wait'; selector?: string; ms?: number };
```

在 `SiteFields` 里加一行（保持其余不动）：

```ts
export interface SiteFields {
    cover?: FieldRule;
    title?: FieldRule;
    actress?: FieldRule;
    actressLink?: FieldRule;
    /** 一组图（剧照/多图）；pickAll=true 时取容器内全部 img */
    images?: FieldRule & { pickAll?: boolean };
}
```

在 `SiteRule` 里加一行：

```ts
    /** 动作序列（可空）。缺省 = 行为与现在完全一致 */
    steps?: ActionStep[];
```

- [ ] **Step 2：验证类型没坏**

Run: `npm run typecheck`
Expected: exit 0（不新增任何 error）

---

## Task 2：`buildStepScript()` 纯函数 + 探针

**Files:** Modify `electron/server/assistant/rules.ts`（追加到 `applyQueryTransform` 之后）；Create `docs/probes/rule-builder/probe.cjs`

设计要点（**为什么是单步而不是整串**）：点击可能触发整页导航 ⇒ 脚本上下文被销毁 ⇒ 整串脚本的 Promise 永不 resolve。
所以**每一步单独一次 `executeJavaScript`**；导航打断那一步的脚本时，由 `runSteps`（Task 3）按"已执行"处理。

- [ ] **Step 1：写函数**

```ts
/**
 * 生成**单步**动作脚本（页面内执行，返回 Promise<{ok, why}>）。
 * ⚠️ 与 `buildExtractScript` 的关键区别：抽取幂等、可以反复重试；
 * 动作有副作用，**每一步只允许执行一次** —— 不要把它塞进 `runExtract` 的轮询循环。
 */
export function buildStepScript(step: ActionStep, query = ''): string {
    const q = JSON.stringify(query);
    if (step.act === 'type') {
        const sel = JSON.stringify(step.selector);
        const val = JSON.stringify((step.value || '').replace(/\{q\}/g, query));
        return `(function(){
          var el = document.querySelector(${sel});
          if(!el) return { ok:false, why:'not-found' };
          try { el.focus(); } catch(e){}
          try {
            var d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
            if (d && d.set) d.set.call(el, ${val}); else el.value = ${val};
          } catch(e){ el.value = ${val}; }
          try {
            el.dispatchEvent(new Event('input', { bubbles:true }));
            el.dispatchEvent(new Event('change', { bubbles:true }));
          } catch(e){}
          return { ok:true };
        })()`;
    }
    if (step.act === 'click') {
        const sel = JSON.stringify(step.selector);
        return `(function(){
          var el = document.querySelector(${sel});
          if(!el) return { ok:false, why:'not-found' };
          try { el.click(); } catch(e){}
          return { ok:true, clicked:'${'${'}true}' };
        })()`;
    }
    // wait
    const sel = step.selector ? JSON.stringify(step.selector) : 'null';
    const ms = Number(step.ms) > 0 ? Number(step.ms) : 8000;
    return `(async function(){
      var SEL = ${sel}, MS = ${ms};
      if(!SEL){ await new Promise(r=>setTimeout(r, MS)); return { ok:true }; }
      var t0 = Date.now();
      while (Date.now() - t0 < MS) {
        if (document.querySelector(SEL)) return { ok:true };
        await new Promise(r=>setTimeout(r, 200));
      }
      return { ok:false, why:'timeout' };
    })()`;
}
```

> ⚠️ 上面 click 分支里那行刻意写成 `'${'${'}true}'` 是为了避免模板串误插值 —— 实现时**直接写 `return { ok:true }`** 即可，不要带 `clicked` 字段。

- [ ] **Step 2：写探针（纯函数，不需要 GUI）**

Create `docs/probes/rule-builder/probe.cjs`：

```js
/** 规则编写器 P3.1 · 纯函数探针（只读，不碰用户数据） */
const path = require('path'), os = require('os'), fs = require('fs');
const { execFileSync } = require('child_process');
const PROBE = __dirname;
const OUT = path.join(PROBE, 'out.txt');

const esbuild = path.join('D:/code/file-finder/node_modules/.bin/esbuild');
const bundle = path.join(os.tmpdir(), `ff-rule-builder-${Date.now()}.cjs`);
execFileSync(esbuild, [
    'D:/code/file-finder/electron/server/assistant/rules.ts',
    '--bundle', '--platform=node', '--format=cjs',
    `--outfile=${bundle}`, '--external:electron', '--log-level=error',
], { stdio: 'inherit' });

const { buildStepScript } = require(bundle);
const lines = [];
const t = (name, cond) => lines.push(`${cond ? 'PASS' : 'FAIL'}  ${name}`);

// 1. type：{q} 被替换成真实查询词
const s1 = buildStepScript({ act: 'type', selector: '#kw', value: '{q}' }, 'ABP-123');
t('type：{q} 替换为真实查询词', s1.includes('"ABP-123"'));
t('type：不再残留 {q} 占位', !s1.includes('{q}'));

// 2. type：值里的引号/反斜杠被安全转义（防注入/防语法错）
const evil = '"\\\n;</script>';
const s2 = buildStepScript({ act: 'type', selector: '#kw', value: '{q}' }, evil);
t('type：特殊字符安全转义', !/\n/.test(s2.split('d.set.call(el, ')[1]?.split(')')[0] || ''));

// 3. type：用 native setter 触发（兼容 React/Vue 受控输入）
t('type：用 prototype 上的 value setter', s2.includes('Object.getOwnPropertyDescriptor'));

// 4. click：生成 el.click()
const s3 = buildStepScript({ act: 'click', selector: '.btn' }, '');
t('click：调用 el.click()', s3.includes('.click()') && s3.includes('".btn"'));

// 5. wait（等元素）：带轮询与超时
const s4 = buildStepScript({ act: 'wait', selector: '#result', ms: 5000 }, '');
t('wait(selector)：轮询 + 超时', s4.includes('#result') && s4.includes('5000') && s4.includes('timeout'));

// 6. wait（等时长）：无 selector 时只睡
const s5 = buildStepScript({ act: 'wait', ms: 300 }, '');
t('wait(ms)：无选择器时纯等待', s5.includes('300') && !s5.includes('querySelector'));

// 7. 脚本语法正确（能被 Function 构造器解析）
let syntaxOk = true;
for (const s of [s1, s2, s3, s4, s5]) { try { new Function('return ' + s); } catch { syntaxOk = false; } }
t('全部脚本语法可解析', syntaxOk);

fs.writeFileSync(OUT, lines.join('\n') + `\n\n生成脚本样例（type）:\n${s1}\n`, 'utf8');
console.log(lines.join('\n'));
console.log(`\n${lines.filter(l => l.startsWith('PASS')).length}/${lines.length} PASS`);
fs.rmSync(bundle, { force: true });
process.exit(lines.some(l => l.startsWith('FAIL')) ? 1 : 0);
```

- [ ] **Step 3：跑探针**

Run: `node docs/probes/rule-builder/probe.cjs`
Expected: `7/7 PASS`，且 `docs/probes/rule-builder/out.txt` 生成（**证据必须是 `.txt`**）

- [ ] **Step 4：提交**（⚠️ 提交前按 MEMORY §三.7 扫脱敏三样 + `git status --porcelain -uall`；**未经主人同意不提交**）

---

## Task 3：`runSteps()` —— 动作通道（含 `_blank` 接管）

**Files:** Modify `electron/server/assistant/siteFetch.ts`（追加到文件末尾）

- [ ] **Step 1：加实现**

```ts
export interface StepOutcome { index: number; act: string; ok: boolean; why?: string }
export interface StepsResult {
    ok: boolean;
    cf: boolean;
    err?: 'cloudflare' | 'timeout' | 'aborted';
    steps: StepOutcome[];
    data?: unknown;
    httpStatus?: number;
    pageTitle?: string;
}

/**
 * 执行「动作序列 → 抽取」。与 runExtract 的分工：
 *   runExtract：幂等抽取，**轮询**直到抽到。
 *   runSteps  ：动作**每步只跑一次**；跑完再跑一次（可重试的）抽取。
 *
 * ⚠️ `_blank` 接管：站点常把搜索结果用新窗口打开。不接管的话
 *   ① 会开出一个没登记的窗口（`window-all-closed` 永不触发、应用关不掉）；
 *   ② 当前窗停在列表页 ⇒ 抽到列表页而不是详情页。
 *   所以 deny + 同窗导航。
 */
export async function runSteps(
    url: string,
    stepScripts: string[],
    extractScript: string,
    opts: RunExtractOptions = {},
): Promise<StepsResult> {
    const { timeoutMs = POLL_TIMEOUT, signal } = opts;
    const win = new BrowserWindow({
        show: false,
        webPreferences: { partition: PARTITION, nodeIntegration: false, contextIsolation: true, sandbox: true },
    });
    trackWindow(win);

    let httpStatus = 0;
    win.webContents.on('did-navigate', (_e, _u, code) => { if (code) httpStatus = code; });
    win.webContents.setWindowOpenHandler(({ url: target }) => {
        if (/^https?:/i.test(target)) void win.loadURL(target);
        return { action: 'deny' };
    });

    const onAbort = () => { try { if (!win.isDestroyed()) win.destroy(); } catch { /* ignore */ } };
    signal?.addEventListener('abort', onAbort, { once: true });
    const aborted: StepsResult = { ok: false, cf: false, err: 'aborted', steps: [] };

    const steps: StepOutcome[] = [];
    try {
        if (signal?.aborted) return aborted;
        win.webContents.setUserAgent(CHROME_UA);
        await Promise.race([win.loadURL(url).catch(() => undefined), sleep(NAV_TIMEOUT, signal).catch(() => undefined)]);

        // 等脱离 CF 挑战
        const cfDeadline = Date.now() + timeoutMs;
        let lastCf = false;
        while (Date.now() < cfDeadline) {
            if (signal?.aborted || win.isDestroyed()) return aborted;
            try { lastCf = !!(await win.webContents.executeJavaScript(CF_DETECT)).cf; } catch { lastCf = true; }
            if (!lastCf) break;
            await sleep(POLL_INTERVAL, signal);
        }
        if (lastCf) return { ok: false, cf: true, err: 'cloudflare', steps };

        // 逐步执行：每步只一次
        for (let i = 0; i < stepScripts.length; i++) {
            if (signal?.aborted || win.isDestroyed()) return aborted;
            let r: { ok?: boolean; why?: string } | undefined;
            try {
                r = (await win.webContents.executeJavaScript(stepScripts[i])) as { ok?: boolean; why?: string };
            } catch {
                // 点完跳走了 ⇒ 脚本上下文被销毁 —— 视为"已执行"（导航本身就是预期结果）
                r = { ok: true, why: 'navigated' };
            }
            const rec: StepOutcome = { index: i, act: '', ok: r?.ok !== false, why: r?.why };
            steps.push(rec);
            if (!rec.ok) return { ok: false, cf: false, err: 'timeout', steps, httpStatus };
            // 点击后给导航留出稳定时间（最多 8s；URL 变了就继续）
            await sleep(600, signal);
        }

        // 抽取（幂等 ⇒ 可重试）
        let data: unknown;
        let ok = false;
        const exDeadline = Date.now() + timeoutMs;
        while (Date.now() < exDeadline) {
            if (signal?.aborted || win.isDestroyed()) return aborted;
            try { data = await win.webContents.executeJavaScript(extractScript); } catch { data = undefined; }
            if (data) { ok = true; break; }
            await sleep(POLL_INTERVAL, signal);
        }
        let title = '';
        try { title = win.webContents.getTitle(); } catch { /* ignore */ }
        return { ok, cf: false, steps, data, httpStatus, pageTitle: title };
    } catch {
        return signal?.aborted ? aborted : { ok: false, cf: false, err: 'timeout', steps };
    } finally {
        signal?.removeEventListener('abort', onAbort);
        untrackWindow(win);
        try { if (!win.isDestroyed()) win.destroy(); } catch { /* ignore */ }
    }
}
```

- [ ] **Step 2：`act` 字段回填**

`stepScripts` 只有脚本、没有动作名 ⇒ 再加一个并行入参把动作名传进来，或在调用方（`index.ts`）拼装 `steps[i].act`。
实现时把签名改成：

```ts
export async function runSteps(
    url: string,
    planned: { act: string; script: string }[],
    extractScript: string,
    opts: RunExtractOptions = {},
): Promise<StepsResult>
```
循环里用 `planned[i].script`，记录 `act: planned[i].act`。

- [ ] **Step 3：验证编译**

Run: `npm run typecheck`
Expected: exit 0

---

## Task 4：`dryrun` 增强（支持草稿规则 + 三段式回显）

**Files:** Modify `electron/server/assistant/index.ts:78-100`

- [ ] **Step 1：让 `dryrun` 接受草稿规则**

`req.body` 现在只读 `{ siteId, query }`。改成：**有 `rule` 就用 `rule`（草稿），否则按 `siteId` 查已存规则**（向后兼容，不破坏 PRD §15 里那条自测命令）。

```ts
const body = (req.body || {}) as { siteId?: string; query?: string; rule?: SiteRule };
const draft = body.rule;
const rule = draft ?? (await loadRules(dataDir)).find(r => r.id === body.siteId);
```

- [ ] **Step 2：走对通道并回三段信息**

```ts
const steps = rule.steps ?? [];
let result;
if (steps.length) {
    const planned = steps.map(s => ({ act: s.act, script: buildStepScript(s, q) }));
    result = await runSteps(url, planned, buildExtractScript(rule.fields));
} else {
    const r = await runExtract<ExtractedFields>(url, buildExtractScript(rule.fields));
    result = { ...r, steps: [] as StepOutcome[], httpStatus: 0, pageTitle: '' };
}
sendJson(res, {
    code: 200, url,
    ok: result.ok, cf: result.cf, err: result.err ?? null,
    fields: result.data ?? null,
    steps: result.steps,
    httpStatus: result.httpStatus ?? 0,
    pageTitle: result.pageTitle ?? '',
});
```

- [ ] **Step 3：保存校验（软）**

在 `upsertRule`（`index.ts:59-66`）里加：

```ts
if (!/^https?:\/\//i.test(rule.detailUrl)) { sendJson(res, { code:400, error:'detailUrl 必须是 http(s) 地址' }); return; }
for (const s of rule.steps ?? []) {
    if (s.act !== 'wait' && !s.selector) { sendJson(res, { code:400, error:'动作步骤缺少 selector' }); return; }
}
```

- [ ] **Step 4：验证**

Run: `npm run typecheck` → exit 0
Run: `curl` 不适用（需 token）⇒ 走**真机步骤**（Task 6）。

---

## Task 5：前端四步向导（新组件，不动既有组件）

**Files:** Create `src/views/FileFinder/AssistantRulesModal.vue`；Modify `src/views/FileFinder/index.vue`（只加入口）

- [ ] **Step 1：新建面板组件**

要求（**只列硬要求，代码按既有 `AssistantCoverModal.vue` 的写法照搬**：全屏 `n-modal` + `postAction/getAction` + `apiUrl(API_BASE + '/assistant/...')`）：

1. 左栏列表：已有规则（`GET /assistant/rules`），点选进入编辑；顶部「新建站点」。
2. 表单四段（`n-form`）：
   - ① `name` / `detailUrl`（占位提示 `https://站点/{q}`）/ `queryTransform`（下拉：无 / 去掉横杠 / 转小写）
   - ② `steps` 列表：每行「动作下拉（输入/点击/等待）+ 选择器输入 + 值输入（仅"输入"）+ ↑↓ + 删除」+「添加一步」
   - ③ `fields.cover.candidates` 列表：每行「类型（css/meta/regex）+ 选择器 + 属性」+ 增删调序（图片高级模式，默认收起）
   - ④ 试跑：测试番号输入 + 「试跑」按钮 + 三段式回显（页面状态/每步结果/命中值）
3. 保存按钮：**最近一次试跑的 `ok===true` 且封面有命中值**才可用（AC-7）；否则禁用并提示"先试跑通过"。
4. 试跑调用：`POST /assistant/dryrun`，body = `{ rule: <草稿>, query: <测试番号> }`。
5. 保存调用：`POST /assistant/rules`，body = 规则对象；成功提示"已保存（规则即时生效，无需重启）"。

- [ ] **Step 2：`index.vue` 加一个入口**

在现有助手入口旁加一个按钮「站点规则」，`@click` 打开上面的组件。**只加这一个按钮 + 一个 import**，不动其它任何逻辑。

- [ ] **Step 3：验证**

Run: `npm run typecheck` → exit 0
Run: `npm run dev`（**改了主进程 ⇒ 必须重启 dev**）
Expected: 界面能打开面板、能列出 5 条规则

---

## Task 6：真机验收（主人执行，我判读）

- [ ] **Step 1**：打开「站点规则」面板 → 试跑 **javbus** + 测试番号 → 期望：`ok:true`、封面命中 `https://www.javbus.com/pics/cover/*.jpg`
- [ ] **Step 2**：把 **javdock** 的 `enabled` 打开 → 保存 → 去「找封面」扫描 → 期望它参与抓取
- [ ] **Step 3**：**新增**一个站（例如 javwine）：填入口 → 手填封面选择器 → 试跑 → 保存 → 抓一次 → 看封面落盘
- [ ] **Step 4**：断点验证 `_blank` 接管：找一个搜索结果用新窗口打开的站，录/填「点结果」动作，期望不弹新窗口、最终抽到详情页

---

## 验证方式汇总（本项目无测试框架）

- `npm run typecheck` exit 0
- `node docs/probes/rule-builder/probe.cjs` → 7/7 PASS（证据 `.txt`）
- 真机目视（Task 6）；⚠️ **窗口相关逻辑探针跑不了**（无 GUI），只能真机验

## 风险（执行时盯住）

1. 动作**每步只执行一次** —— 别复用到 `runExtract` 的轮询里
2. `_blank` 必须接管（Task 3 Step 1）
3. 每个新窗口都 `trackWindow`
4. 拾取器/录制（P3.2）暂不做，**本轮不引入**它们的复杂度
5. 只写 `rules.json`（系统盘）⇒ 零读盘
6. 提交前扫脱敏三样 + `git status --porcelain -uall`
