// 只读探针：量每一档 PNG 里"真正有像素"的 bbox，看图标在画布里到底占了多少。
const { app, nativeImage } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const DIR = path.join(__dirname, 'png')
const FILES = ['icon-16.png', 'icon-24.png', 'icon-32.png', 'icon-48.png', 'icon-64.png', 'icon-128.png', 'icon-256.png']

app.whenReady().then(() => {
  for (const f of FILES) {
    const p = path.join(DIR, f)
    if (!fs.existsSync(p)) { console.log(f + ' MISSING'); continue }
    const img = nativeImage.createFromPath(p)
    const { width: w, height: h } = img.getSize()
    const bmp = img.toBitmap()
    let minX = w, minY = h, maxX = -1, maxY = -1
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const a = bmp[(y * w + x) * 4 + 3]
        if (a > 8) {
          if (x < minX) minX = x
          if (x > maxX) maxX = x
          if (y < minY) minY = y
          if (y > maxY) maxY = y
        }
      }
    }
    const bw = maxX - minX + 1
    const bh = maxY - minY + 1
    console.log(
      `${f}  canvas=${w}x${h}  bbox=${bw}x${bh}  ` +
      `占比=${(bw / w * 100).toFixed(1)}%x${(bh / h * 100).toFixed(1)}%  ` +
      `left=${minX} top=${minY} right=${w - 1 - maxX} bottom=${h - 1 - maxY}`
    )
  }
  app.exit(0)
})
