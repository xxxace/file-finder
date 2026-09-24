/**
 * SFC 编译期冒烟 —— 只读，不写任何文件。
 *
 * 为什么需要：渲染层**没有浏览器可验**。`vue-tsc --noEmit` 是类型检查，它**不会**
 * 真的编译模板（模板里的语法错误、`compileScript` 宏的用法错误它都抓不到），
 * Less 更是连看都不看。所以这里用 `vue/compiler-sfc` 把三段各编译一遍：
 *   · `<script setup lang="ts">` → compileScript
 *   · `<template>`             → compileTemplate（**必须给 expressionPlugins:['typescript']**，
 *                                否则模板里的 `as` / 类型注解会被当语法错误）
 *   · `<style lang="less" scoped>` → compileStyleAsync（走真的 less 编译器）
 *
 * ⚠️ 这只证明"能编译"，**不证明"渲染出来是对的"**。界面对不对无头验不了。
 *
 * 复算：node docs/probes/p1-sfc-smoke.mjs
 */
import fs from 'node:fs';
import { parse, compileScript, compileTemplate, compileStyleAsync } from 'vue/compiler-sfc';

const file = new URL('../../src/views/FileFinder/index.vue', import.meta.url);
const filename = file.pathname.replace(/^\//, '');
const source = fs.readFileSync(file, 'utf8');
const id = 'p1smoke';

const problems = [];

const { descriptor, errors } = parse(source, { filename });
if (errors.length) problems.push(...errors.map(e => `parse: ${e.message}`));

if (!descriptor.template) problems.push('没有找到 <template>');
if (!descriptor.scriptSetup) problems.push('没有找到 <script setup>');

if (descriptor.scriptSetup) {
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

console.log(JSON.stringify({
    文件: filename,
    'script setup': !!descriptor.scriptSetup,
    template: !!descriptor.template,
    style块: descriptor.styles.length,
    问题数: problems.length,
    问题: problems,
}, null, 2));

process.exit(problems.length ? 1 : 0);
