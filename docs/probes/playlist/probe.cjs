/**
 * 清单（收藏分类）· 纯函数 + 存储层探针（只读）
 * ---------------------------------------------------------------------------
 * 只测纯函数与存储层：路由工厂导出的 dirOfItem/keyOfItem/wireItem/deriveIdentity/
 * pickCovers、binStore 的图片名↔指纹、playlistStore 的 CRUD。
 * 不需要 GUI、不触发任何路由 ⇒ 不调 getDrives()、不 stat 盘符、不碰移动硬盘。
 * 产物落同目录 `out.txt`（证据必须是 .txt —— .gitignore 挡 *.log）。
 * 跑法：node docs/probes/playlist/probe.cjs
 *
 * ⚠️ 打包的是**真源码**（同 docs/probes/rule-builder/probe.cjs 的纪律）：
 * 断言的东西必须和线上是同一份代码，不许手抄进探针。
 */
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFileSync } = require('child_process');

const PROBE = __dirname;
const ROOT = path.resolve(PROBE, '../../..');
const OUT = path.join(PROBE, 'out.txt');
const ESBUILD = path.join(ROOT, 'node_modules', 'esbuild', 'bin', 'esbuild');

function bundle(rel) {
    const out = path.join(os.tmpdir(), `ff-${path.basename(rel, '.ts')}-${process.pid}.cjs`);
    execFileSync(process.execPath, [
        ESBUILD, path.join(ROOT, rel),
        '--bundle', '--platform=node', '--format=cjs',
        `--outfile=${out}`, '--external:electron', '--log-level=error',
    ], { stdio: 'inherit' });
    return out;
}

const PL = require(bundle('electron/server/playlist.ts'));
const PLSTORE = require(bundle('electron/server/playlistStore.ts'));
const BIN = require(bundle('electron/utils/binStore.ts'));

const lines = [];
let pass = 0;
let fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; lines.push(`PASS  ${name}`); }
    else { fail++; lines.push(`FAIL  ${name}${detail ? '  —— ' + detail : ''}`); }
}
function eq(name, actual, expected) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    check(name, a === e, `实际 ${a}，期望 ${e}`);
}

// ── ① 图片名 ↔ 指纹往返 ────────────────────────────────────────────────────
// 加入清单时前端只有图片名（sig 不在下发白名单）⇒ 服务端必须能逆运算回指纹
eq('① thumbNameOf(sig)', BIN.thumbNameOf('abc123'), 't-abc123.enc');
eq('① thumbNameOf(空)', BIN.thumbNameOf(undefined), undefined);
eq('① sigOfThumbName 往返', BIN.sigOfThumbName('t-abc123.enc'), 'abc123');
eq('① sigOfThumbName(空)', BIN.sigOfThumbName(undefined), undefined);
eq('① sigOfThumbName 拒垃圾', BIN.sigOfThumbName('garbage'), undefined);
eq('① sigOfThumbName 拒 p-（只要缩略图名）', BIN.sigOfThumbName('p-abc123.enc'), undefined);

// ── ② 身份推导（锚点分支） ─────────────────────────────────────────────────
// 锚点 = 离线盘的寻址方式：拔盘后盘符会变，序列号+盘内路径恒定
eq('② 锚点 → 身份', PL.deriveIdentity('#ABCD1234/影片/ABC-123'), { serial: 'ABCD1234', relPath: '影片/ABC-123' });
eq('② 锚点（盘根）', PL.deriveIdentity('#ABCD1234'), { serial: 'ABCD1234', relPath: '' });
eq('② 空序列号拒收', PL.deriveIdentity('#/影片'), null);
eq('② UNC 拒收', PL.deriveIdentity('\\\\server\\share\\x'), null);
// 盘符分支：探针环境里盘表为空 ⇒ serialOfDrive 返回 undefined ⇒ null。
// （真机上由 driveIdentity 的 lastSeenByDrive 供给 —— 那是扫盘时写的，探针不触发。）
eq('② 盘符分支（探针盘表空 ⇒ null，符合设计）', PL.deriveIdentity('H:/影片/ABC'), null);

