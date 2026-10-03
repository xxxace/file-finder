/**
 * 探针 · 移动硬盘热插拔（1.1.0-Q2）
 * ==============================================================================
 *   bash docs/probes/hotplug/run.sh     ← 跑起来之后，**手动插/拔一次移动硬盘**
 *
 * 验什么：Electron 能不能用**系统事件**（而不是轮询）感知移动盘的插拔。
 *
 * 为什么必须真机跑：无头环境**插不了盘**，这个条件造不出来。
 *
 * 为什么要验（而不是照抄结论）：
 *   Electron 官方 issue #8190（2016）说：**Chromium 的 UI 框架会过滤掉
 *   `DBT_DEVICEARRIVAL`**，`hookWindowMessage(WM_DEVICECHANGE)` 实际只能拿到
 *   `DBT_DEVNODES_CHANGED`；官方标了 wontfix（"这是 Windows 的限制"）。
 *   ⚠️ 但那是 2016 年的结论，当前 Electron 4x 的行为**可能已经不同** ⇒ 只能实测。
 *
 * 对我们够不够：**够**。我们不需要它告诉我们"是哪个盘"
 * （有 `driveIdentity.scanDrives()`，实测 2 ms 就能列出所有盘和序列号），
 * 只需要它回答一个问题：**"变了没有？"**
 *
 * 一次定清两件事：
 *   A. hook 机制本身通不通 —— 用**我们自己触发的 `WM_SIZE`** 自证，
 *      把"没收到设备消息"和"机制压根没生效"分开（否则一条消息都没有时无法归因）
 *   B. 插/拔盘时到底收到哪个 wParam（`0x8000` / `0x8004` / `0x0007`）
 *
 * ⚠️ 输出**脱敏**：只打印盘的**数量**，不出现盘序列号 / 卷标 / 真实目录名。
 */
const path = require('node:path');
const os = require('node:os');

const WM_DEVICECHANGE = 0x0219;
const WM_SIZE = 0x0005;
const WM_MOVE = 0x0003;

const NAMES = {
    0x0007: 'DBT_DEVNODES_CHANGED —— 有设备加入/移除了系统',
    0x8000: 'DBT_DEVICEARRIVAL —— 设备或介质已插入  ★',
    0x8004: 'DBT_DEVICEREMOVECOMPLETE —— 设备或介质已移除  ★',
    0x8001: 'DBT_DEVICEQUERYREMOVE',
    0x8002: 'DBT_DEVICEQUERYREMOVEFAILED',
    0x8003: 'DBT_DEVICEREMOVEPENDING',
    0x8005: 'DBT_DEVICETYPESPECIFIC',
    0x8006: 'DBT_CUSTOMEVENT',
    0x0018: 'DBT_CONFIGCHANGED',
};

const t0 = Date.now();
const at = () => `${String(((Date.now() - t0) / 1000).toFixed(1)).padStart(6)}s`;

/** 用**真源码**里的盘枚举。`driveIdentity.ts` 只依赖 node:fs ⇒ 不需要 Electron 替身。 */
function buildScanDrives() {
    const esbuild = require('esbuild');
    const out = path.join(os.tmpdir(), 'ff-hotplug-drive.cjs');
    esbuild.buildSync({
        entryPoints: [path.join(__dirname, '../../../electron/utils/driveIdentity.ts')],
        bundle: true,
        format: 'cjs',
        platform: 'node',
        outfile: out,
        logLevel: 'silent',
    });
    return require(out).scanDrives;
}

const { app, BrowserWindow } = require('electron');

