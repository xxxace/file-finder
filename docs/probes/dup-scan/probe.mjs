import * as fs from 'node:fs'
const recs = JSON.parse(fs.readFileSync('/tmp/recs.json', 'utf8'))

const byName = new Map()
for (const r of recs) {
  const leaf = r.relPath.split('/').filter(Boolean).pop() || '(root)'
  if (!byName.has(leaf)) byName.set(leaf, new Set())
  byName.get(leaf).add(r.serial)
}
let cross = 0
const dup = []
for (const [name, serials] of byName) {
  if (serials.size > 1) { cross++; dup.push([name, [...serials].join('+')]) }
}
console.log('不同目录名', byName.size, '| 出现在多盘的', cross, ((cross / byName.size) * 100).toFixed(1) + '%')

// ⚠️ 脱敏铁律：证据文件会入库，**不许打印真名**（演员名/作品名/真机目录名）。
// 这里只打**分类 + 计数**，足够支撑结论，不泄露任何标识。
const CONTAINER = new Set(['videos', 'video', 'movies', 'movie'])
let isContainer = 0
let isWork = 0
for (const [name, serials] of byName) {
  if (serials.size <= 1) continue
  if (CONTAINER.has(name.toLowerCase())) isContainer++
  else if (/\d{2,4}-\d{2,4}/.test(name) || /[A-Za-z]{2,}\d{2,}/i.test(name)) isWork++
  else isWork++ // 其余按"作品目录（演员名或番号名）"计
}
console.log('  跨盘重复的目录里：容器名', isContainer, '| 作品名形态', isWork, '（真名已脱敏，不打印）')
const sample = dup.slice(0, 5).map(([n, s]) => n.replace(/./g, '*').slice(0, 4) + '…->' + s)
console.log('  形态示例（掩码）', sample.join('  '))

const vids = new Map()
for (const r of recs) for (const d of r.data) {
  if (d.t === 'video') { if (!vids.has(d.n)) vids.set(d.n, new Set()); vids.get(d.n).add(r.serial) }
}
let vc = 0
for (const [, s] of vids) if (s.size > 1) vc++
console.log('不同视频条目名', vids.size, '| 跨盘出现的', vc, vids.size ? ((vc / vids.size) * 100).toFixed(1) + '%' : '')

const dirs = new Map()
for (const r of recs) for (const d of r.data) if (d.t === 'folder') dirs.set(r.serial + '|' + d.n, (dirs.get(r.serial + '|' + d.n) || 0) + 1)
console.log('文件夹条目总数', dirs.size)

let leaf1 = 0
const lvl = new Map()
for (const r of recs) {
  const depth = r.relPath.split('/').filter(Boolean).length
  lvl.set(depth, (lvl.get(depth) || 0) + 1)
}
console.log('缓存目录深度分布', JSON.stringify([...lvl.entries()].sort((a, b) => a[0] - b[0])))
