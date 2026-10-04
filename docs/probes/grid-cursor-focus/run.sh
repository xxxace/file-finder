#!/usr/bin/env bash
# 网格选择器 · 焦点隔离与键盘归属 —— 真 Chromium（无头 Electron）
#
#   bash docs/probes/grid-cursor-focus/run.sh
#
# ⚠️ 证据写 out.txt 而不是 out.log：`.gitignore` 挡 `*.log`，写 log 的话这个文件
#    进不了仓库、文档里的引用会变成死链（本项目 2026-09-30 踩过四次）。
# ⚠️ `env -u ELECTRON_RUN_AS_NODE` 不能省：本机 shell 注入了这个变量，
#    不删掉的话 electron 会退化成纯 Node、根本不跑窗口（设空串也没用）。
set -u
cd "$(dirname "$0")/../../.." || exit 1

# 把两处**真源码**打成可内联的 IIFE 注入探针：
#   · src/utils/index.ts的 isGridKeyBlocked
#   · src/views/FileFinder/openDecision.ts 的 decideOpen / isDirCard / isMultiFileCard
# 都不能手抄 —— 手抄版回退真源码时探针仍全绿 ⇒ 判据效力为零。
# （这个错 2026-10-04 一天内犯了两次，见 docs/probes/grid-cursor-focus/README.md）
# ⚠️ 必须在 electron 之外打包：在主进程里 spawn 同一个 exe 会撞 EBUSY。
node docs/probes/grid-cursor-focus/build.mjs > docs/probes/grid-cursor-focus/generated-guard.js || exit 1
node docs/probes/grid-cursor-focus/build-decide.mjs > docs/probes/grid-cursor-focus/generated-decide.js || exit 1

env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe \
    docs/probes/grid-cursor-focus/run.cjs > docs/probes/grid-cursor-focus/out.txt 2>&1
code=$?
tail -30 docs/probes/grid-cursor-focus/out.txt
exit $code
