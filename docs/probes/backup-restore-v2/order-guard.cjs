/**
 * 时序回归探针（2026-10-05）：验证「快照必须在 beginRestore() 之前」。
 *
 * 背景：修 P1 时引入快照 = exportCompactSnapshot，它内部过 assertUsable()。
 * 若在 beginRestore() 之后调用 ⇒ restoring=true ⇒ assertUsable 抛错 ⇒ 还原必然失败。
 *
 * 本探针用**真实 nedb.ts 的编译产物**验证闸门语义：
 *   1. restoring=false 时 exportSnapshotPlain 成功
 *   2. restoring=true 时 exportSnapshotPlain 抛 "缓存库正在还原"
 *   ⇒ 所以调用顺序只能是「先快照、后 beginRestore」。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const esbuild = require('esbuild');

let pass = 0, fail = 0;
const t = (n, c, d) => { c ? (pass++, console.log('  PASS  ' + n + (d ? ' — ' + d : ''))) : (fail++, console.log('  FAIL  ' + n + (d ? ' — ' + d : ''))); };

(async () => {
  // 打包真实 nedb.ts：只把 electron 留作外部（用桩替换），@seald-io/nedb / dayjs 直接 bundle 进来
  const out = path.join(os.tmpdir(), 'nedb-probe-' + Date.now() + '.cjs');
  await esbuild.build({
    entryPoints: [path.join(__dirname, '../../../electron/server/nedb.ts')],
    bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'silent',
    absWorkingDir: path.join(__dirname, '../../..'),
    external: ['electron'],
  });
  // dayjs / @seald-io/nedb 在项目 node_modules 里，可 require；electron 需桩
  const Module = require('module');
  const origResolve = Module._resolveFilename;
  Module._resolveFilename = function (req, ...rest) {
    if (req === 'electron') return path.join(os.tmpdir(), 'electron-stub.js');
    return origResolve.call(this, req, ...rest);
  };
  fs.writeFileSync(path.join(os.tmpdir(), 'electron-stub.js'), 'module.exports={app:{getPath:()=>require("os").tmpdir()}};');

  // 把库指到临时目录，避免动真库
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-home-'));
  process.env.USERPROFILE = tmpHome;
  fs.mkdirSync(path.join(tmpHome, '.file-finder', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(tmpHome, '.file-finder', 'searchCache.db'), '', 'utf8');

  const nedb = require(out);
  // 等库加载
  await new Promise(r => setTimeout(r, 300));

  // 写一条记录（走唯一写入链）
  await nedb.insertCache({ v: 3, serial: 'TEST0001', relPath: 'a', mode: 'cover', count: 0, data: [], create_at: '2026-10-05 00:00:00' });

  // 1) 闸门关着 → 快照应成功
  let ok1 = false, msg1 = '';
  try { const p = await nedb.exportSnapshotPlain(); ok1 = p.length > 0; msg1 = p.split('\n').filter(l => l.trim()).length + ' 行'; }
  catch (e) { msg1 = String(e.message); }
  t('restoring=false 时 exportSnapshotPlain 成功', ok1, msg1);

  // 2) 闸门打开 → 快照必须抛（证明顺序不能反）
  nedb.beginRestore();
  let threw = false, msg2 = '';
  try { await nedb.exportSnapshotPlain(); }
  catch (e) { threw = true; msg2 = String(e.message); }
  t('restoring=true 时 exportSnapshotPlain 抛错（顺序不能反）', threw, msg2);
  nedb.endRestore();

  // 3) 闸门关回 → 又能用了
  let ok3 = false;
  try { await nedb.exportSnapshotPlain(); ok3 = true; } catch { }
  t('endRestore 后恢复可用', ok3);

  fs.rmSync(tmpHome, { recursive: true, force: true });
  try { fs.unlinkSync(out); } catch { }
  console.log('\n===== ' + pass + ' PASS / ' + fail + ' FAIL =====');
  process.exit(fail ? 1 : 0);
})();
