/**
 * 「多部组成」popover 点击归属探针 —— 模板生成器
 *
 * 从**活源码**里按标记切出文件列表 popover 那段 markup（不手抄），
 * 写成 markup.js 给 index.html 用。这样探针测的就是真实渲染结构。
 *
 *   node docs/probes/popover-pick/templates.cjs
 */
const fs = require('fs');
const path = require('path');

const LIVE = 'D:/code/file-finder/src/views/FileFinder/index.vue';
const OUT = __dirname;

const src = fs.readFileSync(LIVE, 'utf8').replace(/\r\n/g, '\n');

const startMark = '<n-popover :show="popover.visible"';
const a = src.indexOf(startMark);
if (a < 0) { console.error('!! 找不到 files popover 起点'); process.exit(1); }
const b = src.indexOf('</n-popover>', a);
if (b < 0) { console.error('!! 找不到 files popover 终点'); process.exit(1); }
const markup = src.slice(a, b + '</n-popover>'.length);

if (!markup.includes('popover.files') || !markup.includes('openFile')) {
    console.error('!! 切出来的不是文件列表 popover'); process.exit(1);
}

/* ---------- 2) 网格那一块（含 n-image 缩略图 / 预览触发）---------- */
const ga = src.indexOf('<div class="image-box" ref="imageBox">');
if (ga < 0) { console.error('!! 找不到 image-box 起点'); process.exit(1); }
const gb = src.indexOf('<!-- 扫描状态条', ga);
if (gb < 0) { console.error('!! 找不到 image-box 之后的扫描状态条'); process.exit(1); }
const gridEnd = src.lastIndexOf('</div>', gb) + '</div>'.length;
const grid = src.slice(ga, gridEnd);
if (!grid.includes('image-box-item') || !grid.includes('empty-tip') || !grid.includes('n-image')) {
    console.error('!! 切出来的不是 image-box'); process.exit(1);
}

/* ⚠️ 「改前」的 grid markup：由**改后**的活源码机械还原（不是手抄）。
   本次改动只动了 n-image 那两行 + 卡片那个 @click，所以还原 = 反向替换这三处。
   探针靠它复现"预览吃掉双击"那个症状，改后版本靠 __GRID_MARKUP。 */
const GRID_OLD = grid
    .replace(/\s*:render-toolbar="previewToolbar"/, '');
if (GRID_OLD === grid) {
    console.error('!! 「改前」markup 还原失败（源文件里 :render-toolbar 那处写法变了？）');
    process.exit(1);
}

fs.writeFileSync(path.join(OUT, 'markup.js'),
    `/* 生成产物，别手改：node docs/probes/popover-pick/templates.cjs */\n` +
    `window.__POPOVER_MARKUP = ${JSON.stringify(markup)};\n` +
    `window.__GRID_MARKUP = ${JSON.stringify(grid)};\n` +
    `window.__GRID_MARKUP_OLD = ${JSON.stringify(GRID_OLD)};\n`, 'utf8');

console.log('markup.js 已生成：popover', markup.length, 'B / grid', grid.length, 'B');
console.log('--- 切出来的 popover markup ---');
console.log(markup);
console.log('--- 切出来的 grid markup ---');
console.log(grid);
console.log('-----------------------');
