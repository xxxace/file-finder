/**
 * 把**真实的 SFC `<style scoped>`** 编译出来给探针用。
 *
 * 为什么需要它：`docs/probes/header-width/index.html` 里原来手抄了一份等效 CSS ——
 * 那只能证明"这套写法在普通 CSS 下成立"，**证明不了"scoped 编译之后还成立"**。
 * `:deep(.n-tag__content)` 与 `.crumb:not(.crumb-root)::before` 这两条在 scoped 转换后
 * 到底变成什么选择器，只有编译一次才看得见。
 *
 * 复跑：node docs/probes/header-width/build-css.mjs
 * 产物：docs/probes/header-width/css-real.generated.css（提交进仓库，让 index.html 能独立打开）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, compileStyleAsync } from 'vue/compiler-sfc';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');

/** 探针里给元素打的 scoped 标记（必须与 index.html 里写死的一致） */
const SCOPE_ID = 'probe';
const SCOPE_ATTR = `data-v-${SCOPE_ID}`;

/** 要编译的组件。`index.vue` 提供 .file-finder/.header-bar/.nav-zone/.crumb/.toolbar，
 *  FolderSelector 提供 .fs-tag/.fs-path/.fs-text。 */
const FILES = [
    'src/views/FileFinder/index.vue',
    'src/components/FolderSelector/index.vue',
];

const chunks = [
    `/* ⚠️ 本文件是 **生成产物**，别手改 —— 由 docs/probes/header-width/build-css.mjs
   从两个 SFC 的 <style scoped> 真实编译而来（less 预处理 + scoped 转换）。
   改了组件样式就重跑：node docs/probes/header-width/build-css.mjs */`,
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

const css = chunks.join('\n');
const outFile = path.join(here, 'css-real.generated.css');
fs.writeFileSync(outFile, css, 'utf8');

// ── 证据：把"我关心的那几条"编译后的真身打出来 ──────────────────────────────
const lines = css.split('\n').map(l => l.trim()).filter(l => l.includes('{'));
const pick = (needle) => lines.filter(l => l.includes(needle));
const shown = {
    作用域属性: SCOPE_ATTR,
    输出字节: Buffer.byteLength(css, 'utf8'),
    'nav-zone 自身': pick('.nav-zone'),
    'crumb 段（含收缩/上限）': pick('.crumb'),
    '深层内容（:deep 转换结果）': pick('.n-tag__content'),
    'crumb-text 省略号': pick('.crumb-text'),
    '当前段': pick('.crumb-current'),
    '分隔符 ::before': pick('::before'),
    '工具条': pick('.toolbar'),
    '头部': pick('.header-bar'),
};
console.log(JSON.stringify(shown, null, 2));
console.log(`\n✅ 已写出 ${path.relative(repo, outFile)}`);
