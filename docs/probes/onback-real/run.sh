#!/usr/bin/env bash
# `onBack` 的真函数体（从 index.vue 抽源码）—— 真 Vue + 真 DOM
# ⚠️ `env -u ELECTRON_RUN_AS_NODE` 不能省；证据写 out.txt
set -u
cd "$(dirname "$0")/../../.." || exit 1
env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe \
    docs/probes/onback-real/run.cjs > docs/probes/onback-real/out.txt 2>&1
code=$?
tail -45 docs/probes/onback-real/out.txt
exit $code
