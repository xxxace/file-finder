#!/usr/bin/env bash
# 面包屑位移探针：真 Chromium + 真 TransitionGroup + 真编译 CSS
#
#   bash docs/probes/crumb-motion/run.sh
#
# ⚠️ 证据写 out.txt（`.gitignore` 挡 `*.log`，写 log 就进不了仓库 → 文档引用变死链）
# ⚠️ `env -u ELECTRON_RUN_AS_NODE` 不能省（本机 shell 注入了它，electron 会退化成纯 Node）
set -u
cd "$(dirname "$0")/../../.." || exit 1

node docs/probes/crumb-motion/build-css.mjs >/dev/null || exit 1
node -e "
require('esbuild').buildSync({
  entryPoints:['src/views/FileFinder/crumbRows.ts'],
  bundle:true, format:'iife', globalName:'CrumbRows',
  outfile:'docs/probes/crumb-motion/crumbRows.bundle.js', target:'es2020'
});
" || exit 1

env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe \
    docs/probes/crumb-motion/run.cjs > docs/probes/crumb-motion/out.txt 2>&1
code=$?
cat docs/probes/crumb-motion/out.txt
exit $code
