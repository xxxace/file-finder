/**
 * 护栏探针：业务代码里不许出现色值字面量。
 *
 * 为什么需要它：设计系统能不能长期成立，不看第一次改得多整齐，看**下一次**有没有人
 * 顺手往 .vue 里塞一个 #999。只靠自觉一定会复发（2026-11-07 实测：改造前 12 处硬编码文字色）。
 *
 * 唯一豁免：`src/styles/tokens.css`（L1 原始值就住在那儿）。
 *
 * 用法：`node docs/probes/tokens/no-raw-color.mjs`
 *   - 只读，不改任何文件
 *   - 命中数 > BASELINE ⇒ exit 1
 *   - 每走完一个屏，把 BASELINE 下调到当次实测值；全部改完必须是 0
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();
const SRC = join(ROOT, 'src');
const EXEMPT = new Set([
    join('src', 'styles', 'tokens.css'),
    // `#000` 在 mask-image 里是**遮罩通道**不是颜色（主题切换的圆形扩散），不属于配色
    join('src', 'theme', 'transition.ts'),
]);

/** 迁移基线：只许降，不许升。全部改造完成后改成 0。 */
const BASELINE = 53;

const HEX = /#[0-9a-fA-F]{3,8}\b/g;
const FUNC = /\brgba?\s*\(/g;

function walk(dir, out = []) {
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) {
            if (name === 'node_modules') continue;
            walk(p, out);
        } else if (/\.(vue|ts)$/.test(name) && !name.endsWith('.d.ts')) {
            out.push(p);
        }
    }
    return out;
}

const hits = [];
for (const file of walk(SRC)) {
    const rel = relative(ROOT, file);
    if (EXEMPT.has(rel.split('/').join(sep))) continue;
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    let inBlock = false;
    lines.forEach((line, i) => {
        // 注释里的色值不算违规（"别写 #999" 这类说明本身不该被拦）。
        // 必须跟踪跨行的块注释：`/* 原来用的是 #d03050 */` 常常从行中开始。
        let code = line;
        if (inBlock) {
            const end = code.indexOf('*/');
            if (end === -1) return;
            code = code.slice(end + 2);
            inBlock = false;
        }
        const open = code.indexOf('/*');
        if (open !== -1) {
            const end = code.indexOf('*/', open + 2);
            if (end === -1) {
                code = code.slice(0, open);
                inBlock = true;
            } else {
                code = code.slice(0, open) + code.slice(end + 2);
            }
        }
        const trimmed = code.trim();
        if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*')) return;
        const found = [...(code.match(HEX) || []), ...(code.match(FUNC) || [])];
        if (found.length) hits.push({ file: rel, line: i + 1, found, text: trimmed.slice(0, 90) });
    });
}

if (hits.length === 0) {
    console.log('PASS 业务代码里没有色值字面量。');
    process.exit(0);
}

console.log(`命中 ${hits.length} 处色值字面量（基线 ${BASELINE}）：`);
for (const h of hits) {
    console.log(`  ${h.file}:${h.line}  ${h.found.join(' ')}  ${h.text}`);
}

if (hits.length > BASELINE) {
    console.log(`\nFAIL 比基线多了 ${hits.length - BASELINE} 处 —— 色值要回 tokens.css。`);
    process.exit(1);
}
console.log('\nPASS 未超过基线。');