// ── ③ 当前形态 key（dirOfItem / keyOfItem） ─────────────────────────────────
const item = (over) => ({
    id: 'it_1', serial: 'S1', relPath: '影片/ABC-123', name: 'ABC-123', ext: 'jpg',
    type: 'image', size: 1024, addedAt: 0, ...over,
});
eq('③ 在线 dir', PL.dirOfItem(item(), 'H'), 'H:/影片/ABC-123');
eq('③ 离线 dir', PL.dirOfItem(item(), ''), '#S1/影片/ABC-123');
// ⚠️ key 的身份是「dir/显示名」，**不加扩展名** —— 渲染层 keyOf 就是 `${item.dir}/${item.name}`。
//    加后缀曾让星标、选单 ✓、「从清单移除」全部静默失配（2026-10-21 真机报）。
eq('③ 在线 key', PL.keyOfItem(item(), 'H'), 'H:/影片/ABC-123/ABC-123');
eq('③ 离线 key', PL.keyOfItem(item(), ''), '#S1/影片/ABC-123/ABC-123');
// 回归护栏：key 必须与下发态同形（dir + '/' + name），与渲染层逐字一致才可能匹配
eq('③ key 与下发态同形', PL.keyOfItem(item(), 'H'), `${PL.dirOfItem(item(), 'H')}/${PL.wireItem(item(), 'H').name}`);
eq('③ 无 ext 不变形', PL.keyOfItem(item({ ext: undefined, name: 'README' }), 'H'), 'H:/影片/ABC-123/README');
// 离线 key 的目录段必须能 round-trip 回身份 —— 星标/✓ 的 key 是当前形态，
// 盘符变了之后旧 key 对不上，但锚点形态恒定 ⇒ 这条保证离线态永远认得出收录
const offlineKey = PL.keyOfItem(item(), '');
const offlineDir = offlineKey.slice(0, offlineKey.lastIndexOf('/'));
eq('③ 离线 key round-trip 回身份', PL.deriveIdentity(offlineDir), { serial: 'S1', relPath: '影片/ABC-123' });

// ── ④ 下发态装配 wireItem ──────────────────────────────────────────────────
// 同 wire() 的白名单规则：离线条目不带可生成的 preview（否则 = 白读一次盘）
const online = PL.wireItem(item({ sig: 'probee123' }), 'H');
check('④ 在线图片带可生成 preview', online.preview === 'p-probee123.enc' && online.previewReady === false);
check('④ 在线图片 thumb 不下发（bin 仓没有 ⇒ 免 404）', online.thumb === undefined);
const offline = PL.wireItem(item({ sig: 'probee123' }), '');
check('④ 离线图片**不带** preview（否则白读一次盘）', offline.preview === undefined && offline.previewReady === false);
const noSig = PL.wireItem(item({ sig: undefined }), 'H');
check('④ 无 sig 全空（没有图可显示）', noSig.thumb === undefined && noSig.preview === undefined);
const folder = PL.wireItem(item({ type: 'folder', ext: undefined, files: [{ name: 'a.mp4', size: 1 }] }), 'H');
check('④ 目录条目 isDirectory + files 快照带下去', folder.isDirectory === true && folder.files?.length === 1);

// ── ⑤ 拼格封面 pickCovers ─────────────────────────────────────────────────
// bin 仓没有的名字不下发（fake sig ⇒ 恒空；真机上 sig 取自扫盘快照，恒在仓里）
eq('⑤ 假 sig ⇒ 恒空（bin 仓没有就不下发）', PL.pickCovers([item({ sig: 'probee123' }), item({ id: 'it_2', sig: 'probee456' })]), []);
eq('⑤ 无 sig 条目不占位', PL.pickCovers([item({ sig: undefined })]), []);