// 环境坑照抄 ../win-size/run.cjs（那边注释写了原因，这里复述关键一条）：
// **必须给独立 userData** —— 否则会和主人正在跑的 dev 实例抢同一个
// `GPUPersistentCache` 目录，症状是 GPU 进程反复崩、最后
// `FATAL: GPU process isn't usable. Goodbye.` 把整个进程带走（冒烟测试时实测踩到）。
app.setPath('userData', path.join(os.tmpdir(), 'probe-hotplug'));
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
    if (process.platform !== 'win32') {
        console.log('⚠️ 本探针只在 Windows 上有意义（WM_DEVICECHANGE 是 Windows 机制）');
        app.quit();
        return;
    }

    const scanDrives = buildScanDrives();
    const hits = [];
    let lastHitAt = 0;

    const win = new BrowserWindow({ width: 380, height: 150, show: true, title: '热插拔探针运行中' });
    win.loadURL(
        'data:text/html;charset=utf-8,' +
        encodeURIComponent(
            '<body style="font-family:sans-serif;padding:16px;font-size:14px;line-height:1.7">' +
            '热插拔探针运行中<br><b>请插 / 拔一次移动硬盘</b><br><span style="color:#888">看终端输出</span></body>',
        ),
    );

    // ── A. 自证：hook 一个**我们自己能触发**的消息 ─────────────────────────────
    // 少了这一步，一条消息都没收到时无法判断是"被 Chromium 过滤了"还是"hook 没生效"。
    let sizeSeen = 0;
    let moveSeen = 0;
    win.hookWindowMessage(WM_SIZE, () => { sizeSeen += 1; });
    win.hookWindowMessage(WM_MOVE, () => { moveSeen += 1; });

    // ── B. 主目标 ────────────────────────────────────────────────────────────
    win.hookWindowMessage(WM_DEVICECHANGE, (wParam, lParam) => {
        const code = wParam && wParam.length >= 4 ? wParam.readUInt32LE(0) : -1;
        const hex = code < 0 ? '(读不出)' : `0x${(code >>> 0).toString(16).padStart(4, '0')}`;
        console.log(`  ${at()}  ★ WM_DEVICECHANGE   wParam=${hex}   ${NAMES[code] ?? '(未列出的类型)'}`);
        hits.push(code);
        lastHitAt = Date.now();
        void after();
    });

    /** 每条设备消息之后复核一次盘列表（将来实现里就是这么用的） */
    const after = async () => {
        const n = (await scanDrives()).length;
        console.log(`  ${at()}     复核 scanDrives()：当前 ${n} 个盘（基线 ${baseline}）`);
    };

    let baseline = (await scanDrives()).length;

    console.log('==============================================================');
    console.log(`hookWindowMessage(0x0219) 已挂上：${win.isWindowMessageHooked(WM_DEVICECHANGE)}`);
    console.log(`盘符基线：当前检测到 ${baseline} 个可访问的盘`);
    console.log('==============================================================');
    console.log('');
    console.log('请现在 **插入** 移动硬盘（等系统认出来，1~3 秒），然后再 **拔出**。');
    console.log('（收到设备消息后 20 秒自动收尾；最多等 120 秒）');
    console.log('');

    // 触发 WM_SIZE / WM_MOVE
    const b = win.getBounds();
    win.setSize(b.width + 1, b.height);
    win.setSize(b.width, b.height);
    win.setPosition(b.x + 1, b.y + 1);
    win.setPosition(b.x, b.y);

    setTimeout(() => {
        const ok = sizeSeen > 0 || moveSeen > 0;
        console.log(ok
            ? `✅ 自证通过：hook 机制本身在工作（自己触发的 WM_SIZE/WM_MOVE 收到 ${sizeSeen}/${moveSeen} 次）`
            : '⚠️ 自证失败：连自己触发的 WM_SIZE 都收不到 ⇒ hook 机制本身没生效，'
              + '那么下面"没收到设备消息"只能说明机制问题，不能说明 Chromium 过滤。');
        console.log('');
    }, 1500);

    // `FF_PROBE_SECONDS` 只给冒烟测试用（验证脚本能起来、自证能过），默认跑满 120 秒
    const DEADLINE = (Number(process.env.FF_PROBE_SECONDS) || 120) * 1000;
    const started = Date.now();
    const timer = setInterval(() => {
        const left = Math.round((DEADLINE - (Date.now() - started)) / 1000);
        if (lastHitAt && Date.now() - lastHitAt > 20000) return finish();
        if (left <= 0) return finish();
        if (left % 30 === 0) console.log(`  ${at()}  …还在等（剩余 ${left}s）—— 插一次移动硬盘试试`);
    }, 1000);

    const finish = async () => {
        clearInterval(timer);
        const now = (await scanDrives()).length;
        const hasArrival = hits.includes(0x8000);
        const hasRemove = hits.includes(0x8004);
        const onlyDevnodes = hits.length > 0 && hits.every((c) => c === 0x0007);

        console.log('');
        console.log('========== 结论 ==========');
        console.log(`收到 WM_DEVICECHANGE 共 ${hits.length} 条；盘数 ${baseline} → ${now}`);
        if (hasArrival || hasRemove) {
            console.log('✅ 能拿到 0x8000 / 0x8004 ⇒ **事件驱动方案成立，不需要轮询**。');
        } else if (onlyDevnodes) {
            console.log('⚠️ 只收到 DBT_DEVNODES_CHANGED (0x0007) —— 正是 issue #8190 描述的行为。');
            console.log('   ⇒ 方案**仍然成立**（我们只要"变了没有"），但实现里必须在收到它之后');
            console.log('     再跑一次 scanDrives() 复核，不能指望消息直接告诉我们盘符。');
        } else if (hits.length === 0) {
            console.log('⚠️ 一条都没收到。对照上面那行自证：');
            console.log('   自证通过 ⇒ 是设备消息被过滤 / 或者盘没插上（再试一次）；');
            console.log('   自证失败 ⇒ hook 机制本身没生效，得换方案（退回按需轮询）。');
        }
        console.log('==========================');

        win.destroy();
        app.quit();
    };

    win.on('closed', () => app.quit());
});
