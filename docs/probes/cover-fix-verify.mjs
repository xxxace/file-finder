/**
 * 补封面与失败抽帧逻辑验证探针
 * 测试目标：
 * 1. queue.ts 的 runPaced 并发调用必须按 HOST_GAP_MS 间隔启动，不可同时突发发起
 * 2. coverModel.ts 的 buildCoverItems：
 *    - 当卡片已有抽帧时，后续抓取返回 no-match / error 不能覆盖/丢失已有的抽帧（防止多抽）
 *    - 当抽帧失败时，显示"抽帧失败"，不能误显"抓取失败"
 *    - 当已有抽帧时，后续抓取成功获取到真实 coverUrl 则正常升级为已抓到
 */
import { build } from 'esbuild';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const stubPath = path.resolve(repo, 'docs/probes/faces/electron-stub.mjs');

let pass = 0, fail = 0;
const check = (label, ok, detail = '') => {
    ok ? pass++ : fail++;
    console.log(`  ${ok ? '✅' : '❌'} ${label}${ok || !detail ? '' : ` — ${detail}`}`);
};

async function load(entry, tag) {
    const cacheDir = path.join(repo, 'node_modules/.cache');
    await fsp.mkdir(cacheDir, { recursive: true });
    const outfile = path.join(cacheDir, `${tag}-${Date.now()}.mjs`);
    await build({
        entryPoints: [path.join(repo, entry)],
        bundle: true, platform: 'node', format: 'esm', target: 'node22',
        outfile, logLevel: 'silent', packages: 'external',
        alias: { electron: stubPath },
    });
    return import(pathToFileURL(outfile).href);
}

async function testCoverModel() {
    console.log('\n--- 测试 1: coverModel buildCoverItems 逻辑 ---');
    const { buildCoverItems } = await load('src/views/FileFinder/assistant/coverModel.ts', 'ff-cover-model');

    const target = {
        kind: 'file',
        dir: 'ACT',
        name: 'TST-001',
        writeRel: 'ACT/TST-001.jpg',
        query: 'TST-001',
    };

    // 1. 卡片已有帧缓存 (frameRows)
    const frameRow = {
        writeRel: 'ACT/TST-001.jpg',
        status: 'ok',
        coverUrl: null,
        frame: true,
        frameFile: 'k16_a0_p1_s0_nx.jpg',
        pct: 1,
        attempt: 0,
        skipped: 0,
    };

    // 后续抓取失败 (例如 javbus 上没有这片子)
    const missGrabRow = {
        writeRel: 'ACT/TST-001.jpg',
        status: 'no-match',
        coverUrl: null,
        hitSite: null,
    };

    // 传入顺序：frameRow（以前已抽帧） + missGrabRow（刚才抓取未找到）
    const itemsWithMiss = buildCoverItems(
        [target],
        [frameRow, missGrabRow],
        [],
        { live: false, selected: new Set() }
    );

    const card = itemsWithMiss[0];
    check('已有抽帧的卡片，后续抓取未命中(no-match)不能丢失抽帧', card.state === 'ok' && !!card.frame, `got state=${card?.state}, frame=${JSON.stringify(card?.frame)}`);
    check('保留原抽帧文件名', card.frame?.file === 'k16_a0_p1_s0_nx.jpg', `got ${card.frame?.file}`);

    // 2. 如果后续抓取成功了，应该正常升级为站点封面
    const hitGrabRow = {
        writeRel: 'ACT/TST-001.jpg',
        status: 'ok',
        coverUrl: 'https://example.com/cover.jpg',
        hitSite: 'javbus',
    };
    const itemsWithHit = buildCoverItems(
        [target],
        [frameRow, hitGrabRow],
        [],
        { live: false, selected: new Set() }
    );
    const hitCard = itemsWithHit[0];
    check('已有抽帧的卡片，后续抓取成功(ok)正常升级为站点封面', hitCard.state === 'ok' && hitCard.coverUrl === 'https://example.com/cover.jpg' && hitCard.site === 'javbus');

    // 3. 抽帧失败时（无有效帧且无封面），应标明"抽帧失败"而不是"抓取失败"
    const failedFrameRow = {
        writeRel: 'ACT/TST-001.jpg',
        status: 'error',
        coverUrl: null,
        hitSite: null,
        frame: true,
        frameFile: '',
        why: 'no-frame',
    };
    const itemsWithFailedFrame = buildCoverItems(
        [target],
        [failedFrameRow],
        [],
        { live: false, selected: new Set() }
    );
    const failedCard = itemsWithFailedFrame[0];
    check('抽帧失败时显示"抽帧失败"而非"抓取失败"', failedCard.state === 'error' && failedCard.badge === '抽帧失败', `got badge=${failedCard.badge}`);
}

async function testQueuePacing() {
    console.log('\n--- 测试 2: queue.ts runPaced 并发错峰与限速 ---');
    const { runPaced } = await load('electron/server/assistant/queue.ts', 'ff-queue');

    const startTimes = [];
    const tasks = [0, 1, 2].map(i =>
        runPaced('test.com', async () => {
            startTimes.push(Date.now());
            await new Promise(r => setTimeout(r, 200));
        })
    );

    await Promise.all(tasks);

    check('所有并发请求均正常执行', startTimes.length === 3);
    const gap1 = startTimes[1] - startTimes[0];
    const gap2 = startTimes[2] - startTimes[1];
    console.log(`  间隔 1: ${gap1}ms, 间隔 2: ${gap2}ms (目标 >= 1150ms, HOST_GAP_MS = 1200ms)`);
    check('并发发起的请求 1 与请求 2 启动间隔 >= 1150ms', gap1 >= 1150, `got ${gap1}ms`);
    check('并发发起的请求 2 与请求 3 启动间隔 >= 1150ms', gap2 >= 1150, `got ${gap2}ms`);
}

async function main() {
    try {
        await testCoverModel();
        await testQueuePacing();
    } catch (e) {
        console.error('测试异常:', e);
        fail++;
    }
    console.log(`\n最终结果: ${pass} passed, ${fail} failed`);
    if (fail) process.exit(1);
}

main();
