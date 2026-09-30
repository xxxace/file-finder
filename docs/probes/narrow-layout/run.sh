#!/usr/bin/env bash
# 小窗口布局 —— 一键复算（窗口 900×700）
#
#   bash docs/probes/narrow-layout/run.sh
#
# ⚠️ 输出用 .txt 而不是 .log：本仓 .gitignore 有 `*.log`，写成 .log 证据文件进不了仓库。
# ⚠️ 本机 shell 注入了 ELECTRON_RUN_AS_NODE=1，必须 `env -u` 真正删掉（设空字符串没用）。
set -e
cd "$(dirname "$0")/../../.."

env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe docs/probes/narrow-layout/run.cjs 2>&1 \
    | grep -v "GPU process\|Dawn\|deprecated\|Security Warning\|font-weight\|Content Security\|renderer process\|For more\|electronjs.org\|once the app\|development build\|production build\|unsafe-eval\|Policy set\|This warning" \
    | tee docs/probes/narrow-layout/out.txt
