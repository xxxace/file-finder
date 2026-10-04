#!/usr/bin/env bash
# 「多文件弹层」视觉探针 —— 一键复算
#
#   bash docs/probes/popup-visual/run.sh
#
# 问的是「这一层到底长什么样、改后有没有真的变好」—— 那是布局 + 继承，
# 只有拿真编译的 CSS 在真 Chromium 里渲染出来才算证据。
set -e
cd "$(dirname "$0")/../../.."

echo "== 1/2 真实编译 index.vue 的 scoped CSS =="
node docs/probes/popup-visual/build-css.mjs

echo
echo "== 2/2 真 Chromium 渲染 + 出对照图 =="
env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe docs/probes/popup-visual/run.cjs 2>&1 \
    | grep -v "GPU process\|Dawn\|deprecated\|Security Warning\|font-weight\|Content Security\|renderer process\|For more\|electronjs.org\|once the app\|development build of Vue\|production build\|Autofill\|DevTools\|Electron Sec" \
    | tee docs/probes/popup-visual/out.txt
