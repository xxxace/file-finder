#!/usr/bin/env bash
# 预览层「上一条 / 下一条 + 定位」机制探针 —— 一键复算
#
#   bash docs/probes/preview-nav/run.sh        # 结果同时落到 out.txt
#
# 用**项目自带的 electron** 当真实浏览器（不装 playwright / happy-dom）：
# 本探针问的是"注入链、事件、命中"—— 只有真 Chromium 能给答案。
#
# ⚠️ 本机 shell 注入了 ELECTRON_RUN_AS_NODE=1，必须 `env -u` 真删掉（设空字符串没用）。
set -e
cd "$(dirname "$0")/../../.."

echo "== 1/2 用项目自带 vite 打一个探针 bundle（要拿到 naive-ui 的内部注入键）=="
node node_modules/vite/bin/vite.js build --config docs/probes/preview-nav/vite.config.mjs

echo
echo "== 2/2 真 Chromium 跑探针 =="
env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe docs/probes/preview-nav/run.cjs 2>&1 \
    | grep -v "GPU process\|Dawn\|deprecated\|Security Warning\|font-weight\|Content Security\|renderer process\|For more\|electronjs.org\|once the app\|development build of Vue\|production build\|Autofill\|DevTools" \
    | tee docs/probes/preview-nav/out.txt
