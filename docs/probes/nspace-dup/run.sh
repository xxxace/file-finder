#!/usr/bin/env bash
# n-space 重复 key 探针 —— 一键复算
#
#   bash docs/probes/nspace-dup/run.sh [happy-dom 所在 node_modules 目录]
#
# 为什么 happy-dom 不在仓库依赖里：它只是探针的 DOM 替身，不该进 package.json。
# 缺了就自己装一个：
#   mkdir -p "$TEMP/ff-vue-probe" && cd "$TEMP/ff-vue-probe" \
#     && npm i happy-dom --registry=https://registry.npmmirror.com --no-audit --no-fund
#
# 定位：真机界面（Electron 窗口）无头验不了；但**"同一次状态切换会不会渲染出重复节点"
# 是纯渲染问题**，可以在 happy-dom + 真 naive-ui 下复现/验证。这不等于界面配色对。
set -e

PROJ=D:/code/file-finder
ESB="$PROJ/node_modules/esbuild/bin/esbuild"
HAPPY_NM="${1:-/c/Users/<user>/AppData/Local/Temp/ff-vue-probe/node_modules}"

cd "$(dirname "$0")"

COMMON=(
    --bundle --platform=node --format=cjs --external:happy-dom
    --alias:vue="$PROJ/node_modules/vue/dist/vue.cjs.js"
    --alias:naive-ui="$PROJ/node_modules/naive-ui"
    --define:process.env.NODE_ENV='"development"'
    --define:__VUE_OPTIONS_API__=true
    --define:__VUE_PROD_DEVTOOLS__=false
    --define:__VUE_PROD_HYDRATION_MISMATCH_DETAILS__=false
    --log-level=warning
)

echo "== 1/4 生成 render（真编译 SFC 模板） =="
NODE_PATH="$PROJ/node_modules" node templates.cjs

echo
echo "== 2/4 打包 =="
node "$ESB" repro.mjs "${COMMON[@]}" --outfile=repro.cjs
node "$ESB" verify.mjs "${COMMON[@]}" --outfile=verify.cjs

echo
echo "== 3/4 复现（改前的 n-space 结构） =="
NODE_PATH="$HAPPY_NM" node repro.cjs 2>&1 | grep -v "Failed to resolve component" | grep -v "native custom element" | grep -v "at <"

echo
echo "== 4/4 验证（改后的结构） =="
NODE_PATH="$HAPPY_NM" node verify.cjs 2>&1 | grep -v "Failed to resolve component" | grep -v "native custom element" | grep -v "at <"

echo
echo "== 5/5 布局对照（真 Chrome，需 playwright；量的是"工具条有几行"） =="
PLAY_NM="${2:-$HAPPY_NM}"
node "$ESB" layout-entry.ts --bundle --platform=browser --format=iife --outfile=layout-bundle.js \
    --alias:vue="$PROJ/node_modules/vue/dist/vue.esm-bundler.js" \
    --alias:naive-ui="$PROJ/node_modules/naive-ui" \
    --define:process.env.NODE_ENV='"development"' \
    --define:__VUE_OPTIONS_API__=true \
    --define:__VUE_PROD_DEVTOOLS__=false \
    --define:__VUE_PROD_HYDRATION_MISMATCH_DETAILS__=false \
    --log-level=warning
NODE_PATH="$PLAY_NM" node layout-measure.cjs
