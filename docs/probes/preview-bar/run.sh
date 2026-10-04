#!/usr/bin/env bash
# 预览层「底部通栏工具条」几何探针 —— 一键复算
#
#   bash docs/probes/preview-bar/run.sh        # 结果同时落到 out.txt
#
# ⚠️ 本机 shell 注入了 ELECTRON_RUN_AS_NODE=1，必须 `env -u` 真删掉（设空字符串没用）。
set -e
cd "$(dirname "$0")/../../.."

echo "== 1/2 用项目自带 vite 打探针 bundle =="
node node_modules/vite/bin/vite.js build --config docs/probes/preview-bar/vite.config.mjs

echo
echo "== 2/2 真 Chromium 量几何 =="
env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe docs/probes/preview-bar/run.cjs 2>&1 \
    | grep -v "GPU process\|Dawn\|deprecated\|Security Warning\|font-weight\|Content Security\|renderer process\|For more\|electronjs.org\|once the app\|development build of Vue\|production build\|Autofill\|DevTools" \
    | tee docs/probes/preview-bar/out.txt
