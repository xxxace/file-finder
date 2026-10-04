/**
 * 把**真的** `src/utils/index.ts` 打成一段可内联的 IIFE，注入探针页面。
 *
 * ## 为什么必须引真源码，而不是在页面里复刻一份
 *
 * 第一版探针是**手抄**判据的，结果回退真源码时探针毫无反应（改探针不改变真代码），
 * **判据有效性没被证明**。守卫恰好是被无头探针改过两次的地方（见 `utils/index.ts`
 * 的文件头），所以它必须是**同一份代码**。
 *
 * 只打这一个文件：`utils/index.ts` 顶部无 import，esbuild 不会拖进任何依赖。
 */
import * as esbuild from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const entry = path.resolve(repo, 'src/utils/index.ts');

const res = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: 'iife',
    globalName: '__utils',
    platform: 'browser',
    write: false,
    logLevel: 'silent',
});
const code = res.outputFiles[0].text;
process.stdout.write(code);
