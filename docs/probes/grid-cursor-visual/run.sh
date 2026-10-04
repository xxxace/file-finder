#!/usr/bin/env bash
# 焦点环可见性 / 三态可区分 —— 真 Chromium（无头 Electron）
#
# ⚠️ `env -u ELECTRON_RUN_AS_NODE` 不能省（本机 shell 注入了这个变量，
#    不删掉 electron 会退化成纯 Node、根本不跑窗口）
# ⚠️ 证据写 out.txt（`.gitignore` 挡 *.log）
set -u
cd "$(dirname "$0")/../../.." || exit 1
env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe \
    docs/probes/grid-cursor-visual/run.cjs > docs/probes/grid-cursor-visual/out.txt 2>&1
code=$?
tail -40 docs/probes/grid-cursor-visual/out.txt
exit $code
