#!/usr/bin/env bash
# 焦点格的 scale 会不会污染行结构 —— 真 Chromium（无头 Electron）
#
# ⚠️ `env -u ELECTRON_RUN_AS_NODE` 不能省（本机 shell 注入了这个变量，
#    不删掉 electron 会退化成纯 Node、根本不跑窗口）
# ⚠️ 证据写 out.txt（`.gitignore` 挡 *.log）
set -u
cd "$(dirname "$0")/../../.." || exit 1
env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe \
    docs/probes/cursor-scale-row/run.cjs > docs/probes/cursor-scale-row/out.txt 2>&1
code=$?
tail -50 docs/probes/cursor-scale-row/out.txt
exit $code
