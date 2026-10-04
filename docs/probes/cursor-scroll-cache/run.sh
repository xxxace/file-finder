#!/usr/bin/env bash
# 滚动 + 懒加载会不会让行结构探测出错 —— 真 Chromium（无头 Electron）
#
# ⚠️ `env -u ELECTRON_RUN_AS_NODE` 不能省（本机 shell 注入了这个变量，
#    不删掉 electron 会退化成纯 Node、根本不跑窗口）
# ⚠️ 证据写 out.txt（`.gitignore` 挡 *.log）
set -u
cd "$(dirname "$0")/../../.." || exit 1
env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe \
    docs/probes/cursor-scroll-cache/run.cjs > docs/probes/cursor-scroll-cache/out.txt 2>&1
code=$?
tail -60 docs/probes/cursor-scroll-cache/out.txt
exit $code