// ── ⑥ 存储层 playlistStore（临时目录，不碰真数据） ──────────────────────────
// playlistStore 是 async API ⇒ CJS 里没有顶层 await，整段包 async IIFE
(async () => {
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-playlist-'));
const list = await PLSTORE.loadPlaylists(tmp);
eq('⑥ 首次加载 seeding「收藏」', list.map((p) => [p.name, p.system]), [['收藏', true]]);
check('⑥ seeding 已落盘', fs.existsSync(path.join(tmp, 'playlists.json')));

const created = await PLSTORE.createPlaylist(tmp, '测试单');
const afterCreate = JSON.parse(fs.readFileSync(path.join(tmp, 'playlists.json'), 'utf8'));
check('⑥ 新建落盘（2 条）', afterCreate.length === 2);
check('⑥ 新建返回带 id', typeof created.id === 'string' && created.id.length > 0);

check('⑥ 重命名成功', await PLSTORE.renamePlaylist(tmp, created.id, '改了名') === true);
check('⑥ 重命名落盘', JSON.parse(fs.readFileSync(path.join(tmp, 'playlists.json'), 'utf8'))
    .find((p) => p.id === created.id).name === '改了名');
check('⑥ 默认清单不可改名', await PLSTORE.renamePlaylist(tmp, list[0].id, 'X') === false);
check('⑥ 默认清单不可删', await PLSTORE.deletePlaylist(tmp, list[0].id) === false);

const entry0 = {
    id: 'it_x', serial: 'S1', relPath: '影片/ABC-123', name: 'ABC-123', ext: 'jpg',
    type: 'image', size: 2048, sig: 'probee123', files: [{ name: 'ABC-123.mp4', size: 99 }], addedAt: 1,
};
await PLSTORE.addItems(tmp, created.id, [entry0]);
const afterAdd = JSON.parse(fs.readFileSync(path.join(tmp, 'playlists.json'), 'utf8'))
    .find((p) => p.id === created.id);
check('⑥ 加入落盘（快照全字段）', afterAdd.items.length === 1
    && afterAdd.items[0].sig === 'probee123'
    && afterAdd.items[0].files[0].name === 'ABC-123.mp4'
    && afterAdd.items[0].serial === 'S1');
check('⑥ 按 id 移除', await PLSTORE.removeItemById(tmp, created.id, 'it_x') === true);
check('⑥ 移除落盘', JSON.parse(fs.readFileSync(path.join(tmp, 'playlists.json'), 'utf8'))
    .find((p) => p.id === created.id).items.length === 0);
check('⑥ 移除不存在的条目返回 false', await PLSTORE.removeItemById(tmp, created.id, 'nope') === false);
check('⑥ 删除自定义清单', await PLSTORE.deletePlaylist(tmp, created.id) === true);
check('⑥ 删除落盘', JSON.parse(fs.readFileSync(path.join(tmp, 'playlists.json'), 'utf8')).length === 1);

// 损坏回落：写垃圾 → 不抛、回落空 + 重新 seeding 默认清单
const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-playlist-bad-'));
fs.writeFileSync(path.join(tmp2, 'playlists.json'), '{ 这不是 JSON', 'utf8');
const recovered = await PLSTORE.loadPlaylists(tmp2);
eq('⑥ 损坏回落（空 + seeding 收藏）', recovered.map((p) => [p.name, p.system]), [['收藏', true]]);

fs.rmSync(tmp, { recursive: true, force: true });
fs.rmSync(tmp2, { recursive: true, force: true });
})().then(() => {
// ── 汇总 ──────────────────────────────────────────────────────────────────
lines.push('─────────────────────────────');
lines.push(`${pass} PASS / ${fail} FAIL`);
const text = lines.join('\n') + '\n';
fs.writeFileSync(OUT, text, 'utf8');
console.log(text);
process.exit(fail ? 1 : 0);
});
