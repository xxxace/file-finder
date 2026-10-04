/**
 * 最小实验：**顺序即依赖** —— `noteIntent()` 放在会改变列表的动作之前，意图会被吃掉。
 *
 * 复刻 2026-10-04 那个真 bug 的**精确时序**：
 *   `enterScreen` 原本的写法是
 *       history.push(...) → noteIntent() → searchText.value = '' → fetchFolder()
 *   而 `fileList = computed(() => filterByName(dataSource.value, searchText.value))`
 *   ⇒ `searchText` 一变，列表**立刻**变一次 ⇒ 指纹变 ⇒ watch 触发 ⇒ armed 被消费
 *   ⇒ 等 fetchFolder 成功、`dataSource` 真正换新时，armed 已是 false ⇒ **焦点永不落**。
 *   而"点一下"能用，是因为 `onItemClick → focusCursor` 直写 `cursorKey`，不依赖 watch。
 *
 * 跑的是**真 Vue**（@vue/reactivity），不是复刻的判据。
 * ⚠️ 上一版这个 bug 之所以连修两轮都没好，正是因为我在探针里**手抄**了一份判据
 * （改探针不改真代码，回退真源码仍全绿）。⇒ 这份直接用真 Vue。
 */
// ⚠️ 用**相对本文件**的 URL 解析，不用绝对路径：绝对路径含真机目录名
// （脱敏铁律：入库文本不许出现真机路径），且换机/换盘就失效。
const REACTIVITY = new URL('../../../node_modules/@vue/reactivity/dist/reactivity.cjs.js', import.meta.url).href;
const { ref, computed, watch } = await import(REACTIVITY);

const tick = () => new Promise(r => setTimeout(r, 0));

// 与 index.vue 同构：keyOf 含 dir ⇒ 换目录时指纹必变
const keyOf = f => f.dir + '/' + f.name;

/** 一套最小复现：fileList + armed + 指纹 watch，order 决定 enterScreen 里动作的先后。 */
function makeRun(getList) {
    const state = {
        dataSource: ref([{ dir: '/a', name: 'a1' }, { dir: '/a', name: 'a2' }, { dir: '/a', name: 'a3' }]),
        searchText: ref(''),
    };
    const fileList = computed(() => getList(state.dataSource.value, state.searchText.value));
    let armed = false;
    const noteIntent = () => { armed = true; };
    const takeIntent = () => { const had = armed; armed = false; return had; };
    const fp = () => {
        const l = fileList.value;
        return l.length ? l.length + ':' + keyOf(l[0]) : '';
    };
    let activated = 0;
    watch(fp, (v) => { if (v && takeIntent()) activated++; });
    return {
        state, noteIntent, takeIntent,
        get activated() { return activated; },
        get armedLeft() { return armed; },
    };
}

(async () => {
    let pass = 0, fail = 0;
    const check = (l, c, d) => { console.log(`  ${c ? 'PASS' : 'FAIL'}  ${l}${d ? '   → ' + d : ''}`); c ? pass++ : fail++; };

    // ── 场景 1· 意图在 clearSearch **之前**（= 原来的写法，真bug）────────────
    {
        // 搜索词真的参与过滤（还原 index.vue 的 filterByName）
        const r = makeRun((list, q) => (q ? list.filter(f => f.name.includes(q)) : list));
        r.state.searchText.value = 'a1';              // 先有搜索词（列表被筛过）
        await tick();
        r.noteIntent();                                // ← 原来的位置（在清搜索词之前）
        r.state.searchText.value = '';                  // 清空 ⇒ 列表变一次 ⇒ 意图被吃掉
        await tick();
        const afterClear = r.activated;
        r.state.dataSource.value = [{ dir: '/b', name: 'b1' }, { dir: '/b', name: 'b2' }];
        await tick();
        check('场景1（意图在清搜索词之前）：意图被吃掉 ⇒ 加载完**不**落焦点',
            afterClear === 1 && r.activated === 1, `清搜索词时消费了 ${afterClear} 次，真数据到后累计 ${r.activated}`);
        check('★这正是"加了初始化还是要点一下"的机制', r.activated === 1, 'armed 被提前消费');
    }

    // ── 场景 2 · 意图在 clearSearch **之后**（= 修好的写法）────────────────
    {
        const r = makeRun((list, q) => (q ? list.filter(f => f.name.includes(q)) : list));
        r.state.searchText.value = 'a1';
        await tick();
        r.state.searchText.value = '';                  // 先清（这次没人要意图）
        await tick();
        r.noteIntent();                                // ← 修好的位置
        r.state.dataSource.value = [{ dir: '/b', name: 'b1' }, { dir: '/b', name: 'b2' }];
        await tick();
        check('★场景2（意图在清搜索词之后）：意图留到加载完 ⇒ 自动落焦点',
            r.activated === 1, `activated=${r.activated}`);
    }

    // ── 场景 3 · 没有搜索词时，两种顺序都该落焦点（清搜索词不改变列表）────
    {
        const mk = (order) => {
            const r = makeRun((list) => list);
            order.forEach(s => {
                if (s === 'intent') r.noteIntent();
                if (s === 'data') r.state.dataSource.value = [{ dir: '/b', name: 'b1' }];
            });
            return tick().then(() => r.activated);
        };
        const a = await mk(['intent', 'data']);
        const b = await mk(['data', 'intent']);   // 对照：意图晚于数据（不该落）
        check('无搜索词时：意图在数据前 ⇒ 落焦点', a === 1, `activated=${a}`);
        check('（对照）意图在数据后 ⇒ 不落（那时已经没东西可激活了）', b === 0, `activated=${b}`);
    }

    // ── 场景 4 · 连续两次 enterScreen（快速点两个目录）────────────────────
    {
        const r = makeRun((list) => list);
        r.noteIntent();
        r.state.dataSource.value = [{ dir: '/x', name: 'x1' }];
        await tick();
        const first = r.activated;
        r.noteIntent();
        r.state.dataSource.value = [{ dir: '/y', name: 'y1' }];
        await tick();
        check('连续两次 enterScreen：两次都落焦点', first === 1 && r.activated === 2,
            `第一次 ${first} / 累计 ${r.activated}`);
        check('意图每次用掉即清（不会残留到下一屏）', r.armedLeft === false, String(r.armedLeft));
    }

    // ── 场景 5 · 同屏刷新（key 不变）⇒ 不该落焦点 ────────────────────────
    {
        const r = makeRun((list) => list);
        r.noteIntent();
        // 刷新：同样的条目**新数组**（引用变、key 不变）
        r.state.dataSource.value = [{ dir: '/a', name: 'a1' }, { dir: '/a', name: 'a2' }, { dir: '/a', name: 'a3' }];
        await tick();
        check('同屏刷新（key 不变）⇒ 不落焦点（不抢用户手上的）', r.activated === 0, `activated=${r.activated}`);
    }

    console.log(`\n─────────────────────────────\n${pass} PASS / ${fail} FAIL\n`);
    process.exit(fail ? 1 : 0);
})();
