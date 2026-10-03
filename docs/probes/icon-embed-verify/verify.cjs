// 独立复核：exe 里是否真的嵌入了 build/icon.ico 的全部档位
// 只读，不改任何文件
const fs = require('fs')

const ICO = 'build/icon.ico'
const EXE = process.argv[2] || 'release/1.0.0/win-unpacked/file-finder.exe'

if (!fs.existsSync(EXE)) { console.log('EXE 不存在:', EXE); process.exit(0) }
const ico = fs.readFileSync(ICO)
const exe = fs.readFileSync(EXE)

// ICO 头部：reserved(2) type(2) count(2)，随后 count 个 16 字节条目
const count = ico.readUInt16LE(4)
console.log('ICO 声明档位数:', count)

let all = true
for (let i = 0; i < count; i++) {
  const e = 6 + i * 16
  const w = ico[e] || 256
  const h = ico[e + 1] || 256
  const sz = ico.readUInt32LE(e + 8)
  const off = ico.readUInt32LE(e + 12)
  const data = ico.slice(off, off + sz)
  // 只取 PNG 载荷前 64 字节做特征搜索（避免整块大文件重复匹配）
  const sig = data.slice(0, Math.min(64, sz))
  const at = exe.indexOf(sig)
  if (at < 0) all = false
  console.log(`  ${String(w).padStart(3)}x${String(h).padEnd(3)}  ${String(sz).padStart(6)}B  ${data[0] === 0x89 ? 'PNG' : 'DIB'}  exe偏移 ${at}`)
}
console.log(all ? 'ALL_PRESENT => exe 内确实嵌了全部档位' : 'SOME_MISSING')
