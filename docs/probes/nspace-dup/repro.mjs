/**
 * 复现：naive-ui 2.45.3 的 n-space + 子元素个数变化 → DOM 多出重复节点
 *
 * 运行（先跑 templates.cjs 生成 render，再打包，再执行；见 run.sh）
 *   node docs/probes/nspace-dup/templates.cjs
 *   esbuild repro.mjs --bundle --platform=node --format=cjs --outfile=repro.cjs \
 *     --external:happy-dom --alias:vue=... --alias:naive-ui=... --define:process.env.NODE_ENV='"development"'
 *   node repro.cjs
 */
import './dom-shim.cjs';
import { createApp, defineComponent, h, ref, nextTick, computed } from 'vue';
import * as naive from 'naive-ui';
import { render as oldToolbar } from './OldToolbar.js';
import { render as minSpace } from './MinimalSpace.js';
import { render as minSpaceNoWrap } from './MinimalSpaceNoWrap.js';
import { render as minDiv } from './MinimalDiv.js';

const doc = globalThis.__happyDoc;
const IconStub = defineComponent({ name: 'IconStub', render: () => h('i') });

function mount(name, render) {
    const scanning = ref(false);
    const ctx = {
        scanning,
        scanDone: ref(0), scanPending: ref(0),
        openStack: ref([{ name: 'videos', path: 'H:/videos', mode: 'cover' }]),
        readOnlyLevel: computed(() => false),
        fileList: ref([{ name: 'a' }]), searchText: ref(''), searchInput: ref(null),
        dir: ref('H:/videos'),
        startScan: () => { scanning.value = true; },
        onScanCancel: () => { ctx.cancelCalls++; },
        showHistory: () => { }, onRefresh: () => { }, noop: () => { },
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
    const warnings = [];
    return { ctx, container, warnings };
}

const texts = c => Array.from(c.querySelectorAll('button')).map(b => (b.textContent || '').trim()).filter(Boolean);

async function compare(label, render, expOff, expOn) {
    const m = mount(label, render);
    // 收集 Vue 的「Duplicate keys」警告（Vue 走 console.warn）
    const realWarn = console.warn;
    console.warn = (...a) => {
        const s = a.map(String).join(' ');
        if (s.includes('Duplicate keys')) m.warnings.push(s.slice(0, 60));
        else realWarn(...a);
    };
    const bad = [];
    for (let i = 0; i < 30; i++) {
        m.ctx.scanning.value = false; await nextTick();
        const off = texts(m.container);
        if (JSON.stringify(off) !== JSON.stringify(expOff)) bad.push(`off#${i}=${JSON.stringify(off)}`);
        m.ctx.scanning.value = true; await nextTick();
        const on = texts(m.container);
        if (JSON.stringify(on) !== JSON.stringify(expOn)) bad.push(`on#${i}=${JSON.stringify(on)}`);
    }
    m.ctx.scanning.value = false; await nextTick();
    console.warn = realWarn;
    console.log(
        `\n### ${label}\n` +
        `  期望  off=${JSON.stringify(expOff)}  on=${JSON.stringify(expOn)}\n` +
        `  30 轮切换：${bad.length === 0 ? 'PASS' : 'FAIL ' + bad.length + ' 次'}\n` +
        (bad.length ? `  首个异常：${bad[0]}\n` : '') +
        `  Vue「Duplicate keys」警告：${m.warnings.length} 条`
    );
    return m;
}

(async () => {
    await compare('S1 最小复现 n-space（默认 wrap-item）', minSpace, ['ALPHA', 'BETA'], ['CANCEL']);
    await compare('S2 同结构 :wrap-item="false"', minSpaceNoWrap, ['ALPHA', 'BETA'], ['CANCEL']);
    await compare('S3 对照组：裸 div', minDiv, ['ALPHA', 'BETA'], ['CANCEL']);
    const s4 = await compare('S4 改前真实工具条（n-space 原样）', oldToolbar, ['补全这一片', '重读这一片'], ['取消']);

    /* ---- 验尸：全新实例，只切**一次**，看那一屏长什么样 ---- */
    console.log('\n### 验尸 A：改前结构，点一次「补全这一片」再扫完，那一屏的按钮序列');
    const fresh = mount('fresh', oldToolbar);
    fresh.ctx.scanning.value = true; await nextTick();
    fresh.ctx.scanning.value = false; await nextTick();
    console.log('  扫完那一帧 :', JSON.stringify(texts(fresh.container)));
    console.log('  用户截图就是这一屏：取消 / 补全这一片 / 重读这一片 / 重读这一片');

    /* ---- 验尸 B：扫描中「取消」到底有几个、点了有没有反应 ---- */
    console.log('\n### 验尸 B：改前结构，扫描中「取消」按钮有几个');
    const fresh2 = mount('fresh2', oldToolbar);
    fresh2.ctx.scanning.value = true; await nextTick();
    fresh2.ctx.scanning.value = false; await nextTick();
    fresh2.ctx.scanning.value = true; await nextTick();
    const cancelBtns = Array.from(fresh2.container.querySelectorAll('button'))
        .filter(b => (b.textContent || '').trim() === '取消');
    fresh2.ctx.cancelCalls = 0;
    for (const b of cancelBtns) { try { b.click(); } catch (e) { } }
    await nextTick();
    console.log(`  扫描中「取消」按钮个数 : ${cancelBtns.length}（应为 1）`);
    console.log(`  逐个点击后 onScanCancel 触发 ${fresh2.ctx.cancelCalls} 次`);

    /* ---- 累积：每切一次多一个，最多堆到多少 ---- */
    console.log('\n### 验尸 C：反复切换 30 次，重复按钮会堆到多少');
    const acc = mount('acc', oldToolbar);
    for (let i = 0; i < 30; i++) {
        acc.ctx.scanning.value = true; await nextTick();
        acc.ctx.scanning.value = false; await nextTick();
    }
    console.log('  30 轮之后「取消」按钮个数 :', texts(acc.container).filter(t => t === '取消').length);
})();
