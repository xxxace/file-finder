// 复核：cover-blur A 档方案的前提 —— 「缩略图宽 = min(原图宽, 480)」恒等式是否成立？
// 只读、纯内存（只解 base64 前 16KB 扫 JPEG 标记，不解码整图、不碰盘）
import fs from 'node:fs'
import crypto from 'node:crypto'

const K = crypto.createHash('sha256').update('file-finder-cache-v1-2026-09-24').digest()
const IV = Buffer.alloc(16, 0)
const dec = (l) => {
  if (l.startsWith('{')) return l
  const d = crypto.createDecipheriv('aes-256-cbc', K, IV)
  return Buffer.concat([d.update(Buffer.from(l, 'base64')), d.final()]).toString('utf8')
}

/** 从 JPEG data URI 里读出宽度。只扫标记段，不解码。 */
function jpegWidth(dataUri) {
  if (typeof dataUri !== 'string' || !dataUri.startsWith('data:image/jpeg')) return null
  const b64 = dataUri.slice(dataUri.indexOf(',') + 1)
  const buf = Buffer.from(b64.slice(0, 22000), 'base64') // JPEG 头 + 少量数据足够
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return null
  let i = 2
  while (i < buf.length - 9) {
    if (buf[i] !== 0xff) { i++; continue }
    const marker = buf[i + 1]
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return buf.readUInt16BE(i + 7) // SOF 段里第 4 个 2 字节 = 高度，第 5 个 = 宽度
        ? buf.readUInt16BE(i + 7) : null
    }
    const segLen = buf.readUInt16BE(i + 2)
    if (segLen < 2) return null
    i += 2 + segLen
  }
  return null
}

const db = process.env.USERPROFILE + '/.file-finder/searchCache.db'
const lines = fs.readFileSync(db, 'utf8').split('\n').filter(Boolean)

const widths = []          // 所有条目缩略图的实测宽
let faceW = []             // folder+avatar 那批的缩略图宽
for (const l of lines) {
  let r
  try { r = JSON.parse(dec(l)) } catch { continue }
  if (r.serial === undefined || r.relPath === undefined) continue
  for (const it of r.data || []) {
    const w = jpegWidth(it.avatarThumbData || it.thumbData)
    if (w) {
      widths.push(w)
      if (it.type === 'folder' && it.avatar) faceW.push(w)
    }
  }
}

const hist = (arr) => {
  const h = {}
  for (const w of arr) h[Math.floor(w / 120) * 120] = (h[Math.floor(w / 120) * 120] || 0) + 1
  return Object.entries(h).sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}~: ${v}`).join('  ')
}

console.log('全部缩略图样本', widths.length, '| 最大宽', Math.max(...widths))
console.log('  宽度>480 的张数:', widths.filter((w) => w > 480).length, '<= 若为 0，恒等式成立')
console.log('  宽度分布(按120分桶):', hist(widths))
console.log('')
console.log('folder+avatar 那批的缩略图宽:', faceW.length, '| 最大', faceW.length ? Math.max(...faceW) : 'n/a')
if (faceW.length) {
  const below = faceW.filter((w) => w < 480).length
  console.log('  宽度<480（即按恒等式：原图不足 480）的:', below, '=> 这批就是 A 档的真正目标')
  console.log('  该批宽度分布:', hist(faceW))
}
