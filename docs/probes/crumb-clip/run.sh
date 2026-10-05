#!/usr/bin/env bash
# 一行复跑：bash docs/probes/crumb-clip/run.sh
#
# ⚠️ 本探针吃的是**真实编译产物** CSS ⇒ 每次都先重建
#    （改了 src/views/FileFinder/index.vue 的样式后，必须靠这一步让探针吃到新样式）
# ⚠️ 本机 shell 注入了 ELECTRON_RUN_AS_NODE=1，必须 `env -u` 真删掉（设空串没用）。
set -euo pipefail
cd "$(dirname "$0")/../../.."
node docs/probes/header-width/build-css.mjs > /dev/null
env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe docs/probes/crumb-clip/run.cjs
echo "── out.txt 已重建 ──"
