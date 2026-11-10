/**
 * 探针 · 导航历史模型（真源码 `src/views/FileFinder/useNavStack.ts`，先打印后断言）
 * 一行复跑：`node docs/probes/nav-stack/model.mjs`
 *
 * 验的是**这次重构的核心不变量**：
 *   ① 后退 / 前进都只移动游标，任何一屏都不被销毁；
 *   ② 越界（连按到底 / 尾巴尽头）**什么都不做**，不改 index；
 *   ③ 快照写在「**离开的那一屏**」身上，不是写在要去的哪一屏；
 *   ④ 在中间位置进新屏 ⇒ 砍掉游标右边的尾巴（浏览器语义）。
 *
 * ⚠️ 零读盘：只喂假路径，不碰任何盘。
 * ⚠️ 证据落 `out.txt`（`.gitignore` 有 `*.log`，写 .log 进不了仓库）。
 * ⚠️ `vue` 走 external：Node 里能直接跑 ref / computed（已实测），不必打进 bundle。
 */
import * as esbuild from 'esbuild';
import path from 'node:path';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
/**
 * 产物必须落在**仓内**（node_modules/.cache 里）：`useNavStack.ts` 运行期 import 'vue'，
 * 而 `os.tmpdir()` 不在 node_modules 的解析链上 ⇒ 会 ERR_MODULE_NOT_FOUND。
 */
const outDir = path.join(repo, 'node_modules/.cache/ff-nav-stack-probe');
mkdirSync(outDir, { recursive: true });
const outfile = path.join(outDir, 'useNavStack.mjs');

