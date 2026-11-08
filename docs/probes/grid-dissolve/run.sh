#!/usr/bin/env bash
# 网格"溶解入场"探针：真 Chromium + 真 Vue + 真 gridDissolve.ts
#
#   bash docs/probes/grid-dissolve/run.sh
#
# ⚠️ 证据写 out.txt（`.gitignore` 挡 `*.log`，写 log 就进不了仓库 → 文档引用变死链）
# ⚠️ `env -u ELECTRON_RUN_AS_NODE` 不能省（本机 shell 注入了它，electron 会退化成纯 Node）
# ⚠️ 复刻件必须跟着实现改：`index.html` 里的 watch 接线要和 `index.vue` 一致
#    （`watch([dataSource, gridCols], …, { flush: 'post' })`），`dissolveGrid` 直接 bundle 真模块。
set -u
cd "$(dirname "$0")/../../.." || exit 1

node -e "
require('esbuild').buildSync({
  entryPoints:['src/views/FileFinder/gridDissolve.ts'],
  bundle:true, format:'iife', globalName:'GridDissolve',
  outfile:'docs/probes/grid-dissolve/gridDissolve.bundle.js', target:'es2020'
});
" || exit 1

env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe \
    docs/probes/grid-dissolve/run.cjs > docs/probes/grid-dissolve/out.txt 2>&1
code=$?
cat docs/probes/grid-dissolve/out.txt
exit $code
