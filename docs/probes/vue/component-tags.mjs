/**
 * 护栏探针：模板里用到的 PascalCase 组件，必须有对应的 import。
 *
 * 为什么需要它：`<AvatarRow>` 如果既不是 import 进来的组件、也不是全局注册的，
 * Vite 与 `vue-tsc` **都不会报错** —— 它被当成一个未知的原生标签，运行时静默渲染成空。
 * 于是出现"类型检查全绿、界面一片空白"（2026-11-08 真实踩到）。
 *
 * 用法：`node docs/probes/vue/component-tags.mjs`
 *   - 只读，不改任何文件
 *   - 有未解析的标签 ⇒ exit 1
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const SRC = join(ROOT, 'src');

/** Vue 内置组件，不需要 import */
const BUILTIN = new Set(['Transition', 'TransitionGroup', 'KeepAlive', 'Teleport', 'Suspense', 'Component']);

function walk(dir, out = []) {
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) {
            if (name === 'node_modules') continue;
            walk(p, out);
        } else if (name.endsWith('.vue')) {
            out.push(p);
        }
    }
    return out;
}

function importedNames(script) {
    const names = new Set();
    // import Foo from './Foo.vue'
    for (const m of script.matchAll(/import\s+([A-Za-z0-9_$]+)\s*(?:,\s*\{[^}]*\})?\s+from/g)) {
        names.add(m[1]);
    }
    // import { A, B as C } from '...'
    for (const m of script.matchAll(/import\s*\{([\s\S]*?)\}\s*from/g)) {
        for (const part of m[1].split(',')) {
            const seg = part.trim();
            if (!seg) continue;
            const as = seg.match(/\bas\s+([A-Za-z0-9_$]+)$/);
            names.add(as ? as[1] : seg.split(/\s+/)[0]);
        }
    }
    return names;
}

let bad = 0;
for (const file of walk(SRC)) {
    const source = readFileSync(file, 'utf8');
    // 模板里的 HTML 注释要先剔掉：注释里出现的 `<Foo />` 是文档，不是用法
    const template = (source.match(/<template>([\s\S]*)<\/template>/)?.[1] ?? '')
        .replace(/<!--[\s\S]*?-->/g, '');
    const script = source.match(/<script[^>]*>([\s\S]*?)<\/script>/)?.[1] ?? '';
    if (!template) continue;

    const used = new Set();
    for (const m of template.matchAll(/<([A-Z][A-Za-z0-9]*)[\s/>]/g)) used.add(m[1]);

    const known = importedNames(script);
    const missing = [...used].filter(t => !known.has(t) && !BUILTIN.has(t));
    if (missing.length) {
        bad += missing.length;
        console.log(`${relative(ROOT, file)}  未解析：${missing.join(', ')}`);
    }
}

console.log(bad ? `\nFAIL ${bad} 处模板标签没有对应组件` : 'PASS 所有模板标签都有来源');
process.exit(bad ? 1 : 0);
