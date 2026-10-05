/**
 * 端到端探针：用**真实的 zip.ts 编译产物**跑「打包 → 解包」往返
 * 不复刻逻辑 —— 直接 esbuild 打包真实源文件，喂真实夹具。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

let pass = 0, fail = 0;
const t = (n, c, d) => { c ? (pass++, console.log('  PASS  ' + n + (d ? ' — ' + d : ''))) : (fail++, console.log('  FAIL  ' + n + (d ? ' — ' + d : ''))); };

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-'));

  // 1) esbuild 把真实 zip.ts 打成 CJS（无外部依赖）
  const esbuild = require('esbuild');
  const outFile = path.join(tmp, 'zip.cjs');
  await esbuild.build({
    entryPoints: [path.join(__dirname, '../../../electron/utils/zip.ts')],
    bundle: true, platform: 'node', format: 'cjs', outfile: outFile, logLevel: 'silent',
  });
  const { writeZip, listZip, readZipEntry } = require(outFile);

  // 2) 造夹具：一个"明文库"（deflate）+ 一个高熵"图片"（store）+ 一个 manifest
  const dbPlain = '{"$$indexCreated":{"fieldName":"serial"}}\n{"_id":"r1","v":3,"serial":"FE8CDC72","relPath":"a","data":[]}\n';
  const imgBytes = crypto.randomBytes(8192);
  const fs2 = fs;
  const dbFile = path.join(tmp, 'searchCache.json');
  const imgFile = path.join(tmp, 't-abc.enc');
  const mfFile = path.join(tmp, 'manifest.json');
  fs2.writeFileSync(dbFile, dbPlain, 'utf8');
  fs2.writeFileSync(imgFile, imgBytes);
  fs2.writeFileSync(mfFile, JSON.stringify({ format: 1, images: 1 }), 'utf8');

  // 3) 用真实 writeZip 打包
  const zipPath = path.join(tmp, 'backup.zip');
  const bytes = await writeZip(zipPath, [
    { name: 'manifest.json', file: mfFile, compress: 'deflate' },
    { name: 'searchCache.db', file: dbFile, compress: 'deflate' },
    { name: 'bin/t-abc.enc', file: imgFile },
  ]);
  t('writeZip 返回写入字节数', bytes > 0, bytes + ' bytes');

  // 4) 用真实 listZip + readZipEntry 解包
  const entries = await listZip(zipPath);
  t('listZip 列出 3 个条目', entries.length === 3, '实际 ' + entries.length);
  const dbE = entries.find(e => e.name === 'searchCache.db');
  t('库条目 method=8 (deflate)', dbE.method === 8);
  const dbBack = (await readZipEntry(zipPath, dbE)).toString('utf8');
  t('库内容往返逐字一致', dbBack === dbPlain);
  const imgE = entries.find(e => e.name === 'bin/t-abc.enc');
  t('图片条目 method=0 (store)', imgE.method === 0);
  const imgBack = await readZipEntry(zipPath, imgE);
  t('图片字节往返一致', imgBack.equals(imgBytes));
  const mfBack = JSON.parse((await readZipEntry(zipPath, entries.find(e => e.name === 'manifest.json'))).toString('utf8'));
  t('manifest 解析正确', mfBack.format === 1 && mfBack.images === 1);

  // 5) 体积对比：deflate 的库 vs store 的库
  const raw = fs2.statSync(zipPath).size;
  console.log('  (整包 ' + (raw / 1024).toFixed(1) + ' KB，含 8KB 高熵图片)');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('\n===== ' + pass + ' PASS / ' + fail + ' FAIL =====');
  process.exit(fail ? 1 : 0);
})();
