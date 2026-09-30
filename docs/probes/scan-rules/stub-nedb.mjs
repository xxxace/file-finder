// 探针用：把 scan.ts 的 `../nedb` 换成"读夹具文件"的桩。
// 只替换数据源，**scan.ts 一字节都不改** —— 验的就是真实分类逻辑。
import fs from 'node:fs';

function fixture() {
    return JSON.parse(fs.readFileSync(process.env.FF_SCAN_FIXTURE, 'utf8'));
}

export function loadMeta() {
    return Promise.resolve(fixture().metas);
}

export function findCache(serial, relPath /*, mode */) {
    const doc = fixture().docs[`${serial}|${relPath}`];
    return Promise.resolve(doc ?? null);
}