await esbuild.build({
    entryPoints: [path.join(repo, 'src/views/FileFinder/useNavStack.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile,
    external: ['vue'],
    logLevel: 'silent',
});

const { useNavStack } = await import(pathToFileURL(outfile).href);

/* ── 断言记录：先记后写，失败也留证据 ─────────────────────────────── */
const lines = [];
const log = (s) => { lines.push(s); console.log(s); };
let n = 0;
const ok = (title, fn) => { fn(); n++; log(`PASS  ${title}`); };

const E = (p) => ({ path: p, mode: 'cover', searchText: '', scrollY: 0, cursorKey: '' });
const SNAP = { scrollY: 10, searchText: 's', cursorKey: 'k' };

try {
    /* ── ① 空栈 = 还没选文件夹 ─────────────────────────────────── */
    const nav = useNavStack({ snapshot: () => SNAP });
    ok('空栈：current 为 undefined', () => assert.equal(nav.current.value, undefined));
    ok('空栈：hasAny / canBack / canForward 全 false', () => {
        assert.equal(nav.hasAny.value, false);
        assert.equal(nav.canBack.value, false);
        assert.equal(nav.canForward.value, false);
    });

    /* ── ② 压三屏 ───────────────────────────────────────────── */
    nav.push(E('A')); nav.push(E('B')); nav.push(E('C'));
    ok('push 三屏：当前是最后一屏 C', () => assert.equal(nav.current.value.path, 'C'));
    ok('push 后 canBack=true / canForward=false', () => {
        assert.equal(nav.canBack.value, true);
        assert.equal(nav.canForward.value, false);
    });

    /* ── ③ 后退到底，越界不改 index ──────────────────────────── */
    ok('step(-1) 两次回到 A', () => {
        assert.equal(nav.step(-1).path, 'B');
        assert.equal(nav.step(-1).path, 'A');
    });
    ok('A 处再 step(-1) 返回 undefined（越界）', () => assert.equal(nav.step(-1), undefined));
    ok('越界后当前屏仍是 A（index 没被压坏）', () => assert.equal(nav.current.value.path, 'A'));

    /* ── ④ 前进回尾巴尽头 ───────────────────────────────────── */
    ok('step(1) 两次回到 C', () => {
        assert.equal(nav.step(1).path, 'B');
        assert.equal(nav.step(1).path, 'C');
    });
    ok('C 处 step(1) 返回 undefined（尾巴尽头）', () => assert.equal(nav.step(1), undefined));

    /* ── ⑤ 中间位置进新屏 ⇒ 砍尾巴 ──────────────────────────── */
    nav.step(-1);                       // 离开 C，回 B
    nav.step(-1);                       // 离开 B，回 A
    nav.push(E('X'));
    ok('在 A 处 push X 后当前是 X', () => assert.equal(nav.current.value.path, 'X'));
    ok('截断：canForward 立刻变 false', () => assert.equal(nav.canForward.value, false));
    ok('截断：step(1) 落到 undefined（B / C 真的没了）', () => assert.equal(nav.step(1), undefined));
    ok('截断：A 仍在（step(-1) 回到 A）', () => assert.equal(nav.step(-1).path, 'A'));

    /* ── ⑥ 替换当前屏（换盘降级 swapTop）────────────────────── */
    nav.replaceCurrent({ path: 'A2' });
    ok('replaceCurrent 改 path 且不新增历史', () => {
        assert.equal(nav.current.value.path, 'A2');
        assert.equal(nav.canBack.value, false);      // A 是游标位置 ⇒ 没有更早的
        assert.equal(nav.canForward.value, true);    // X 仍在尾巴里 ⇒ 前进还能到它
    });

    /* ── ⑦ reset ────────────────────────────────────────────── */
    nav.reset();
    ok('reset 后回到空栈', () => {
        assert.equal(nav.hasAny.value, false);
        assert.equal(nav.current.value, undefined);
    });

    /* ── ⑧ 快照写在「离开的那一屏」身上 ─────────────────────── */
    const nav2 = useNavStack({ snapshot: () => SNAP });
    nav2.push(E('P')); nav2.markShown();        // P 的数据落地了（页面在 loadScreen 成功后调）
    nav2.push(E('Q'));                          // 离开 P
    nav2.markShown();                           // Q 也落地了
    nav2.step(-1);                              // 离开 Q，去 P
    ok('离开 Q 后：P 是当前，Q 在前进尾巴里', () => {
        assert.equal(nav2.current.value.path, 'P');
        assert.equal(nav2.canForward.value, true);
    });
    ok('离开 Q 那一刻的快照记在 Q 上（不是记在 P 上）', () => {
        nav2.step(1);
        assert.equal(nav2.current.value.path, 'Q');
        assert.equal(nav2.current.value.scrollY, 10);
        assert.equal(nav2.current.value.searchText, 's');
        assert.equal(nav2.current.value.cursorKey, 'k');
    });

    /* ── ⑨ 连按两次后退：中间那屏还没画上去 ⇒ 不许把上一屏的值记到它头上 ──
       这是 code review 抓到的真问题：取数要等（视频抽帧以秒计），
       画面还停在旧屏时给中间屏拍快照 ⇒ 以后前进回来停错高度。
       ⚠️ 每屏给**不同的**滚动位，否则"记没记错"根本看不出来（§⑧ 那个常量 SNAP 就分辨不了）。 */
    let live = 0;                                   // = 画面上那一屏的滚动位
    const nav3 = useNavStack({ snapshot: () => ({ scrollY: live, searchText: '', cursorKey: '' }) });
    nav3.push(E('A')); live = 100; nav3.markShown();     // A 显示过，滚到 100
    nav3.push(E('B'));                                   // 离开 A ⇒ A 记 100
    live = 200; nav3.markShown();                        // B 显示过，滚到 200
    nav3.push(E('C'));                                   // 离开 B ⇒ B 记 200
    live = 300; nav3.markShown();                        // C 显示过，滚到 300
    nav3.step(-1);                                       // 离开 C ⇒ C 记 300
    nav3.step(-1);                                       // B 还没画上去 ⇒ **不许**把 300 记到 B
    ok('连按两次后退：B 仍是 200，不是 C 的 300', () => {
        assert.equal(nav3.current.value.path, 'A');
        nav3.step(1);                                    // 前进回 B
        assert.equal(nav3.current.value.path, 'B');
        assert.equal(nav3.current.value.scrollY, 200);
    });
    ok('C 仍记着自己离开时的 300（它真的显示过）', () => {
        nav3.step(1);                                    // 前进回 C
        assert.equal(nav3.current.value.scrollY, 300);
    });

    log(`\nPASS  全部 ${n} 条断言通过`);
} catch (err) {
    log(`\nFAIL  ${n} 条通过后失败：${err?.message ?? err}`);
    writeFileSync(path.join(here, 'out.txt'), lines.join('\n') + '\n');
    process.exit(1);
}

writeFileSync(path.join(here, 'out.txt'), lines.join('\n') + '\n');
