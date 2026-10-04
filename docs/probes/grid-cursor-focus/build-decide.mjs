/**
 * 把真的 `src/views/FileFinder/openDecision.ts` 打成可内联的 IIFE，注入探针页面。
 *
 * ## 为什么必须引真源码
 *
 * 判据是 2026-10-04 业主真机报 bug 的地方（「回车打开的是预览图不是文件」）。
 * 第一版探针把判据**手抄**进页面，结果回退真源码时探针**依然全绿** ——
 * 改探针不改真代码，断言的只是"我抄的那份对不对"。与同一天 `isGridKeyBlocked`
 * 那次是同一个错。⇒ 判据必须是同一份代码。
 *
 * 这也是把判据从 `index.vue` 抽成独立模块的**直接原因**：
 * 埋在 SFC 里就只能靠正则截，截出来的东西仍与产品代码分家。
 */
import * as esbuild from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');

const res = await esbuild.build({
    entryPoints: [path.resolve(repo, 'src/views/FileFinder/openDecision.ts')],
    bundle: true,
    format: 'iife',
    globalName: '__decide',
    platform: 'browser',
    write: false,
    logLevel: 'silent',
});
process.stdout.write(res.outputFiles[0].text);
