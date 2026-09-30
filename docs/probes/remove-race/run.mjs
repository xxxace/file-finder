/**
 * 模型探针：「删除」要不要进唯一写入链。
 *
 * ⚠️ **验的是机制**（同一主键上的写操作必须串行），**不是真服务端的端到端时序**。
 * 真实现见 `electron/server/index.ts` 的 `queueCacheWrite` / `removeHistoryBatch`，
 * 这个文件把两者的**语义**逐字复刻成最小可运行版本，用断言对比"进链 / 不进链"两种写法。
 * （复刻对照是 superpowers 的 verify-async-claims 手法：对并发/时序下结论前，先把逻辑跑起来。）
 *
 * 复算：node docs/probes/remove-race/run.mjs
 */

const db = new Map();
const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * queueCacheWrite 的同构实现 —— 语义照抄真代码：
 *   · 同一个键上一条链；`prev.then(task, task)` 让前一个任务失败也照样接着跑；
 *   · 链尾只挂"不会 reject"的尾巴，跑空就把槽位收掉。
 */
const chains = new Map();
function queueCacheWrite(key, task) {
    const prev = chains.get(key) ?? Promise.resolve();
    const run = prev.then(task, task);
    const tail = run.then(() => undefined, () => undefined);
    chains.set(key, tail);
    void tail.then(() => { if (chains.get(key) === tail) chains.delete(key); });
    return run;
}

/** 扫描写缓存：读盘（慢）→「先删后插」。真代码里这整段包在 queueCacheWrite 里 */
async function scan(key, { inChain }) {
    const work = async () => {
        await sleep(30);            // ← 读盘那一段。就是这个 await 打开了交错窗口
        db.delete(key);
        db.set(key, { fresh: true });
    };
    return inChain ? queueCacheWrite(key, work) : work();
}

/** 用户删除：按主键删。真代码修复前是 `nedb.remove({ _id: { $in } })`（完全绕过链） */
async function remove(key, { inChain }) {
    const work = async () => { db.delete(key); };
    return inChain ? queueCacheWrite(key, work) : work();
}

async function run(label, removeInChain) {
    db.clear();
    chains.clear();

    const KEY = 'AAAA1111\u0000示例目录\u0000cover';
    db.set(KEY, { fresh: false });          // 库里已有一条旧记录

    const s = scan(KEY, { inChain: true }); // 扫描照常走链
    await sleep(10);                        // 让它进入"正在读盘"这个窗口
    const r = remove(KEY, { inChain: removeInChain });   // 此刻用户点了删除
    await Promise.all([s, r]);

    return { 版本: label, '删完之后库里还有这条记录': db.has(KEY) };
}

const A = await run('A 修复前：删除**不进**链（直接按 _id 删）', false);
const B = await run('B 修复后：删除也进同一条链', true);

console.log(JSON.stringify([A, B], null, 2));

const reproduced = A['删完之后库里还有这条记录'] === true;
const fixed = B['删完之后库里还有这条记录'] === false;

console.log('');
console.log(reproduced ? '✅ 版本 A 复现了缺陷：扫描在删之后把记录插了回来（"删了又回来"）'
    : '❌ 版本 A 没复现出缺陷 —— 探针的时序假设不成立，结论不能用');
console.log(fixed ? '✅ 版本 B 修复成立：删除排在扫描之后执行，记录不会再自己回来'
    : '❌ 版本 B 仍然丢不掉 —— 串行链没起作用');
process.exit(reproduced && fixed ? 0 : 1);
