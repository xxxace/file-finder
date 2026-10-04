#!/usr/bin/env bash
# "前三行正常、第四行开始错"的界限 —— 真 Chromium（无头 Electron，主屏 2048×1280）
#
# ⚠️ `env -u ELECTRON_RUN_AS_NODE` 不能省（本机 shell 注入了这个变量，
#    不删掉 electron 会退化成纯 Node、根本不跑窗口）
# ⚠️ 证据写 out.txt（`.gitignore` 挡 *.log）
set -u
cd "$(dirname "$0")/../../.." || exit 1
env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe \
    docs/probes/row4-boundary/run.cjs > docs/probes/row4-boundary/out.txt 2>&1
code=$?
tail -60 docs/probes/row4-boundary/out.txt
exit $code
