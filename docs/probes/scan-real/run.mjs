/**
 * 探针 · 用**真 scan.ts** 扫**真 searchCache.db**
 * ===========================================================================
 * 一行复跑：`node docs/probes/scan-real/run.mjs`
 *
 * 与 scan-rules（夹具）的分工：
 *   - scan-rules 验"规则对不对"（用例可枚举）
 *   - 这里验"**在真实数据上**算出来的是什么"（比例 / 形态 / 有没有我没预料到的类别）
 *
 * ⚠️ 零读盘：数据全来自缓存文档；解密只读。不启动 Electron。
 */
import * as esbuild from 'esbuild';
import path from 'node:path';
import os from 'node:os';
import { mkdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const stub = path.join(here, 'stub-real-nedb.mjs');
const outDir = path.join(os.tmpdir(), 'ff-scan-real');
mkdirSync(outDir, { recursive: true });
const outfile = path.join(outDir, 'scan.mjs');

await esbuild.build({
    entryPoints: [path.join(repo, 'electron/server/assistant/scan.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile,
    logLevel: 'silent',
    plugins: [
        {
            name: 'stub-nedb',
            setup(build) {
                build.onResolve({ filter: /^\.\.\/nedb$/ }, () => ({ path: stub }));
            },
        },
    ],
});

const { scanMissingCovers } = await import(pathToFileURL(outfile).href);
const { loadMeta, rawDocs } = await import(pathToFileURL(stub).href);

// ---------- 盘 ----------
const metas = await loadMeta();
const bySerial = new Map();
for (const m of metas) {
    const s = bySerial.get(m.serial) || { docs: 0, cover: 0 };
    s.docs += 1;
    if (m.mode === 'cover') s.cover += 1;
    bySerial.set(m.serial, s);
}
console.log('—— 缓存里的盘 ——');
for (const [serial, s] of bySerial) console.log(`  ${serial}: 文档 ${s.docs}（cover ${s.cover}）`);

const target = process.argv[2] || [...bySerial.keys()][0];
console.log(`\n扫描 ${target} 全盘（relPath=''）`);

const r = await scanMissingCovers(target, '');
console.log(
    `targets=${r.targets.length}  unmatched=${r.unmatched.length}  ` +
        `skippedCategory=${r.skippedCategory}  scannedDocs=${r.scannedDocs}`,
);

// ---------- unmatched 的真实构成 ----------
const isNum = n => /^\d+$/.test(n);
const num = r.unmatched.filter(u => isNum(u.name));
const other = r.unmatched.filter(u => !isNum(u.name));
console.log(`\nunmatched 构成：纯数字 ${num.length} / 其它 ${other.length}`);
const byLen = {};
for (const u of num) byLen[u.name.length] = (byLen[u.name.length] || 0) + 1;
console.log('纯数字的位数分布：', JSON.stringify(byLen));

// 按目录聚合纯数字条目
const perDir = new Map();
for (const u of num) perDir.set(u.dir, (perDir.get(u.dir) || 0) + 1);
console.log('纯数字条目按目录：');
for (const [d, c] of perDir) console.log(`  ${c.toString().padStart(3)} 条  ${d || '(盘根)'}`);

// ---------- 关键分类：unmatched 是"片子"还是"分组目录"？ ----------
// folder 条目 = 分组目录（演员名/分类名）→ 它不该出现在"缺封面"清单里；
// video 条目 = 真的是一部没封面的片子。
const docs = await rawDocs();
const docOf = new Map(docs.map(d => [`${d.serial}|${d.relPath}|${d.mode}`, d.data]));
function kindOf(u) {
    const d = docOf.get(`${target}|${u.dir}|cover`);
    const e = d && d.find(x => x.name === u.name);
    if (e) return e.type; // video / image / folder
    return '?(无对应条目)';
}
const comp = {};
for (const u of r.unmatched) {
    const k = `${kindOf(u)}${isNum(u.name) ? ' · 纯数字' : ''}`;
    comp[k] = (comp[k] || 0) + 1;
}
console.log('\nunmatched 按"它到底是什么"分类：');
for (const [k, c] of Object.entries(comp).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(c).padStart(3)} 条  ${k}`);
}

console.log('\n其它（非纯数字）unmatched 前 25 条：');
for (const u of other.slice(0, 25)) {
    console.log(`  [${kindOf(u)}] ${u.dir} / ${u.name}`);
}

// ---------- targets 全貌（验"目录名是番号时，里面的裸视频有没有被折进来"）----------
console.log(`\n—— targets（${r.targets.length}）——`);
for (const t of r.targets) {
    console.log(`  [${t.kind}] ${t.writeRel}   (name=${t.name}${t.hasVideo === undefined ? '' : `, hasVideo=${t.hasVideo}`})`);
}

// folder 类 unmatched 按"所在层"聚合 —— 看它们是不是都集中在某几层
const folderU = r.unmatched.filter(u => kindOf(u) === 'folder');
const perLayer = new Map();
for (const u of folderU) perLayer.set(u.dir || '(盘根)', (perLayer.get(u.dir || '(盘根)') || 0) + 1);
console.log(`\nfolder 类 unmatched（${folderU.length} 条）按所在层聚合：`);
for (const [d, c] of [...perLayer].sort((a, b) => b[1] - a[1])) {
    const sample = folderU.filter(u => (u.dir || '(盘根)') === d).slice(0, 6).map(u => u.name);
    console.log(`  ${String(c).padStart(3)} 条  ${d}   样例: ${sample.join(' / ')}`);
}

// ---------- 关键目录的原序上下文 ----------
const KEYDIR = process.env.FF_KEY_DIR || 'download/videos/示例演员H';
const doc = docs.find(d => d.serial === target && d.relPath === KEYDIR && d.mode === 'cover');
if (doc) {
    console.log(`\n—— ${KEYDIR} 的原序条目（共 ${doc.data.length}）——`);
    doc.data.forEach((e, i) => {
        const tag = e.type.padEnd(7);
        const hasFace = e.type === 'image' ? '已经长脸' : e.type === 'video' ? '裸视频' : '目录';
        console.log(`  ${String(i + 1).padStart(2)}. ${tag} ${isNum(e.name) ? '[NUM] ' : '      '}${e.name}  ← ${hasFace}`);
    });
} else {
    console.log(`\n(没找到目录 ${KEYDIR} 的缓存文档)`);
}
