// 扫描成本探针 —— 只读，不写任何文件、不生成缩略图。
//
// 用途：回答「盘上文件多会不会有性能问题」。它把「遍历」和「取 size」分开计时，
// 用来证明瓶颈不在遍历，而在缩略图生成（后者要真跑 electron，不在本脚本内）。
//
// 复算方式：
//   node docs/probes/scan-cost.mjs D:/sample/videos
//   node docs/probes/scan-cost.mjs E:/sample/videos --stat
//
// 实测（2026-09-24，两块盘都在线）：
//   D:/sample/videos  73 目录 / 285 目录项 / 213 文件 → 7 ms
//   E:/sample/videos           98 目录 / 282 目录项 / 185 文件 → 8 ms
import * as fs from 'node:fs/promises';

const root = process.argv[2];
const doStat = process.argv.includes('--stat');
const CONC = 8;

const VIDEO = ['mp4', 'mkv', 'avi', 'wmv', 'flv', 'mpeg'];
const IMAGE = ['jpg', 'jpeg', 'png', 'bmp', 'gif', 'svg', 'psd', 'webp'];

let dirs = 0, files = 0, vids = 0, imgs = 0, others = 0;
let entriesInScan = 0;
let bytes = 0;
let statCalls = 0;

const t0 = Date.now();

async function walk(dir) {
    let list;
    try {
        // withFileTypes：Windows 上 Dirent 的类型来自 FIND_FIRST_FILE 的 dwFileAttributes，
        // 不需要额外 stat —— 这是「171 个目录只要 15 毫秒」的原因
        list = await fs.readdir(dir, { withFileTypes: true });
    } catch { return; }
    dirs++;
    entriesInScan += list.length;

    const subdirs = [];
    for (const d of list) {
        const name = d.name;
        if (name.startsWith('.') || name === 'System Volume Information' || name === '$RECYCLE.BIN') continue;
        if (d.isDirectory()) { subdirs.push(dir + '/' + name); continue; }
        if (!d.isFile()) continue;

        files++;
        const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
        if (VIDEO.includes(ext)) vids++;
        else if (IMAGE.includes(ext)) imgs++;
        else others++;

        // Dirent 不带 size。真扫描（readFolder）需要 size 显示体积，所以这里可以打开 --stat 量它的代价
        if (doStat) {
            try { const st = await fs.stat(dir + '/' + name); bytes += st.size; statCalls++; } catch { }
        }
    }

    for (let i = 0; i < subdirs.length; i += CONC) {
        await Promise.all(subdirs.slice(i, i + CONC).map(walk));
    }
}

if (!root) {
    console.error('用法: node docs/probes/scan-cost.mjs <根目录> [--stat]');
    process.exit(1);
}

await walk(root);
const ms = Date.now() - t0;

console.log(JSON.stringify({
    root,
    stat: doStat,
    ms,
    dirs,
    目录项总数: entriesInScan,
    文件: files,
    视频: vids,
    图片: imgs,
    其它: others,
    stat调用: statCalls,
    合计GB: +(bytes / 1073741824).toFixed(2),
    每秒条目: Math.round(entriesInScan / (ms / 1000)),
}, null, 1));
