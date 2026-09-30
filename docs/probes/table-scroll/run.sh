#!/usr/bin/env bash
# 表格"内部滚动 + 表头吸顶" —— 一键复算
#
#   bash docs/probes/table-scroll/run.sh
#
# 用**项目自带的 electron** 当真实浏览器（不另装 playwright / happy-dom），
# 页面里加载的是**真的 naive-ui UMD 包**（node_modules/naive-ui/dist/index.js），
# 所以量到的是真组件 + 真 CSS，不是复刻。
#
# ⚠️ 本机 shell 注入了 ELECTRON_RUN_AS_NODE=1，直接跑 electron 会被当成 node
#    （require('electron') 拿不到 app），必须 `env -u` 真正删掉 —— 设成空字符串没用。
set -e
cd "$(dirname "$0")/../../.."

env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe docs/probes/table-scroll/run.cjs 2>&1 \
    | grep -v "GPU process\|Dawn\|deprecated\|Security Warning\|font-weight\|Content Security\|renderer process\|For more\|electronjs.org\|once the app\|development build\|production build\|unsafe-eval\|Policy set\|This warning" \
    | tee docs/probes/table-scroll/out.log
