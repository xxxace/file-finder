#!/usr/bin/env bash
# 预览图撑满探针 —— 一键复算
#
#   bash docs/probes/preview-fill/run.sh
#
# 用**项目自带的 electron** 当真实浏览器（不需要另装 playwright / happy-dom）：
# 量的是预览图在真实 Chromium 布局下的最终盒尺寸与显示尺寸。
#
# 为什么不用 happy-dom：本探针问的是"占多大" ——
# `width:100% + object-fit:contain + 脚手架 max-*` 三者相互作用后的结果，
# 那是布局计算；happy-dom 不做真实布局，getBoundingClientRect 是假的。
#
# ⚠️ 本机 shell 注入了 ELECTRON_RUN_AS_NODE=1，直接跑 electron 会被当成 node
#    （require('electron') 拿不到 app），必须 `env -u` 真正删掉它 —— 设成空字符串没用。
set -e
cd "$(dirname "$0")/../../.."

env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe docs/probes/preview-fill/run.cjs 2>&1 \
    | grep -v "GPU process\|Dawn\|deprecated\|Security Warning\|font-weight\|Content Security\|renderer process\|For more\|electronjs.org\|once the app\|development build of Vue\|production build" \
    | tee docs/probes/preview-fill/out.txt
