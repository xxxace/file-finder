/**
 * 收藏夹信息同步 · 读端对齐探针
 * ---------------------------------------------------------------------------
 * 测试 `reconcileItemWithCache` 纯函数对齐逻辑：
 * 1. 新封面 sig 投影
 * 2. 单视频升级为同名文件夹代言卡
 * 3. 盘在线且父目录存在但条目消失 -> missing: true
 * 4. 盘离线 -> missing: false 安全降级
 * 跑法：node docs/probes/playlist-sync/probe-reconcile.cjs
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

const plBundle = bundle('electron/server/playlist.ts');
const {
    reconcileItemWithCache,
    cacheRelOfItem,
    wireItem,
} = require(plBundle);

let failures = 0;
const test = (name, cond) => {
    if (cond) {
        console.log(`PASS  ${name}`);
    } else {
        console.error(`FAIL  ${name}`);
        failures++;
    }
};

// Case 1: 代言卡新 sig 对齐
const itemImage = {
    id: 'it_img',
    serial: 'DISK_1',
    relPath: 'movies/ABC-123',
    name: 'ABC-123',
    type: 'image',
    size: 5000,
    sig: 'sig_old',
    files: [{ name: 'ABC-123.mp4', size: 5000 }],
    addedAt: 1000,
};
const parentCacheWithNewSig = {
    serial: 'DISK_1',
    relPath: 'movies',
    data: [
        {
            dir: 'movies/ABC-123',
            name: 'ABC-123',
            isDirectory: false,
            type: 'image',
            size: 5500,
            sig: 'sig_new',
            files: [{ name: 'ABC-123.mp4', size: 5500 }],
        },
    ],
};

const res1 = reconcileItemWithCache(itemImage, parentCacheWithNewSig, 'H:');
test('Case 1: sig 变更为 sig_new', res1.item.sig === 'sig_new');
test('Case 1: size 变更为 5500', res1.item.size === 5500);
test('Case 1: changed 为 true', res1.changed === true);
test('Case 1: missing 为 false', res1.missing === false);

// Case 2: 单视频在 NeDB 中收敛为同名文件夹代言卡
const itemVideo = {
    id: 'it_vid',
    serial: 'DISK_1',
    relPath: 'movies',
    name: 'DEF-456',
    ext: 'mp4',
    type: 'video',
    size: 3000,
    sig: 'sig_v_old',
    addedAt: 1000,
};
const dirCachePackaged = {
    serial: 'DISK_1',
    relPath: 'movies',
    data: [
        {
            dir: 'movies/DEF-456',
            name: 'DEF-456',
            isDirectory: false,
            type: 'image',
            size: 3000,
            sig: 'sig_folder_cover',
            files: [{ name: 'DEF-456.mp4', size: 3000 }],
        },
    ],
};

const res2 = reconcileItemWithCache(itemVideo, dirCachePackaged, 'H:');
test('Case 2: type 升级为 image 代言卡', res2.item.type === 'image');
test('Case 2: relPath 变迁为 movies/DEF-456', res2.item.relPath === 'movies/DEF-456');
test('Case 2: sig 更新为文件夹封面 sig', res2.item.sig === 'sig_folder_cover');
test('Case 2: files 补充为分卷列表', res2.item.files && res2.item.files.length === 1);
test('Case 2: changed 为 true', res2.changed === true);
test('Case 2: missing 为 false', res2.missing === false);

// Case 3: 盘在线且父目录存在，但条目在缓存中消失 -> missing: true
const emptyParentCache = {
    serial: 'DISK_1',
    relPath: 'movies',
    data: [],
};
const res3 = reconcileItemWithCache(itemImage, emptyParentCache, 'H:');
test('Case 3: 盘在线且条目消失，missing 为 true', res3.missing === true);
test('Case 3: 快照不被破坏', res3.item.name === 'ABC-123');

// Case 4: 盘离线 -> missing 必须为 false（安全降级）
const res4 = reconcileItemWithCache(itemImage, emptyParentCache, '');
test('Case 4: 盘离线时 missing 为 false', res4.missing === false);

// Case 5: 缓存为 null（未缓存过的冷目录） -> missing 必须为 false
const res5 = reconcileItemWithCache(itemImage, null, 'H:');
test('Case 5: 目录未缓存时 missing 为 false', res5.missing === false);

// Case 6: cacheRelOfItem 路径解析
test('Case 6: 代言卡 image 的缓存层级为 parentRel', cacheRelOfItem(itemImage) === 'movies');
test('Case 6: video 的缓存层级为 relPath', cacheRelOfItem(itemVideo) === 'movies');

// Case 7: 普通文件夹条目（type === 'folder'）
const itemFolder = {
    id: 'it_fld',
    serial: 'DISK_1',
    relPath: 'movies',
    name: 'Action',
    type: 'folder',
    size: 0,
    addedAt: 1000,
};
const parentCacheWithFolder = {
    serial: 'DISK_1',
    relPath: 'movies',
    data: [
        {
            dir: 'movies',
            name: 'Action',
            isDirectory: true,
            type: 'folder',
            size: 0,
        },
    ],
};
test('Case 7: 普通文件夹的缓存层级为 relPath (movies)', cacheRelOfItem(itemFolder) === 'movies');
const res7 = reconcileItemWithCache(itemFolder, parentCacheWithFolder, 'H:');
test('Case 7: 普通文件夹不被误判为 missing', res7.missing === false);

// Case 8: 普通单张图片（type === 'image' 但 !files）
const itemPlainPic = {
    id: 'it_pic',
    serial: 'DISK_1',
    relPath: 'photos',
    name: 'wallpaper',
    ext: 'jpg',
    type: 'image',
    size: 1024,
    addedAt: 1000,
};
const parentCacheWithPic = {
    serial: 'DISK_1',
    relPath: 'photos',
    data: [
        {
            dir: 'photos',
            name: 'wallpaper',
            ext: 'jpg',
            isDirectory: false,
            type: 'image',
            size: 1024,
        },
    ],
};
test('Case 8: 普通单图的缓存层级为 relPath (photos)', cacheRelOfItem(itemPlainPic) === 'photos');
const res8 = reconcileItemWithCache(itemPlainPic, parentCacheWithPic, 'H:');
test('Case 8: 普通单图不被误判为 missing', res8.missing === false);

// Case 9: 根目录下的独立文件（relPath === ''）
const itemRootFile = {
    id: 'it_root',
    serial: 'DISK_1',
    relPath: '',
    name: 'second_file',
    ext: 'txt',
    type: 'file',
    size: 50,
    addedAt: 1000,
};
const rootCache = {
    serial: 'DISK_1',
    relPath: '',
    data: [
        { dir: '', name: 'first_file', ext: 'inf', type: 'file', size: 10 },
        { dir: '', name: 'second_file', ext: 'txt', type: 'file', size: 50 },
    ],
};
const res9 = reconcileItemWithCache(itemRootFile, rootCache, 'H:');
test('Case 9: 根目录下文件不被误匹配为第 1 个无关文件', res9.item.name === 'second_file' && res9.missing === false);

if (failures > 0) {
    process.exit(1);
}
