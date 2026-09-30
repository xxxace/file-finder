#!/usr/bin/env bash
# 删除与扫描的竞态（「删了又回来」）—— 一键复算
#
#   bash docs/probes/remove-race/run.sh
#
# ⚠️ 输出用 `.txt` 而不是 `.log`：本仓 `.gitignore` 里有 `*.log`，
#    写成 .log 的话证据文件进不了仓库，文档里的引用就变成死链（踩过）。
set -e
cd "$(dirname "$0")/../../.."

node docs/probes/remove-race/run.mjs 2>&1 | tee docs/probes/remove-race/out.txt
