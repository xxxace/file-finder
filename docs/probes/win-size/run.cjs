/**
 * 主窗口「初始尺寸 / 最小尺寸」—— 在**真 Electron** 下量，不心算。
 *
 *   bash docs/probes/win-size/run.sh          # 输出写 out.txt
 *
 * 回答三件事：
 *   ① 这块屏的 `size` 与 `workAreaSize`（后者已扣掉任务栏）各是多少；
 *   ② `electron/main/index.ts` 里那两行 `Math.min(...)` **实际取到**什么值；
 *   ③ 取到的值是否落在可用区内、`minWidth/minHeight` 是否小于可用区
 *      —— `minWidth > 可用区宽` 的话，窗口连"缩到屏内"都做不到。
 *
 * 环境坑照抄 ../header-width/run.cjs（那里写全了）：
 *   `env -u ELECTRON_RUN_AS_NODE` 必须真删掉这个变量（设空串没用），
 *   否则 electron 退化成纯 Node、`screen` 根本拿不到显示器。
 *
 * 零读盘：不碰 searchCache.db、不 stat 任何盘；独立 userData，不干扰 dev 实例。
 */
const { app, screen } = require('electron');
const path = require('node:path');
const os = require('node:os');

app.setPath('userData', path.join(os.tmpdir(), 'probe-win-size'));
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');
app.disableHardwareAcceleration();

/** ⚠️ 这三个常量**抄自** electron/main/index.ts —— 改那边必须同步改这里，
 *  否则这份证据就变成了在证明另一个东西。 */
const BASE_W = 1280;
const BASE_H = 860;
const MIN_W = 1024;
const MIN_H = 640;
const EDGE = 40;   // 与主进程同：给标题栏/边框留的余量

app.whenReady().then(() => {
    const d = screen.getPrimaryDisplay();
    const wa = d.workAreaSize;
    const initW = Math.min(BASE_W, wa.width - EDGE);
    const initH = Math.min(BASE_H, wa.height - EDGE);

    console.log('── 这台机器的主显示器 ──');
    console.log(`分辨率      : ${d.size.width} × ${d.size.height}`);
    console.log(`可用区      : ${wa.width} × ${wa.height}   （已扣掉任务栏）`);
    console.log(`缩放系数    : ${d.scaleFactor}`);

    console.log('\n── 按 electron/main/index.ts 的公式算出的初始尺寸 ──');
    console.log(`基准        : ${BASE_W} × ${BASE_H}`);
    console.log(`实取        : ${initW} × ${initH}    （${initW === BASE_W ? '基准值，未触发小屏收窄' : '⚠️ 被可用区收窄'}）`);

    console.log('\n── 判据 ──');
    const checks = [
        [`初始宽 ${initW} ≤ 可用区宽 ${wa.width}`, initW <= wa.width],
        [`初始高 ${initH} ≤ 可用区高 ${wa.height}`, initH <= wa.height],
        [`初始宽 > minWidth ${MIN_W}（否则开局就顶在下限上）`, initW > MIN_W],
        [`初始高 > minHeight ${MIN_H}`, initH > MIN_H],
        [`minWidth ${MIN_W} ≤ 可用区宽 ${wa.width}（否则缩不到屏内）`, MIN_W <= wa.width],
        [`minHeight ${MIN_H} ≤ 可用区高 ${wa.height}`, MIN_H <= wa.height],
    ];
    let allOk = true;
    for (const [label, pass] of checks) {
        if (!pass) allOk = false;
        console.log(`  ${pass ? '✅' : '❌'} ${label}`);
    }
    console.log(allOk ? '\n✅ 初始尺寸与最小尺寸都落在可用区内' : '\n❌ 有不满足的项，见上');

    app.quit();
}).catch(e => {
    console.error('PROBE FAILED:', e && e.message ? e.message : e);
    app.exit(1);
});
