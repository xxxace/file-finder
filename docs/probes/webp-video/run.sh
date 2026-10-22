#!/usr/bin/env bash
# WebP / 无封面视频 抽帧探针 —— 一键复算
#
#   bash docs/probes/webp-video/run.sh          # 结果同时落到 out.txt
#
# ⚠️ 必须用 **Electron** 跑（被测模块依赖 nativeImage）。
# ⚠️ 素材现场合成到系统临时目录，不碰移动硬盘、不碰真库。
set -e
cd "$(dirname "$0")/../../.."

echo "== 1/2 用 app 自己的模块打探针 bundle =="
node node_modules/esbuild/bin/esbuild docs/probes/webp-video/entry.ts \
    --bundle --platform=node --format=cjs --target=node20 \
    --external:electron --external:fluent-ffmpeg --external:@ffmpeg-installer/ffmpeg \
    --external:@ffprobe-installer/ffprobe \
    --outfile=docs/probes/webp-video/bundle.cjs --log-level=warning

echo
echo "== 2/2 真 Electron 跑探针 =="
# ⚠️ 宿主环境（WorkBuddy）导出了 ELECTRON_RUN_AS_NODE=1，不清掉的话 electron.exe 会
# 直接退化成 node，`require('electron')` 拿到 undefined（实测报 whenReady 不存在）。
unset ELECTRON_RUN_AS_NODE
# 无头/沙箱环境里 GPU 进程会崩（`GPU process isn't usable. Goodbye.`），关掉即可
node_modules/electron/dist/electron.exe --disable-gpu --no-sandbox docs/probes/webp-video/probe.cjs
