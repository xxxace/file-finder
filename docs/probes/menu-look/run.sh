#!/usr/bin/env bash
# 「更多」菜单外观是否真的生效 —— 真 Chromium + 真 naive-ui UMD + 真编译 CSS
#
# ⚠️ `env -u ELECTRON_RUN_AS_NODE` 不能省（本机 shell 注入了这个变量，
#    不删掉 electron 会退化成纯 Node、根本不跑窗口）
# ⚠️ 证据写 out.txt（`.gitignore` 挡 *.log）
set -u
cd "$(dirname "$0")/../../.." || exit 1
env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe \
    docs/probes/menu-look/run.cjs > docs/probes/menu-look/out.txt 2>&1
code=$?
tail -45 docs/probes/menu-look/out.txt
exit $code
