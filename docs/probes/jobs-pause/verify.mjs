/**
 * 纯逻辑探针：job 状态机（暂停 / 继续 / 终止 / 追加 reopen）。
 * 只 import jobs.ts（它只依赖 node:crypto，不需要 electron），零读盘、零窗口。
 *
 *   node docs/probes/jobs-pause/verify.mjs
 *
 * 为什么值得跑：暂停闸门有一段"必须先看队列再看闸门"的时序，
 * 靠读代码很容易漏掉死锁 / 收尾卡住这两种失败形态。
 */
import assert from 'node:assert/strict';
import {
    createJob, pauseJob, resumeJob, cancelJob, reopenJob, finishJob, getJob, snapshotJob,
} from '../../../electron/server/assistant/jobs.ts';

const out = [];
const ok = (name, fn) => {
    try { fn(); out.push(`PASS ${name}`); } catch (e) { out.push(`FAIL ${name} :: ${e.message}`); }
};

const R = (j) => /** @type {any} */ (j);

// 1. 暂停后闸门挂住；继续后放行
await (async () => {
    const job = R(createJob('grab', 10));
    // 未暂停：wait() 必须立刻过（否则正常抓取会被自己的闸门卡死）
    const t0 = Date.now();
    await job.gate.wait();
    ok('未暂停时 wait() 立刻通过', () => assert.ok(Date.now() - t0 < 500));

    assert.equal(pauseJob(job.id), true);
    let released = false;
    const gate = job.gate.wait().then(() => { released = true; });
    await new Promise(r => setTimeout(r, 20));
    ok('暂停后 gate.wait() 挂住', () => assert.equal(released, false));
    assert.equal(getJob(job.id).status, 'paused');

    assert.equal(resumeJob(job.id), true);
    await gate;
    ok('继续后 gate.wait() 放行', () => assert.equal(released, true));
})();

// 2. 暂停态下终止：must 收尾（finishJob 原来只认 running，会卡在 paused）
await (async () => {
    const job = R(createJob('grab', 10));
    pauseJob(job.id);
    assert.equal(cancelJob(job.id), true, '暂停中应允许终止');
    let released = false;
    await job.gate.wait().then(() => { released = true; });
    ok('终止也放行闸门（否则 worker 永不返回）', () => assert.equal(released, true));
    finishJob(job, 'cancelled', 'x');
    ok('从 paused 收尾成功', () => {
        assert.equal(getJob(job.id).status, 'cancelled');
        assert.ok(getJob(job.id).endedAt);
    });
    ok('已结束的任务不能再暂停/终止', () => {
        assert.equal(pauseJob(job.id), false);
        assert.equal(cancelJob(job.id), false);
    });
})();

// 3. 结果保留：终止不清空 rows
await (async () => {
    const job = R(createJob('grab', 3));
    job.rows.push({ writeRel: 'a/b.jpg', status: 'ok', coverUrl: 'http://x/1.jpg' });
    cancelJob(job.id);
    finishJob(job, 'cancelled', '已终止：命中 1 张（可以写入）');
    const snap = snapshotJob(job);
    ok('终止后 rows 保留', () => assert.equal(snap.rows.length, 1));
})();

// 4. reopen：状态回 running、controller 换新（abort 过的 signal 永远 aborted）
await (async () => {
    const job = R(createJob('grab', 2));
    cancelJob(job.id);
    finishJob(job, 'cancelled', '');
    const old = job.controller;
    reopenJob(job);
    ok('reopen 后回到 running', () => assert.equal(getJob(job.id).status, 'running'));
    ok('reopen 换掉 controller（旧的已 aborted）', () => {
        assert.notEqual(job.controller, old);
        assert.equal(job.controller.signal.aborted, false);
    });
    ok('reopen 后可以重新暂停/终止', () => {
        assert.equal(pauseJob(job.id), true);
        assert.equal(cancelJob(job.id), true);
    });
})();

// 5. 未知 id 一律 false，不抛
ok('未知 id 不炸', () => {
    assert.equal(pauseJob('nope'), false);
    assert.equal(resumeJob('nope'), false);
    assert.equal(cancelJob('nope'), false);
});

console.log(out.join('\n'));
console.log(`\n${out.filter(l => l.startsWith('PASS')).length}/${out.length} PASS`);
process.exit(out.some(l => l.startsWith('FAIL')) ? 1 : 0);
