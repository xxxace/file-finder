/**
 * 一次性诊断脚本：读真库，看某个位置到底有没有缓存、长什么样。
 *
 *   node docs/probes/faces/diag.mjs TST-xxx        # 传一个"位置关键词"（番号 / 目录名都行）
 *
 * ⚠️ 只在终端输出、**不写文件**；输出里会含真实名字（你盘的实际情况），
 * 所以**别把输出粘进文档** —— 文档里一律用 `TST-xxx` / `示例演员A` / `D:/sample/videos/…` 这类占位。
 */
import { build } from 'esbuild';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const realDb = path.resolve(process.env.USERPROFILE || process.env.USER || '/', './.file-finder/searchCache.db');
const stubPath = path.join(here, 'electron-stub.mjs');
const KEY = process.argv[2] || '';

const sandbox = await fsp.mkdtemp(path.join(os.tmpdir(), 'ff-diag-'));
const base = path.join(sandbox, '.file-finder');
await fsp.mkdir(base, { recursive: true });
const dbPath = path.join(base, 'searchCache.db');
await fsp.copyFile(realDb, dbPath);
process.env.USERPROFILE = sandbox;
process.env.USER = sandbox;

const out = path.join(repo, 'node_modules/.cache', `ff-diag-${Date.now()}.mjs`);
await build({
    entryPoints: [path.join(repo, 'electron/server/nedb.ts')],
    bundle: true, platform: 'node', format: 'esm', target: 'node22',
    outfile: out, logLevel: 'silent', packages: 'external', alias: { electron: stubPath },
});
const { readExternalCache } = await import(pathToFileURL(out).href);

const docs = await readExternalCache(dbPath);
const byMode = {};
for (const d of docs) byMode[d.mode] = (byMode[d.mode] || 0) + 1;
console.log(`库中文档 ${docs.length} 条 · 各 mode: ${JSON.stringify(byMode)}`);

const hits = docs.filter(d => (d.relPath || '').includes(KEY));
console.log(`\nrelPath 含「${KEY}」的文档：${hits.length} 条`);
for (const d of hits) {
    console.log(`--- mode=${d.mode} · serial=${d.serial.slice(0, 4)}… · 条目 ${(d.data || []).length}`);
    console.log(`    relPath = ${d.relPath}`);
    for (const e of (d.data || []).slice(0, 15)) {
        // ⚠️ 这里特意把**条目自己的 `dir`** 也打出来：收敛出来的封面卡，这个字段是
        // "它代表的那个子目录"，与它所在的**文档层**（`relPath`）**不是一回事** ——
        // 换封面那条链路上的层错位 bug 就是栽在这两者的差别上。
        console.log(`      type=${e.type} dir=${JSON.stringify(e.dir)} name=${JSON.stringify(e.name)} ext=${JSON.stringify(e.ext)} avatar=${e.avatar ? '有' : '—'}`);
    }
}

// 顺带：同一层的兄弟（用 KEY 的上一级再捞一次，看那一层还有谁）
const parentKey = KEY.includes('/') ? KEY.slice(0, KEY.lastIndexOf('/')) : '';
if (parentKey) {
    const siblings = docs.filter(d => (d.relPath || '').startsWith(parentKey));
    console.log(`\nrelPath 以「${parentKey}」开头的文档：${siblings.length} 条`);
    for (const d of siblings.slice(0, 10)) {
        console.log(`  · mode=${d.mode} · 条目 ${(d.data || []).length} · ${d.relPath}`);
    }
}

await fsp.rm(sandbox, { recursive: true, force: true }).catch(() => undefined);
await fsp.rm(out, { force: true }).catch(() => undefined);
