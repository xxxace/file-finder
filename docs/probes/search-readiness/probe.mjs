// 独立复核：全局搜索的可行性前提（只读）
// 1) 全库 mode 分布        2) 条目 name 字段是否覆盖目录名  3) 内存可达性
import fs from 'node:fs'
import crypto from 'node:crypto'

const K = crypto.createHash('sha256').update('file-finder-cache-v1-2026-09-24').digest()
const IV = Buffer.alloc(16, 0)
const dec = (l) => {
  if (l.startsWith('{')) return l
  const d = crypto.createDecipheriv('aes-256-cbc', K, IV)
  return Buffer.concat([d.update(Buffer.from(l, 'base64')), d.final()]).toString('utf8')
}

const db = process.env.USERPROFILE + '/.file-finder/searchCache.db'
const lines = fs.readFileSync(db, 'utf8').split('\n').filter(Boolean)

const modes = {}
let recs = 0, items = 0, withName = 0
let nameEqLeaf = 0        // name 就是目录名 -> 搜目录名能命中
let nameIsCoverish = 0    // name 是 cover/avatar/纯数字 -> 搜目录名搜不到
const coverRecords = []   // 目录条目(收敛成卡)有多少

for (const l of lines) {
  let r
  try { r = JSON.parse(dec(l)) } catch { continue }
  if (r.serial === undefined || r.relPath === undefined) continue
  recs++
  modes[r.mode] = (modes[r.mode] || 0) + 1
  const leaf = r.relPath.split('/').filter(Boolean).pop() || ''
  for (const it of (r.data || [])) {
    items++
    if (typeof it.name === 'string') withName++
    if (it.name === leaf) nameEqLeaf++
    if (/^(cover|avatar|poster|\d+)$/i.test(it.name)) nameIsCoverish++
    if (it.type === 'folder') coverRecords.push({ leaf, name: it.name, hasAvatar: !!it.avatar })
  }
}

console.log('记录数        ', recs)
console.log('mode 分布     ', JSON.stringify(modes))
console.log('条目总数      ', items, '| name 是字符串的', withName)
console.log('name==目录名  ', nameEqLeaf, '<= 这些搜目录名能命中')
console.log('name 是 cover/avatar/数字', nameIsCoverish, '<= 这些**搜目录名搜不到**')
console.log('')
console.log('type==folder 的条目数:', coverRecords.length)
console.log('  其中有 avatar(有脸)的:', coverRecords.filter((x) => x.hasAvatar).length)
console.log('  样本(脱敏: 只示形态):')
for (const x of coverRecords.slice(0, 5)) {
  console.log('    name 是封面图名?', /^(cover|avatar)/i.test(x.name), '| 有脸?', x.hasAvatar, '| name长度', String(x.name).length)
}
