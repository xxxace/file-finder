#!/usr/bin/env bash
# 主题切换「右下角露底」探针
#
#   bash docs/probes/theme-transition/run.sh
#
# 直接 bundle 产品的 src/theme/transition.ts（不复制一份），量的是真代码。
# ⚠️ `env -u ELECTRON_RUN_AS_NODE` 不能省：本机 shell 注入了它，不删掉 electron 会退化成纯 Node。
set -u
cd "$(dirname "$0")/../../.." || exit 1

npx esbuild src/theme/transition.ts --bundle --format=esm --target=chrome120 \
    --outfile=docs/probes/theme-transition/transition.js --log-level=warning || exit 1

env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe \
    docs/probes/theme-transition/run.cjs > docs/probes/theme-transition/out.txt 2>&1
code=$?
tail -60 docs/probes/theme-transition/out.txt
exit $code
