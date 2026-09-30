#!/usr/bin/env bash
# 头部行数 / 折叠 / 截断 —— 真 Chromium 布局测量
#
#   bash docs/probes/header-width/run.sh
#
# ⚠️ 证据写 out.txt 而不是 out.log：`.gitignore` 挡 `*.log`，写 log 的话这个文件
# 进不了仓库、文档里的引用会变成死链（本项目在 2026-09-30 踩过四次）。
# ⚠️ `env -u ELECTRON_RUN_AS_NODE` 不能省：本机 shell 注入了这个变量，
# 不删掉的话 electron 会退化成纯 Node、根本不跑窗口。
set -u
cd "$(dirname "$0")/../../.." || exit 1
env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe \
    docs/probes/header-width/run.cjs > docs/probes/header-width/out.txt 2>&1
code=$?
tail -8 docs/probes/header-width/out.txt
exit $code
