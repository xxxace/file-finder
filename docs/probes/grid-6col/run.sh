#!/usr/bin/env bash
# 网格 6 列对齐 —— 真 Chromium 布局测量
#
#   bash docs/probes/grid-6col/run.sh
#
# ⚠️ 依赖 ../header-width/css-real.generated.css。改了 FileFinder 的 <style scoped> 之后，
# 先重建那份真 CSS，否则这里量到的是旧样式：
#     node docs/probes/header-width/build-css.mjs
# 本脚本会**自动先重建一次**，省得忘。
#
# ⚠️ 证据写 out.txt 而不是 out.log：`.gitignore` 挡 `*.log`，写 log 的话这个文件
# 进不了仓库、文档里的引用会变成死链（本项目在 2026-09-30 踩过四次）。
# ⚠️ `env -u ELECTRON_RUN_AS_NODE` 不能省：本机 shell 注入了这个变量，
# 不删掉的话 electron 会退化成纯 Node、根本不跑窗口。
set -u
cd "$(dirname "$0")/../../.." || exit 1

node docs/probes/header-width/build-css.mjs >/dev/null || exit 1

env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe \
    docs/probes/grid-6col/run.cjs > docs/probes/grid-6col/out.txt 2>&1
code=$?
tail -30 docs/probes/grid-6col/out.txt
exit $code
