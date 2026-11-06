/**
 * 收藏夹信息同步 · 助手联动探针
 * ---------------------------------------------------------------------------
 * 测试 `syncPlaylistsAfterApply`：
 * 验证当单文件视频被助手打包整理为同名文件夹，或更新封面后，
 * 收藏夹能主动完成路径与快照同步。
 * 跑法：node docs/probes/playlist-sync/probe-apply-hook.cjs
 */
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFileSync } = require('child_process');

const PROBE = __dirname;
const ROOT = path.resolve(PROBE, '../../..');
const ESBUILD = path.join(ROOT, 'node_modules', 'esbuild', 'bin', 'esbuild');

// Stub electron module for probe runtime
const Module = require('module');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
    if (req === 'electron') return path.join(os.tmpdir(), 'electron-stub.js');
    if (req.startsWith('@ffmpeg-installer') || req.startsWith('@ffprobe-installer')) return path.join(os.tmpdir(), 'bin-stub.js');
    return origResolve.call(this, req, ...rest);
};
fs.writeFileSync(path.join(os.tmpdir(), 'electron-stub.js'), 'module.exports={app:{getPath:()=>require("os").tmpdir()},net:{},nativeImage:{},session:{}};');
fs.writeFileSync(path.join(os.tmpdir(), 'bin-stub.js'), 'module.exports={path:""};');

function bundle(rel) {
    const out = path.join(os.tmpdir(), `ff-${path.basename(rel, '.ts')}-${process.pid}.cjs`);
    execFileSync(process.execPath, [
        ESBUILD, path.join(ROOT, rel),
        '--bundle', '--platform=node', '--format=cjs',
        `--outfile=${out}`, '--external:electron', '--external:@ffprobe-installer/*', '--external:@ffmpeg-installer/*', '--log-level=error',
    ], { stdio: 'inherit' });
    return out;
}

const storeBundle = bundle('electron/server/playlistStore.ts');
const applyBundle = bundle('electron/server/assistant/apply.ts');

const { loadPlaylists, addItems } = require(storeBundle);
const { syncPlaylistsAfterApply } = require(applyBundle);

async function run() {
    const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-test-apply-hook-'));
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
        const [pl] = await loadPlaylists(tmpDataDir);
        await addItems(tmpDataDir, pl.id, [
            {
                id: 'it_file',
                serial: 'DISK_XYZ',
                relPath: 'movies',
                name: 'MIDE-111',
                ext: 'mp4',
                type: 'video',
                size: 4000,
                sig: 'sig_raw',
                addedAt: 1000,
            },
            {
                id: 'it_folder',
                serial: 'DISK_XYZ',
                relPath: 'movies/MIDE-222',
                name: 'MIDE-222',
                type: 'image',
                size: 6000,
                sig: 'sig_cover_old',
                files: [{ name: 'MIDE-222.mp4', size: 6000 }],
                addedAt: 1000,
            },
        ]);

        const mockGroups = [
            {
                kind: 'file',
                query: 'MIDE-111',
                layerDir: 'movies',
                folderRel: 'movies/MIDE-111',
            },
            {
                kind: 'dir',
                query: 'MIDE-222',
                layerDir: 'movies/MIDE-222',
                folderRel: '',
            },
        ];

        // 模拟查找缓存的函数
        const mockFindCache = async (serial, relPath) => {
            if (serial === 'DISK_XYZ' && relPath === 'movies') {
                return {
                    serial,
                    relPath,
                    data: [
                        {
                            dir: 'movies/MIDE-111',
                            name: 'MIDE-111',
                            type: 'image',
                            sig: 'sig_new_111',
                            size: 4000,
                            files: [{ name: 'MIDE-111.mp4', size: 4000 }],
                        },
                        {
                            dir: 'movies/MIDE-222',
                            name: 'MIDE-222',
                            type: 'image',
                            sig: 'sig_new_222',
                            size: 6000,
                            files: [{ name: 'MIDE-222.mp4', size: 6000 }],
                        },
                    ],
                };
            }
            return null;
        };

        await syncPlaylistsAfterApply(tmpDataDir, 'DISK_XYZ', mockGroups, mockFindCache);

        const diskJson = JSON.parse(fs.readFileSync(path.join(tmpDataDir, 'playlists.json'), 'utf8'));
        const [updatedPl] = diskJson;
        const it1 = updatedPl.items.find(i => i.id === 'it_file');
        const it2 = updatedPl.items.find(i => i.id === 'it_folder');

        test('it1 (单文件) 迁移至 movies/MIDE-111', it1 && it1.relPath === 'movies/MIDE-111');
        test('it1 类型升级为 image 代言卡', it1 && it1.type === 'image');
        test('it1 sig 同步为 sig_new_111', it1 && it1.sig === 'sig_new_111');
        test('it1 files 填充为分卷列表', it1 && it1.files && it1.files.length === 1);

        test('it2 (换封面) sig 更新为 sig_new_222', it2 && it2.sig === 'sig_new_222');

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
