/**
 * 把 **真实的 SFC `<style scoped>`** 编译出来给探针用（手法同 header-width 探针）。
 *
 * 为什么要真的：本次要查的是「点第 2 项却打开第 1 项」。如果 `.file-item` /
 * `.hstack` 的真实布局不是"并排三个 84×84 的格子"，那么点击落点就会错位 ——
 * 而这类结论**只有拿真 CSS 量出来才算证据**，手抄一份等效 CSS 只能证明"这套写法成立"。
 *
 *   node docs/probes/popover-pick/build-css.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, compileStyleAsync } from 'vue/compiler-sfc';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');

/** 必须与 index.html 里打的 scoped 标记一致 */
const SCOPE_ID = 'probe';

const FILES = ['src/views/FileFinder/index.vue'];

const chunks = [
    `/* ⚠️ 生成产物，别手改 —— 由 docs/probes/popover-pick/build-css.mjs 真实编译
   （less + scoped 转换）。改了组件样式就重跑。 */`,
];

for (const rel of FILES) {
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
