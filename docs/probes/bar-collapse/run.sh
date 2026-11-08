#!/usr/bin/env bash
# 验 `grid-template-rows: 0fr ↔ 1fr` 是否插值（决定底部状态条怎么写动画）
#   bash docs/probes/bar-collapse/run.sh
# ⚠️ 证据写 out.txt（.gitignore 挡 *.log）
# ⚠️ `env -u ELECTRON_RUN_AS_NODE` 不能省（本机 shell 注入了它）
set -u
cd "$(dirname "$0")/../../.." || exit 1
env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe \
    docs/probes/bar-collapse/run.cjs > docs/probes/bar-collapse/out.txt 2>&1
code=$?
cat docs/probes/bar-collapse/out.txt
exit $code
