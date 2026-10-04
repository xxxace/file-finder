#!/usr/bin/env bash
# 预览层「关闭淡出期间 src 被清空」探针 —— 一键复算
#
#   bash docs/probes/preview-fade/run.sh          # A/B 两轮：先 buggy（应FAIL）再 fixed（应全 PASS）
#
# 用**项目自带的 electron** 当真实浏览器（不装 playwright / happy-dom）：
# 缺陷只存在于「show 已 false、DOM 仍在场」这个动画窗口内，静态读代码给不出答案。
#
# ⚠️ 本机 shell 注入了 ELECTRON_RUN_AS_NODE=1，必须 `env -u` 真删掉（设空字符串没用）。
set -e
cd "$(dirname "$0")/../../.."

echo "== 1/2 用项目自带 vite 打一个探针 bundle（要拿到 naive-ui 的 ImageGroup 真实实现）=="
node node_modules/vite/bin/vite.js build --config docs/probes/preview-fade/vite.config.mjs

FILTER='GPU process\|Dawn\|deprecated\|Security Warning\|font-weight\|Content Security\|renderer process\|For more\|electronjs.org\|once the app\|development build of Vue\|production build\|Autofill\|DevTools'

for MODE in buggy fixed; do
    echo
    echo "== 2/2 真 Chromium 跑探针（mode=$MODE）=="
    set +e
    env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe \
        docs/probes/preview-fade/run.cjs "$MODE" 2>&1 | grep -v "$FILTER"
    set -e
done
