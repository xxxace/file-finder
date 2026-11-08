/**
 * 把 `index.vue` 的**两个** style 块都真实编译出来给探针用。
 *
 * 为什么不能复用 `header-width/build-css.mjs`：那个**只编 scoped 块**
 * （`if (!style.scoped) continue`），而本探针要测的过渡规则
 * （`.nav-zone .fx-move` / `.fx-enter-*` / `.fx-leave-active`）
 * 全在**非 scoped** 的 `<style>` 块里。少编一块 = 量到的是另一个东西。
 *
 * 复跑：node docs/probes/crumb-motion/build-css.mjs
 * 产物：docs/probes/crumb-motion/css-real.generated.css
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, compileStyleAsync } from 'vue/compiler-sfc';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');

/** 与 index.html 里写死的一致 */
const SCOPE_ID = 'probe';

const FILES = ['src/views/FileFinder/index.vue'];

const chunks = [
    `/* ⚠️ 生成产物，别手改 —— docs/probes/crumb-motion/build-css.mjs */`,
];

// 动效时长/曲线是 CSS 变量，必须是 `tokens.css` 里那份真实定义
chunks.push(`\n/* ── src/styles/tokens.css ── */\n` + fs.readFileSync(
    path.join(repo, 'src/styles/tokens.css'), 'utf8'));

for (const rel of FILES) {
    const filename = path.join(repo, rel).replace(/\\/g, '/');
    const source = fs.readFileSync(filename, 'utf8');
    const { descriptor, errors } = parse(source, { filename });
    if (errors.length) {
        console.error(`解析失败 ${rel}:`, errors.map(e => e.message).join('; '));
        process.exit(1);
    }
    for (const [i, style] of descriptor.styles.entries()) {
        const out = await compileStyleAsync({
            source: style.content,
            filename,
            id: SCOPE_ID,
            scoped: !!style.scoped,
            preprocessLang: style.lang,
        });
        if (out.errors.length) {
            console.error(`编译失败 ${rel} style[${i}]:`, out.errors.map(String).join('; '));
            process.exit(1);
        }
        chunks.push(`\n/* ── ${rel}  style[${i}]  scoped=${!!style.scoped} ── */\n${out.code}`);
    }
}

const css = chunks.join('\n');
const outFile = path.join(here, 'css-real.generated.css');
fs.writeFileSync(outFile, css, 'utf8');

// ── 证据：本探针真正依赖的那几条，编译后到底长什么样 ────────────────────────
const lines = css.split('\n').map(l => l.trim());
const pick = (needle) => lines.filter(l => l.includes(needle));
console.log(JSON.stringify({
    输出字节: Buffer.byteLength(css, 'utf8'),
    'fx-move（FLIP 位移）': pick('.fx-move'),
    'fx-enter-from': pick('.fx-enter-from'),
    'fx-leave-active': pick('.fx-leave-active'),
    'crumb-current（角标槽）': pick('.crumb-current'),
    'crumb（收缩/上限）': pick('max-width: 160px'),
    动效变量: pick('--ff-dur-move'),
}, null, 2));
console.log(`\n✅ 已写出 ${path.relative(repo, outFile)}`);
