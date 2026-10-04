#!/usr/bin/env bash
# 焦点框有多粗 —— 真 Chromium
# ⚠️ `env -u ELECTRON_RUN_AS_NODE` 不能省；证据写 out.txt
set -u
cd "$(dirname "$0")/../../.." || exit 1
env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe \
    docs/probes/cursor-visual-weight/run.cjs > docs/probes/cursor-visual-weight/out.txt 2>&1
code=$?
tail -30 docs/probes/cursor-visual-weight/out.txt
exit $code
