/**
 * 独立复核（不依赖既有探针）：真实解析 PE 资源目录，枚举 RT_ICON(3) / RT_GROUP_ICON(14)。
 * 目的：核实 HANDOVER §2「7 档 PNG 全部嵌入 exe」——用资源目录，而不是 indexOf 子串搜索。
 * 只读。
 */
const fs = require('fs');

function parsePE(buf) {
    if (buf.readUInt16LE(0) !== 0x5a4d) throw new Error('不是 MZ');
    const peOff = buf.readUInt32LE(0x3c);
    if (buf.readUInt32LE(peOff) !== 0x00004550) throw new Error('不是 PE');
    const numSections = buf.readUInt16LE(peOff + 6);
    const optSize = buf.readUInt16LE(peOff + 20);
    const optOff = peOff + 24;
    const magic = buf.readUInt16LE(optOff);
    const is64 = magic === 0x20b;
    const ddOff = optOff + (is64 ? 112 : 96);
    const rsrcRVA = buf.readUInt32LE(ddOff + 2 * 8);
    const rsrcSize = buf.readUInt32LE(ddOff + 2 * 8 + 4);
    const secOff = optOff + optSize;
    const sections = [];
    for (let i = 0; i < numSections; i++) {
        const s = secOff + i * 40;
        sections.push({
            name: buf.toString('ascii', s, s + 8).replace(/\0+$/, ''),
            vaddr: buf.readUInt32LE(s + 12),
            vsize: buf.readUInt32LE(s + 8),
            rawPtr: buf.readUInt32LE(s + 20),
            rawSize: buf.readUInt32LE(s + 16),
        });
    }
    const rva2off = (rva) => {
        for (const s of sections) {
            if (rva >= s.vaddr && rva < s.vaddr + Math.max(s.vsize, s.rawSize)) return s.rawPtr + (rva - s.vaddr);
        }
        return -1;
    };
    return { is64, rsrcRVA, rsrcSize, rva2off, sections };
}

function readDir(buf, base, off) {
    const named = buf.readUInt16LE(base + off + 12);
    const id = buf.readUInt16LE(base + off + 14);
    const n = named + id;
    const entries = [];
    for (let i = 0; i < n; i++) {
        const e = base + off + 16 + i * 8;
        const nameOrId = buf.readUInt32LE(e);
        const offset = buf.readUInt32LE(e + 4);
        entries.push({ id: nameOrId & 0xffffffff, isDir: !!(offset & 0x80000000), off: offset & 0x7fffffff });
    }
    return { entries, named, id };
}

function enumResources(buf, pe) {
    const base = pe.rva2off(pe.rsrcRVA);
    if (base < 0) throw new Error('找不到 .rsrc');
    const lvl1 = readDir(buf, base, 0);
    const result = [];
    const TYPE = { 3: 'RT_ICON', 14: 'RT_GROUP_ICON', 1: 'RT_CURSOR', 12: 'RT_GROUP_CURSOR', 16: 'RT_VERSION', 24: 'RT_MANIFEST' };
    for (const t of lvl1.entries) {
        const typeName = TYPE[t.id] || `type${t.id}`;
        if (!t.isDir) continue;
        const lvl2 = readDir(buf, base, t.off);
        for (const nm of lvl2.entries) {
            if (!nm.isDir) continue;
            const lvl3 = readDir(buf, base, nm.off);
            for (const lang of lvl3.entries) {
                if (lang.isDir) continue;
                const dataEntry = base + lang.off;
                const dataRVA = buf.readUInt32LE(dataEntry);
                const dataSize = buf.readUInt32LE(dataEntry + 4);
                const dataOff = pe.rva2off(dataRVA);
                result.push({ type: typeName, typeId: t.id, name: nm.id, lang: lang.id, dataOff, dataSize });
            }
        }
    }
    return result;
}

/** RT_GROUP_ICON 结构：reserved(2) type(2) count(2) 然后 count×14 字节条目 */
function parseGroupIcon(buf, off) {
    const count = buf.readUInt16LE(off + 4);
    const out = [];
    for (let i = 0; i < count; i++) {
        const e = off + 6 + i * 14;
        out.push({ w: buf[e] || 256, h: buf[e + 1] || 256, bytes: buf.readUInt32LE(e + 8), id: buf.readUInt16LE(e + 12) });
    }
    return out;
}

const files = process.argv.slice(2);
for (const f of files) {
    console.log('='.repeat(70));
    if (!fs.existsSync(f)) { console.log('缺失:', f); continue; }
    const buf = fs.readFileSync(f);
    console.log(`文件: ${f}  (${buf.length} B)`);
    const pe = parsePE(buf);
    console.log(`PE32${pe.is64 ? '+' : ''} · 节: ${pe.sections.map(s => s.name).join(',')}`);
    const res = enumResources(buf, pe);
    const icons = res.filter(r => r.typeId === 3);
    const groups = res.filter(r => r.typeId === 14);
    console.log(`RT_ICON 条目数: ${icons.length}`);
    for (const ic of icons) {
        const isPng = buf[ic.dataOff] === 0x89 && buf[ic.dataOff + 1] === 0x50;
        let dims = '';
        if (isPng) dims = `PNG ${buf.readUInt32BE(ic.dataOff + 16)}x${buf.readUInt32BE(ic.dataOff + 20)}`;
        else dims = 'DIB';
        console.log(`   id=${ic.name}  ${String(ic.dataSize).padStart(6)}B  ${dims}`);
    }
    console.log(`RT_GROUP_ICON 条目数: ${groups.length}`);
    for (const g of groups) {
        const list = parseGroupIcon(buf, g.dataOff);
        console.log(`   group id=${g.name} 声明 ${list.length} 档: ` + list.map(x => `${x.w}x${x.h}`).join(', '));
    }
}
