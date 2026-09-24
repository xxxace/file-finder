/**
 * n-space 重复 key 探针 —— 模板生成器
 *
 * 产出四份 render 函数（都由 @vue/compiler-sfc 真编译，不是我手抄的近似版）：
 *   OldToolbar.js  —— **改前**那一版右侧工具条，逐字保留（用于复现"两个重读这一片"）
 *   MinimalSpace.js / MinimalSpaceNoWrap.js / MinimalDiv.js —— 最小复现与两组对照
 *   Toolbar.js / ScanBar.js —— **改后**的真实模板（从活源码里切，不复制粘贴）
 *
 * 为什么 OldToolbar 用字面量而不是从源码切：
 *   改完之后那版 markup 已经不在仓库里了，但"复现"这一步必须可复算 ——
 *   所以把改前的 markup 原样钉在这里，它就是复现的输入。
 */
const fs = require('fs');
const path = require('path');
const { compileTemplate } = require('@vue/compiler-sfc');

const LIVE = 'D:/code/file-finder/src/views/FileFinder/index.vue';
const OUT = __dirname;

function compile(name, template) {
    const { code, errors } = compileTemplate({
        source: template, filename: name + '.vue', id: name,
        compilerOptions: { mode: 'module' }
    });
    if (errors.length) { console.error(name, errors); process.exit(1); }
    fs.writeFileSync(path.join(OUT, name + '.js'), code, 'utf8');
    console.log(`${name}.js  ${String(code.length).padStart(6)} B`);
}

/* ---------- 1) 改前的真实 markup（逐字保留） ---------- */
const OLD_TOOLBAR = `
<n-space style="align-self: flex-end;" align="center">
    <n-button v-if="!scanning" size="small" :disabled="!openStack.length || readOnlyLevel" @click="startScan(false)">
        补全这一片
    </n-button>
    <n-popconfirm v-if="!scanning" positive-text="重读" negative-text="取消"
        @positive-click="startScan(true)">
        <template #trigger>
            <n-button size="small" :disabled="!openStack.length || readOnlyLevel">重读这一片</n-button>
        </template>
        忽略缓存，把这一片重新读一遍硬盘。确定吗？
    </n-popconfirm>
    <span v-if="scanning" class="scan-progress">已扫 {{ scanDone }} / 待扫 {{ scanPending }}</span>
    <n-button v-if="scanning" size="small" @click="onScanCancel">取消</n-button>
    <n-button size="small" @click="showHistory">
        <template #icon>
            <FootstepsOutline />
        </template>
    </n-button>
    <n-badge v-if="fileList.length" :value="fileList.length" />
    <n-input ref="searchInput" v-model:value="searchText" placeholder="搜索" size="small" clearable>
        <template #prefix>
            <n-icon :component="Search" />
        </template>
        <template #suffix>
            <span class="suffix-icon">S</span>
        </template>
    </n-input>
    <n-tooltip>
        <template #trigger>
            <n-button size="small" :disabled="scanning || readOnlyLevel" @click="onRefresh">
                <template #icon>
                    <n-icon>
                        <Refresh />
                    </n-icon>
                </template>
            </n-button>
        </template>
        重新读取当前文件夹
    </n-tooltip>
</n-space>
`;
compile('OldToolbar', `<div class="probe-root">${OLD_TOOLBAR}</div>`);

/* ---------- 2) 最小复现：n-space 里子元素个数随 v-if 变化 ---------- */
const minimalBody = `
    <n-button v-if="!scanning" size="small" @click="noop">ALPHA</n-button>
    <n-button v-if="!scanning" size="small" @click="noop">BETA</n-button>
    <span v-if="scanning" class="scan-progress">busy</span>
    <n-button v-if="scanning" size="small" @click="onScanCancel">CANCEL</n-button>
`;
compile('MinimalSpace', `<div class="probe-root"><n-space align="center">${minimalBody}</n-space></div>`);
compile('MinimalSpaceNoWrap', `<div class="probe-root"><n-space align="center" :wrap-item="false">${minimalBody}</n-space></div>`);
compile('MinimalDiv', `<div class="probe-root"><div class="hstack">${minimalBody}</div></div>`);

/* ---------- 3) 改后的真实模板：从活源码按标记切 ---------- */
const src = fs.readFileSync(LIVE, 'utf8').replace(/\r\n/g, '\n');
function slice(startMark, endMark) {
    const a = src.indexOf(startMark);
    if (a < 0) { console.error('!! 找不到起点:', startMark); process.exit(1); }
    const b = src.indexOf(endMark, a);
    if (b < 0) { console.error('!! 找不到终点:', endMark); process.exit(1); }
    return src.slice(a, b + endMark.length);
}
const toolbar = slice('<div class="toolbar" style="align-self: flex-end">',
    '重新读取当前文件夹\n                </n-tooltip>\n            </div>');
const scanBar = slice('<div v-if="scanning" class="scan-bar">', '</div>');
if (!toolbar.includes('补全这一片')) { console.error('!! 工具条切片不对'); process.exit(1); }
if (!scanBar.includes('onScanCancel')) { console.error('!! 状态条切片不对'); process.exit(1); }

compile('Toolbar', `<div class="probe-root">${toolbar}</div>`);
compile('ScanBar', `<div class="probe-root">${scanBar}</div>`);

/* ---------- 3.5) 布局对照：三份工具条拼进**完整的** .header-bar 里 ----------
   为什么要在同一页放三份：结构探针（happy-dom）没有布局引擎，量不出"工具条有几行"。
   这一份是给**真浏览器**（Chrome）量的：n-space 原样 / 中间态 .hstack / 修后 .toolbar。
   左侧那一组用同宽（130px，量自截图 x30–159）的替身占位 —— 出问题的是右侧，替身足够。 */
const MID_TOOLBAR = OLD_TOOLBAR
    .replace('<n-space style="align-self: flex-end;" align="center">',
        '<div class="hstack" style="align-self: flex-end">')
    .replace('</n-space>', '</div>');
const LIVE_TOOLBAR = toolbar;   // 已是改后的 `<div class="toolbar" style="align-self: flex-end">…`

const LEFT_STUB = '<div class="hstack"><div class="leftstub">请选择文件夹(D)</div></div>';
const variant = (id, body) =>
    `<div class="finder variant-${id}"><div class="header-bar">${LEFT_STUB}${body}</div></div>`;

compile('LayoutA', variant('a', OLD_TOOLBAR));
compile('LayoutB', variant('b', MID_TOOLBAR));
compile('LayoutC', variant('c', LIVE_TOOLBAR));

/* ---------- 4) 自检：template 段里还有没有活的 n-space ---------- */
const templateOnly = src.split('<script')[0].replace(/<!--[\s\S]*?-->/g, '');
console.log('\ntemplate 里活的 <n-space> :', (templateOnly.match(/<n-space/g) || []).length, '(应为 0)');
