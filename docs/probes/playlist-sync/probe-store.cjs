/**
 * 收藏夹信息同步 · 存储层探针
 * ---------------------------------------------------------------------------
 * 测试 `patchItemByLocation` 与 `reconcileItemSnapshots`。
 * 使用临时测试目录，不碰用户真实 playlists.json。
 * 跑法：node docs/probes/playlist-sync/probe-store.cjs
 */
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFileSync } = require('child_process');

const PROBE = __dirname;
const ROOT = path.resolve(PROBE, '../../..');
const ESBUILD = path.join(ROOT, 'node_modules', 'esbuild', 'bin', 'esbuild');

function bundle(rel) {
    const out = path.join(os.tmpdir(), `ff-${path.basename(rel, '.ts')}-${process.pid}.cjs`);
    execFileSync(process.execPath, [
        ESBUILD, path.join(ROOT, rel),
        '--bundle', '--platform=node', '--format=cjs',
        `--outfile=${out}`, '--external:electron', '--log-level=error',
    ], { stdio: 'inherit' });
    return out;
}

const storeBundle = bundle('electron/server/playlistStore.ts');
const {
    loadPlaylists,
    addItems,
    patchItemByLocation,
    reconcileItemSnapshots,
} = require(storeBundle);

async function run() {
    const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-test-pl-store-'));
    let failures = 0;
    const test = (name, cond) => {
        if (cond) {
            console.log(`PASS  ${name}`);
        } else {
            console.error(`FAIL  ${name}`);
            failures++;
        }
    };

    try {
        // 1. 初始化并添加测试条目
        const [pl] = await loadPlaylists(tmpDataDir);
        await addItems(tmpDataDir, pl.id, [
            {
                id: 'it_1',
                serial: 'DISK_A',
                relPath: 'movies',
                name: 'IPX-123',
                ext: 'mp4',
                type: 'video',
                size: 1000,
                sig: 'sig_old',
                addedAt: 1000,
            },
            {
                id: 'it_2',
                serial: 'DISK_A',
                relPath: 'movies',
                name: 'SSIS-456',
                ext: 'mp4',
                type: 'video',
                size: 2000,
                sig: 'sig_2',
                addedAt: 1000,
            },
        ]);

        // 2. patchItemByLocation 测试：精确命中
        const ok = await patchItemByLocation(tmpDataDir, 'DISK_A', 'movies', 'IPX-123', {
            relPath: 'movies/IPX-123',
            type: 'image',
            sig: 'sig_new',
            files: [{ name: 'IPX-123.mp4', size: 1000 }],
        });
        test('patchItemByLocation 返回 true 表示成功修改', ok === true);

        const [plUpdated] = await loadPlaylists(tmpDataDir);
        const it1 = plUpdated.items.find(i => i.id === 'it_1');
        const it2 = plUpdated.items.find(i => i.id === 'it_2');

        test('it_1 的 relPath 升级为 movies/IPX-123', it1 && it1.relPath === 'movies/IPX-123');
        test('it_1 的 type 升级为 image', it1 && it1.type === 'image');
        test('it_1 的 sig 更新为 sig_new', it1 && it1.sig === 'sig_new');
        test('it_1 的 files 补全为分卷列表', it1 && it1.files && it1.files.length === 1);
        test('it_2 未受影响，relPath 保持 movies', it2 && it2.relPath === 'movies');

        // 3. patchItemByLocation 测试：未命中返回 false
        const missed = await patchItemByLocation(tmpDataDir, 'DISK_A', 'movies', 'NON_EXISTENT', { sig: 'xxx' });
        test('patchItemByLocation 未匹配返回 false', missed === false);

        // 4. reconcileItemSnapshots 测试：批量处理
        const changedCount = await reconcileItemSnapshots(tmpDataDir, (item) => {
            if (item.id === 'it_2') {
                return { changed: true, item: { ...item, size: 2500, sig: 'sig_2_reconciled' } };
            }
            return { changed: false, item };
        });
        test('reconcileItemSnapshots 正确统计更新条目数 (1)', changedCount === 1);

        const [plReconciled] = await loadPlaylists(tmpDataDir);
        const it2Reconciled = plReconciled.items.find(i => i.id === 'it_2');
        test('it_2 的 size 和 sig 被成功更新', it2Reconciled && it2Reconciled.size === 2500 && it2Reconciled.sig === 'sig_2_reconciled');

    } finally {
        fs.rmSync(tmpDataDir, { recursive: true, force: true });
    }

    if (failures > 0) {
        process.exit(1);
    }
}

run().catch((err) => {
    console.error(err);
    process.exit(1);
});
