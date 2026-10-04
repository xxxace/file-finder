#!/usr/bin/env bash
# 预览层「点图外关闭」探针 —— 一键复算
#
#   bash docs/probes/preview-outside/run.sh
#
# 用**项目自带的 electron** 当真实浏览器：判据全在**命中测试**与**真实布局**上，
# 静态读代码给不出答案。窗口必须 offscreen（否则 rAF 不推进）。
set -e
cd "$(dirname "$0")/../../.."

echo "== 1/2 用项目自带 vite 打探针 bundle =="
node node_modules/vite/bin/vite.js build --config docs/probes/preview-outside/vite.config.mjs

echo
echo "== 2/2 真 Chromium 跑探针 =="
env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe docs/probes/preview-outside/run.cjs 2>&1 \
    | grep -v "GPU process\|Dawn\|deprecated\|Security Warning\|font-weight\|Content Security\|renderer process\|For more\|electronjs.org\|once the app\|development build of Vue\|production build\|Autofill\|DevTools" \
    | tee docs/probes/preview-outside/out.txt
