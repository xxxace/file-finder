import * as fs from 'node:fs'
const recs = JSON.parse(fs.readFileSync('/tmp/recs.json', 'utf8'))

// 只打印**层级形态**（每层路径段的数量与类型），不打印真名 —— 遵守脱敏铁律
const shape = new Map()
for (const r of recs) {
  const segs = r.relPath.split('/').filter(Boolean)
  const kinds = segs.map((s) => {
    if (/\d{2,4}-\d{2,4}/.test(s)) return '番号型'
    if (/[A-Za-z]{2,}\d{2,}/i.test(s)) return 'FC2型'
    return '其他'
  })
  const key = segs.length + '层 [' + kinds.join('/') + ']'
  shape.set(key, (shape.get(key) || 0) + 1)
}
console.log('--- 缓存目录的形态分布（层数 + 每层命名类型）---')
;[...shape.entries()].sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log('  ', v + ' 条', k))

// 深度 1 是什么？深度 2 是什么？只打印段数，不打印内容
const d1 = recs.filter((r) => r.relPath.split('/').filter(Boolean).length === 1)
const d2 = recs.filter((r) => r.relPath.split('/').filter(Boolean).length === 2)
console.log('\n深度1 记录数', d1.length, '| 深度2 记录数', d2.length, '| 深度3', recs.filter((r) => r.relPath.split('/').filter(Boolean).length === 3).length)

// 深度1 的目录里装的是什么类型的条目？
for (const r of d1) {
  const kinds = {}
  for (const d of r.data) kinds[d.t] = (kinds[d.t] || 0) + 1
  const segs = r.relPath.split('/').filter(Boolean)
  const top = segs[0]
  // 用占位代替真名，只说形态
  console.log('  深度1 目录：层内条目', r.count, JSON.stringify(kinds), '| 首段形态', /^\d{2,4}-\d{2,4}$/.test(top) ? '番号' : '非番号')
}

// 深度2 的路径首段是否都等于某个深度1 的尾段（即「演员/作品」两级结构）
const d1tails = new Set(d1.map((r) => r.relPath.split('/').filter(Boolean).pop()))
const d2heads = new Set(d2.map((r) => r.relPath.split('/').filter(Boolean)[0]))
let shared = 0
for (const h of d2heads) if (d1tails.has(h)) shared++
console.log('\n深度2 的首段 与 深度1 的目录名 交集', shared, '/', d2heads.size, '⇒', shared === d2heads.size ? '严格两级树（一层容器 + 一层作品）' : '不是严格两级')
