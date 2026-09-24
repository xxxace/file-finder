// 「到底还需要点几次」探针 —— 只读，不写任何文件。
//
// 目的：P1（批量扫描）的价值 = 省下多少次手动点击。这个数字必须先算准，
//       否则会为一个不存在的问题开发功能。
//
// 判据来自 electron/server/index.ts 的 handleCover()：
//   一个子目录在父层被扫到时会有三种形态 ——
//     ① 里面有子目录        → 返回 null，保持 folder 形态  → **可点开**
//     ② 无子目录 + 有图片    → 收敛成一张封面条目        → **点不开**（内容已在父层可见）
//     ③ 无子目录 + 无图片    → 返回 null，保持 folder 形态  → **可点开**（点进去只有视频/空）
//   所以「手点次数」只跟 ①③ 有关，收敛目录(②)根本不需要点 —— 它的封面早就显示在父层了。
//
// 复算：node docs/probes/clickable-dirs.mjs
import * as fs from 'node:fs/promises';

const ROOTS = ['D:/sample/videos', 'E:/sample/videos'];
const SERIAL_DRIVE = { AAAA1111: 'E', 'BBBB2222': 'F' };
const DB = 'C:/Users/<user>/.file-finder/searchCache.db';

const IMG = ['jpg', 'jpeg', 'png', 'bmp', 'gif', 'svg', 'psd', 'webp'];
const VIDEO = ['mp4', 'mkv', 'avi', 'wmv', 'flv', 'mpeg'];
const SKIP = ['System Volume Information', '$RECYCLE.BIN', 'Config.Msi', 'found.000', 'found.001'];

// 1) 已缓存集合（把 (serial, relPath) 还原成绝对路径）
const cached = new Set();
for (const line of (await fs.readFile(DB, 'utf8')).split('\n')) {
    if (!line) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    if (d.$$indexCreated || !d.serial) continue;
    const drive = SERIAL_DRIVE[d.serial];
    if (!drive) continue;
    cached.add((d.relPath ? `${drive}:/${d.relPath}` : `${drive}:`).toLowerCase());
}

// 2) 遍历两棵树，只 readdir（withFileTypes 不产生额外 stat）
const info = new Map();
async function walk(dir) {
    let list;
    try { list = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    let subdirs = 0, images = 0, videos = 0, others = 0;
    const subs = [];
    for (const d of list) {
        if (d.name.startsWith('.') || SKIP.includes(d.name)) continue;
        if (d.isDirectory()) { subdirs++; subs.push(`${dir}/${d.name}`); continue; }
        const ext = d.name.includes('.') ? d.name.slice(d.name.lastIndexOf('.') + 1).toLowerCase() : '';
        if (IMG.includes(ext)) images++;
        else if (VIDEO.includes(ext)) videos++;
        else others++;
    }
    info.set(dir, { subdirs, images, videos, others });
    for (const s of subs) await walk(s);
}
for (const r of ROOTS) await walk(r);

// 3) 分类
const clickable = [], converged = [];
for (const [p, i] of info) {
    const isRoot = ROOTS.includes(p);
    const folded = !isRoot && i.subdirs === 0 && i.images > 0;   // ← 被收敛成封面
    (folded ? converged : clickable).push({ path: p, ...i });
}

const remaining = clickable.filter(c => !cached.has(c.path.toLowerCase()));
const cachedHit = clickable.filter(c => cached.has(c.path.toLowerCase()));

console.log(JSON.stringify({
    目录总数: info.size,
    可点开: clickable.length,
    收敛成封面_点不开: converged.length,
    '可点开里已缓存': cachedHit.length,
    '可点开里还需要点': remaining.length,
    '还需要点的清单': remaining.map(c => c.path),
    '已缓存但属于收敛目录_说明用户是直接选它当根扫的': [...cached].filter(p => converged.some(c => c.path.toLowerCase() === p)).length,
}, null, 1));
