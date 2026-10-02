#!/usr/bin/env bash
# 「文件夹显示大小」可行性探针 —— 用真库量聚合成本与命中率
#
#   bash docs/probes/folder-size/run.sh
#
# 纯 Node，**不需要 electron**（见 README 的手法说明）。
# ⚠️ 证据写 out.txt 而不是 out.log：`.gitignore` 挡 `*.log`，写 log 的话这个文件
# 进不了仓库、文档里的引用会变成死链（本项目在 2026-09-30 踩过四次）。
set -u
cd "$(dirname "$0")/../../.." || exit 1

node docs/probes/folder-size/run.mjs > docs/probes/folder-size/out.txt 2>&1
code=$?
cat docs/probes/folder-size/out.txt
exit $code
