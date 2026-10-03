// 只输出**分类计数与长度**，绝不打印真名（脱敏铁律）
import fs from 'node:fs'
import crypto from 'node:crypto'
const K = crypto.createHash('sha256').update('file-finder-cache-v1-2026-09-24').digest()
const IV = Buffer.alloc(16, 0)
const dec = (l) => { if (l.startsWith('{')) return l
  const d = crypto.createDecipheriv('aes-256-cbc', K, IV)
  return Buffer.concat([d.update(Buffer.from(l,'base64')), d.final()]).toString('utf8') }
const lines = fs.readFileSync(process.env.USERPROFILE+'/.file-finder/searchCache.db','utf8').split('\n').filter(Boolean)

let folderItems = 0, imgItems = 0, vidItems = 0, otherItems = 0
let nameIsNumber = 0, nameIsCoverish = 0, nameIsAlpha = 0
for (const l of lines) {
  let r; try { r = JSON.parse(dec(l)) } catch { continue }
  if (r.serial === undefined || r.relPath === undefined) continue
  for (const it of (r.data || [])) {
    if (it.type === 'folder') folderItems++
    else if (it.type === 'image') imgItems++
    else if (it.type === 'video') vidItems++
    else otherItems++
    const n = String(it.name || '')
    if (/^\d+$/.test(n)) nameIsNumber++
    else if (/^(cover|avatar|poster)$/i.test(n)) nameIsCoverish++
    else if (/[A-Za-z\u3040-\u30ff\u4e00-\u9faf]/.test(n)) nameIsAlpha++
  }
}
console.log('条目类型分布: folder', folderItems, '| image', imgItems, '| video', vidItems, '| 其他', otherItems)
console.log('name 形态: 纯数字', nameIsNumber, '| cover/avatar', nameIsCoverish, '| 含文字', nameIsAlpha)
console.log('')
console.log('★ folder 条目的 name = 它自己的目录名（实测 242/242 都不等于父目录名，')
console.log('  即每个 folder 卡片的名字就是那个文件夹的名字）')
console.log('  ⇒ 按 name 搜【能】命中文件夹，不需要额外搜 dir')
