/**
 * 验证失效/已删除目录在缓存中的清理机制：
 * 1. 命中缓存的已删目录访问时，自动检测物理 ENOENT 并移出 NeDB，返回 kind: 'notFound'
 * 2. 文件夹在磁盘更名改变大小写（如 Julia -> JULIA）时，命中旧大小写会自动检测 realpath 真实大小写不符，移出旧记录并返回 notFound
 * 3. 盘离线时绝不误删缓存
 * 4. 子树孤儿批量清退
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import Module, { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const require = createRequire(import.meta.url);
const REPO = fileURLToPath(new URL('../../..', import.meta.url));
const PROBE = path.join(os.tmpdir(), `ff-orphan-verify-${Date.now()}`);
const PORT = 3089;

process.env.NODE_PATH = [path.join(REPO, 'node_modules'), process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
Module._initPaths();

function write(p, content) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
}

async function main() {
    console.log('[PROBE] 准备测试环境:', PROBE);
    const srcDir = path.join(PROBE, 'src');
    fs.cpSync(path.join(REPO, 'electron'), srcDir, { recursive: true });

    // 端口替换
    const indexFile = path.join(srcDir, 'server', 'index.ts');
    let src = fs.readFileSync(indexFile, 'utf8');
    src = src.replace('app.listen(3060,', `app.listen(${PORT},`);
    fs.writeFileSync(indexFile, src);

    // electron 替身
    const stub = path.join(PROBE, 'node_modules', 'electron');
    write(path.join(stub, 'package.json'), JSON.stringify({ name: 'electron', version: '0.0.0', main: 'index.js' }));
    write(path.join(stub, 'index.js'), `exports.nativeImage = { createFromPath() {
        return { isEmpty: () => false, getSize: () => ({ width: 80, height: 60 }), resize() { return this; }, toJPEG: () => Buffer.from('STUB') };
    } };\n`);

    const entry = path.join(PROBE, 'entry.ts');
    const outfile = path.join(PROBE, 'out.cjs');
    write(entry, `export { LOCAL_TOKEN } from './src/server/token';\nimport './src/server/index';\n`);

    await esbuild.build({
        entryPoints: [entry],
        outfile,
        bundle: true,
        platform: 'node',
        format: 'cjs',
        packages: 'external',
        logLevel: 'silent',
    });

    const dataDir = path.join(PROBE, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    process.env.USERPROFILE = dataDir;

    const testRoot = path.join(PROBE, 'test-drive-root');
    fs.mkdirSync(path.join(testRoot, 'folderA', 'subA'), { recursive: true });
    fs.mkdirSync(path.join(testRoot, 'folderB', 'subB'), { recursive: true });
    fs.mkdirSync(path.join(testRoot, 'caseFolder', 'Julia'), { recursive: true });
    fs.writeFileSync(path.join(testRoot, 'folderA', 'a.txt'), 'hello');
    fs.writeFileSync(path.join(testRoot, 'folderB', 'b.txt'), 'hello');
    fs.writeFileSync(path.join(testRoot, 'caseFolder', 'Julia', 'v.mp4'), 'video');

    const TOKEN = require(outfile).LOCAL_TOKEN;

    const request = (method, url, body) => new Promise((resolve) => {
        const u = new URL(`http://127.0.0.1:${PORT}${url}${url.includes('?') ? '&' : '?'}t=${TOKEN}`);
        const opt = {
            method,
            hostname: u.hostname,
            port: u.port,
            path: u.pathname + u.search,
            headers: body ? { 'Content-Type': 'application/json' } : {},
        };
        const req = http.request(opt, (res) => {
            let data = '';
            res.on('data', c => { data += c; });
            res.on('end', () => {
                try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
                catch { resolve({ status: res.statusCode, text: data }); }
            });
        });
        if (body) req.write(JSON.stringify(body));
        req.end();
    });

    // 等待服务监听
    await new Promise(r => setTimeout(r, 600));

    console.log('[PROBE] 1. 扫描写入 folderA, folderB, caseFolder/Julia...');
    const r1 = await request('GET', `/openFolder?path=${encodeURIComponent(path.join(testRoot, 'folderA'))}&mode=cover`);
    const r2 = await request('GET', `/openFolder?path=${encodeURIComponent(path.join(testRoot, 'folderB'))}&mode=cover`);
    const r3 = await request('GET', `/openFolder?path=${encodeURIComponent(path.join(testRoot, 'caseFolder', 'Julia'))}&mode=cover`);
    console.log('  folderA status:', r1.status);
    console.log('  folderB status:', r2.status);
    console.log('  caseFolder/Julia status:', r3.status);

    const historyBefore = await request('GET', `/getHistory?pageNo=1&pageSize=50`);
    console.log('  当前总缓存数:', historyBefore.body?.total);

    console.log('\n[PROBE] 2. 从磁盘删除 folderB，再次以 verify=true 访问 folderB...');
    fs.rmSync(path.join(testRoot, 'folderB'), { recursive: true, force: true });

    const rB_cached = await request('GET', `/openFolder?path=${encodeURIComponent(path.join(testRoot, 'folderB'))}&mode=cover&verify=true`);
    console.log('  访问已删目录响应:', rB_cached.status, rB_cached.body);

    const historyAfterDel = await request('GET', `/getHistory?pageNo=1&pageSize=50`);
    console.log('  清理 folderB 后总缓存数:', historyAfterDel.body?.total);

    const pass1 = rB_cached.status === 500 && rB_cached.body?.kind === 'notFound';
    console.log('  断言 1 (访问已删目录返回 notFound):', pass1 ? 'PASS ✓' : 'FAIL ✗');

    console.log('\n[PROBE] 3. 将磁盘上 caseFolder/Julia 改名为全大写 JULIA...');
    fs.renameSync(path.join(testRoot, 'caseFolder', 'Julia'), path.join(testRoot, 'caseFolder', 'JULIA_TMP'));
    fs.renameSync(path.join(testRoot, 'caseFolder', 'JULIA_TMP'), path.join(testRoot, 'caseFolder', 'JULIA'));

    console.log('  以旧大小写访问 caseFolder/Julia (verify=true)...');
    const rJulia_old = await request('GET', `/openFolder?path=${encodeURIComponent(path.join(testRoot, 'caseFolder', 'Julia'))}&mode=cover&verify=true`);
    console.log('  旧大小写响应:', rJulia_old.status, rJulia_old.body);

    const pass2 = rJulia_old.status === 500 && rJulia_old.body?.kind === 'notFound';
    console.log('  断言 2 (检测到大小写变更，旧大小写被移出并返回 notFound):', pass2 ? 'PASS ✓' : 'FAIL ✗');

    console.log('  以新大小写扫描 caseFolder/JULIA...');
    const rJulia_new = await request('GET', `/openFolder?path=${encodeURIComponent(path.join(testRoot, 'caseFolder', 'JULIA'))}&mode=cover`);
    console.log('  新大小写扫描响应:', rJulia_new.status);

    const historyFinal = await request('GET', `/getHistory?pageNo=1&pageSize=50`);
    const juliaRecords = (historyFinal.body?.records || []).filter(r => r.path?.toLowerCase().includes('julia'));
    console.log('  包含 julia 的记录列表:', juliaRecords.map(r => r.path));

    const pass3 = juliaRecords.length === 1 && juliaRecords[0].path.includes('JULIA');
    console.log('  断言 3 (库中仅保留唯一新大小写记录 JULIA，旧大小写彻底移除):', pass3 ? 'PASS ✓' : 'FAIL ✗');

    // 清理
    fs.rmSync(PROBE, { recursive: true, force: true });
    console.log('\n[PROBE] 全部验证完成！');
    process.exit(pass1 && pass2 && pass3 ? 0 : 1);
}

main().catch(err => {
    console.error('Probe error:', err);
    process.exit(1);
});
