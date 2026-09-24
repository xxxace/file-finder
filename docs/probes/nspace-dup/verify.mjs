/**
 * 验证（改后）：工具条在状态切换下必须**完全恒定**；状态条出现/消失不残留；Vue 警告归零。
 */
import './dom-shim.cjs';
import { createApp, defineComponent, h, ref, nextTick, computed } from 'vue';
import * as naive from 'naive-ui';
import { render as toolbarRender } from './Toolbar.js';
import { render as scanBarRender } from './ScanBar.js';

const doc = globalThis.__happyDoc;
const IconStub = defineComponent({ name: 'IconStub', render: () => h('i') });

const warnings = [];
const realWarn = console.warn;
console.warn = (...a) => {
    const s = a.map(String).join(' ');
    if (s.includes('Duplicate keys')) warnings.push(s.slice(0, 80));
    else realWarn(...a);
};

function mount(name, render) {
    const scanning = ref(false);
    const cancelling = ref(false);
    const ctx = {
        scanning, cancelling,
        scanDone: ref(3), scanPending: ref(7),
        openStack: ref([{ name: 'videos', path: 'H:/videos', mode: 'cover' }]),
        readOnlyLevel: computed(() => false),
        fileList: ref([{ name: 'a' }]), searchText: ref(''), searchInput: ref(null),
        startScan: () => { scanning.value = true; },
        onScanCancel: () => { ctx.cancelCalls++; cancelling.value = true; },
        showHistory: () => { }, onRefresh: () => { },
        Search: IconStub, Refresh: IconStub, FootstepsOutline: IconStub,
        cancelCalls: 0
    };
    const container = doc.createElement('div');
    doc.body.appendChild(container);
    const app = createApp({
        render: () => h(naive.NConfigProvider, null, {
            default: () => h(defineComponent({ name, setup: () => ctx, render }))
        })
    });
    for (const [k, v] of Object.entries(naive)) {
        if (/^N[A-Z]/.test(k)) app.component(k.replace(/^N/, 'n-').replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase(), v);
    }
    app.component('IconStub', IconStub);
    app.mount(container);
    return { ctx, container };
}

const btnTexts = c => Array.from(c.querySelectorAll('button')).map(b => (b.textContent || '').trim()).filter(Boolean);
const disabledOf = c => Array.from(c.querySelectorAll('button')).map(b => b.disabled);

/** 只看骨架：元素序列 + 文本，忽略**所有**属性（允许变的只有 disabled / class） */
const skeleton = c => c.innerHTML
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<([a-zA-Z0-9-]+)([^>]*?)(\/?)>/g, '<$1$3>')
    .replace(/\s+/g, ' ')
    .trim();

(async () => {
    const t = mount('Toolbar', toolbarRender);
    await nextTick();
    const baseline = skeleton(t.container);
    console.log('\n### 工具条（改后）');
    console.log('  按钮    :', JSON.stringify(btnTexts(t.container)));
    console.log('  禁用    :', JSON.stringify(disabledOf(t.container)));

    let shapeChanged = 0, dupes = 0, clickable = 0;
    for (let i = 0; i < 30; i++) {
        t.ctx.scanning.value = !t.ctx.scanning.value;
        await nextTick();
        if (skeleton(t.container) !== baseline) shapeChanged++;
        if ((btnTexts(t.container).join('|').match(/重读这一片/g) || []).length !== 1) dupes++;
        if (t.ctx.scanning.value) {
            const txt = btnTexts(t.container), dis = disabledOf(t.container);
            if (['补全这一片', '重读这一片'].some(l => { const i2 = txt.indexOf(l); return i2 >= 0 && dis[i2] === false; })) clickable++;
        }
    }
    console.log(`  30 次来回切 scanning：`);
    console.log(`    · DOM 骨架变化        : ${shapeChanged} 次（应 0）`);
    console.log(`    · 「重读这一片」重复  : ${dupes} 次（应 0）`);
    console.log(`    · 扫描中仍可点入口    : ${clickable} 次（应 0）`);
    console.log('  → ' + (shapeChanged + dupes + clickable === 0 ? 'PASS 工具条完全恒定' : 'FAIL'));
    t.ctx.scanning.value = false; await nextTick();
    console.log('  收尾按钮 :', JSON.stringify(btnTexts(t.container)));

    const sb = mount('ScanBar', scanBarRender);
    await nextTick();
    let barBad = 0;
    for (let i = 0; i < 30; i++) {
        sb.ctx.scanning.value = true; sb.ctx.cancelling.value = false; await nextTick();
        if (sb.container.querySelectorAll('.scan-bar').length !== 1) barBad++;
        if (i === 0) {
            sb.container.querySelectorAll('button')[0].click();
            await nextTick();
            console.log('\n### 状态条：点一次「取消」之后');
            console.log('  按钮文字     :', JSON.stringify(Array.from(sb.container.querySelectorAll('button')).map(b => (b.textContent || '').trim())));
            console.log('  按钮 disabled:', JSON.stringify(Array.from(sb.container.querySelectorAll('button')).map(b => b.disabled)));
            console.log('  onScanCancel :', sb.ctx.cancelCalls, '次');
            console.log('  提示         :', JSON.stringify((sb.container.querySelector('.scan-hint')?.textContent || '').trim()));
        }
        sb.ctx.scanning.value = false; await nextTick();
        if (sb.container.querySelectorAll('.scan-bar').length !== 0) barBad++;
    }
    console.log(`\n### 状态条 30 轮出现/消失：异常 ${barBad} 次（应 0）`);

    console.warn = realWarn;
    console.log('\n### Vue「Duplicate keys」警告总数：', warnings.length, '（改后应 0）');
})();
