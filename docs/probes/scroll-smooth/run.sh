#!/usr/bin/env bash
# 量原生平滑滚动的速度，以及"长按时会不会落后"（决定单次/长按要不要分开处理）
#   bash docs/probes/scroll-smooth/run.sh
# ⚠️ 证据写 out.txt（.gitignore 挡 *.log）
# ⚠️ `env -u ELECTRON_RUN_AS_NODE` 不能省（本机 shell 注入了它，electron 会退化成纯 Node）
set -u
cd "$(dirname "$0")/../../.." || exit 1
env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe \
    docs/probes/scroll-smooth/run.cjs > docs/probes/scroll-smooth/out.txt 2>&1
code=$?
cat docs/probes/scroll-smooth/out.txt
exit $code
