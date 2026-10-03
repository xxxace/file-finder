#!/usr/bin/env bash
# 「多部组成」popover 点击归属探针 —— 一键复算
#
#   bash docs/probes/popover-pick/run.sh
#
# 用**项目自带的 electron** 当真实浏览器（不需要另装 playwright / happy-dom）：
# 问的是"点第 N 项的落点属于谁"，那是命中测试 + 真实布局，只有真 Chromium 能给答案。
set -e
cd "$(dirname "$0")/../../.."

echo "== 1/3 从活源码切出 popover markup =="
node docs/probes/popover-pick/templates.cjs

echo
echo "== 2/3 真实编译 index.vue 的 scoped CSS =="
node docs/probes/popover-pick/build-css.mjs

echo
echo "== 3/3 真 Chromium 跑探针 =="
env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe docs/probes/popover-pick/run.cjs 2>&1 \
    | grep -v "GPU process\|Dawn\|deprecated\|Security Warning\|font-weight\|Content Security\|renderer process\|For more\|electronjs.org\|once the app\|development build of Vue\|production build\|Autofill\|DevTools" \
    | tee docs/probes/popover-pick/out.txt
