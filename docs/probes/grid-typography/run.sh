#!/usr/bin/env bash
# 网格排版 改前 vs 改后 —— 真 Chromium
# ⚠️ `env -u ELECTRON_RUN_AS_NODE` 不能省；证据写 out.txt
set -u
cd "$(dirname "$0")/../../.." || exit 1
env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe \
    docs/probes/grid-typography/run.cjs > docs/probes/grid-typography/out.txt 2>&1
code=$?
tail -30 docs/probes/grid-typography/out.txt
exit $code
