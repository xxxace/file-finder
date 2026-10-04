/**
 * 把 **真实的 SFC `<style scoped>`** 编译出来给探针用（手法同 popover-pick / header-width）。
 *
 * 为什么不能手抄一份"等效 CSS"：本次要判断的是「弹层条目到底长什么样」——
 * 而它的丑/不丑完全取决于**继承与特异性**（`.file-item span` 有没有被网格那条
 * `white-space:nowrap` / `height:38px!important` 吃掉）。手抄一份就正好把这个变量抄没了。
 *
 *   node docs/probes/popup-visual/build-css.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, compileStyleAsync } from 'vue/compiler-sfc';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');

/** 必须与页面里打的 scoped 标记一致 */
const SCOPE_ID = 'probe';

const chunks = [
    `/* ⚠️ 生成产物，别手改 —— 由 docs/probes/popup-visual/build-css.mjs 真实编译
   （less + scoped 转换）。改了组件样式就重跑。 */`,
];

for (const rel of ['src/views/FileFinder/index.vue']) {
    const filename = path.join(repo, rel).replace(/\\/g, '/');
    const source = fs.readFileSync(filename, 'utf8');
    const { descriptor, errors } = parse(source, { filename });
    if (errors.length) {
        console.error(`解析失败 ${rel}:`, errors.map(e => e.message).join('; '));
        process.exit(1);
    }
    for (const [i, style] of descriptor.styles.entries()) {
        if (!style.scoped) continue;
        const out = await compileStyleAsync({
            source: style.content,
            filename,
            id: SCOPE_ID,
            scoped: true,
            preprocessLang: style.lang,
        });
        if (out.errors.length) {
            console.error(`编译失败 ${rel} style[${i}]:`, out.errors.map(String).join('; '));
            process.exit(1);
        }
        chunks.push(`\n/* ── ${rel}  style[${i}] ── */\n${out.code}`);
    }
}

const dest = path.join(here, 'css-real.generated.css');
fs.writeFileSync(dest, chunks.join('\n'), 'utf8');
console.log('css-real.generated.css 已重建，', fs.statSync(dest).size, 'B');
