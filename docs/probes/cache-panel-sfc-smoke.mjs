/**
 * 「缓存记录」改造 · SFC 编译期冒烟（只读，不写任何文件）
 *
 * 手法照抄 docs/probes/p1-sfc-smoke.mjs（同一个作者、同一个理由），只是把文件路径做成参数，
 * 好一次覆盖本次改动过的两个 .vue。
 *
 * 为什么需要：`vue-tsc --noEmit` 是**类型**检查。模板里的指令用法、`<style>` 块
 * 它抓得不全。这里用 `vue/compiler-sfc` 把三段各编译一遍，编译不过就报出来。
 *
 * ⚠️ 它只证明"**能编译**"，**不证明"渲染出来是对的"** —— 界面对不对只能真机目视。
 *
 * 复算：node docs/probes/cache-panel-sfc-smoke.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { parse, compileScript, compileTemplate, compileStyleAsync } from 'vue/compiler-sfc';

const ROOT = path.resolve(new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const FILES = process.argv.slice(2).length
    ? process.argv.slice(2)
    : [
        'src/components/HistoryTable/index.vue',
        'src/views/FileFinder/index.vue',
    ];

let failed = 0;

for (const rel of FILES) {
    const filename = path.join(ROOT, rel).replace(/\\/g, '/');
    const source = fs.readFileSync(filename, 'utf8');
    const id = `smoke-${path.basename(rel)}`;
    const problems = [];

    const { descriptor, errors } = parse(source, { filename });
    if (errors.length) problems.push(...errors.map(e => `parse: ${e.message}`));
    if (!descriptor.template) problems.push('没有找到 <template>');
    // ⚠️ **不能把"没有 `<script setup>`"当成问题**：本项目有合法的 Options API 组件
    // （`src/components/FolderSelector/index.vue` 就是 `defineComponent` + `<script lang="ts">`），
    // 探针第一版在这里误报过一次。只有**两者都没有**才算真问题。
    if (!descriptor.scriptSetup && !descriptor.script) problems.push('既没有 <script setup> 也没有 <script>');

    if (descriptor.scriptSetup || descriptor.script) {
        try {
            compileScript(descriptor, { id });
        } catch (e) {
            problems.push(`compileScript: ${e.message}`);
        }
    }

    if (descriptor.template) {
        const tpl = compileTemplate({
            source: descriptor.template.content,
            filename,
            id,
            scoped: descriptor.styles.some(s => s.scoped),
            compilerOptions: { expressionPlugins: ['typescript'] },
        });
        problems.push(...tpl.errors.map(e => `compileTemplate: ${typeof e === 'string' ? e : e.message}`));
    }

    for (const [i, style] of descriptor.styles.entries()) {
        const out = await compileStyleAsync({
            source: style.content,
            filename,
            id,
            scoped: style.scoped,
            preprocessLang: style.lang,
        });
        problems.push(...out.errors.map(e => `style[${i}]: ${typeof e === 'string' ? e : e.message}`));
    }

    failed += problems.length;
    console.log(JSON.stringify({
        文件: rel,
        'script setup': !!descriptor.scriptSetup,
        template: !!descriptor.template,
        style块: descriptor.styles.map(s => (s.scoped ? 'scoped' : 'global')).join(',') || '(无)',
        问题数: problems.length,
        问题: problems,
    }, null, 2));
}

console.log(failed ? `\n❌ 共 ${failed} 个编译期问题` : '\n✅ 全部通过编译（渲染正确性仍需真机目视）');
process.exit(failed ? 1 : 0);
