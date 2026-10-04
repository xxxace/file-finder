#!/usr/bin/env bash
# perf-tick —— 图片链路的性能基线。一键复算：
#
#   bash docs/probes/perf-tick/run.sh            # 全部三段
#   bash docs/probes/perf-tick/run.sh read       # 只量取图（纯 node，不付 Electron 启动的钱）
#   bash docs/probes/perf-tick/run.sh write      # 只量写盘 + 只加密的占比 + 并发 vs 串行
#   bash docs/probes/perf-tick/run.sh pipeline   # 只跑「写盘与解码重叠」的 A/B
#
# 量什么、结论是什么：见同目录 README.md（结论已写进 docs/DESIGN-PREVIEW-CACHE §十二）。
#
# ⚠️ 三个必须记住的坑（都在 README 里，这里是会踩到它们的那一层）：
#   ① `app.exit()` 会吞掉 stdout ⇒ 探针把结果**写进 out-*.txt**，别指望终端有输出。
#   ② 沙箱/无 GPU 机器上必须带 --disable-gpu 等开关，否则 Electron 会让 GPU 进程崩掉。
#   ③ 比"两次产出是否一致"必须**解密后比明文**（putBin 每次用随机 IV，密文必然不同）。
# ⚠️ 只碰**系统盘**上的 bin 仓 ⇒ 零移动硬盘读；写入全部落在临时目录。
set -e
cd "$(dirname "$0")/../../.."

WHAT="${1:-all}"
P=docs/probes/perf-tick

# 纯 node 段：entry-bin.ts（只有文件 IO，不拉进 electron）
# Electron 段：entry.ts + --external:electron（thumbnail 要 nativeImage）
# ⚠️ 两个 entry 不是重复，是必需的 —— CJS bundle 全量求值，详见 entry-bin.ts 的注释。
build() {
  local out="$1" src="$2"; shift 2
  node node_modules/esbuild/bin/esbuild "$P/$src" \
      --bundle --platform=node --format=cjs --target=node20 "$@" \
      --outfile="$P/$out" --log-level=warning
}

case "$WHAT" in
  read|write)
    echo "== 量 $WHAT（纯 node） =="
    build bundle-node.cjs entry-bin.ts
    node "$P/probe.cjs" "$WHAT" | tee "$P/out-$WHAT.txt"
    ;;
  pipeline)
    echo "== 量 写盘与解码重叠 的 A/B（Electron） =="
    build bundle-electron.cjs entry.ts --external:electron
    env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe \
        --disable-gpu --disable-gpu-compositing --disable-software-rasterizer --no-sandbox \
        "$P/pipeline.cjs" >/dev/null 2>&1 || true
    cat "$P/out-pipeline.txt"
    ;;
  all)
    "$0" read
    echo
    "$0" write
    echo
    "$0" pipeline
    ;;
  *)
    echo "未知参数：$WHAT（可用：read | write | pipeline | all）" >&2
    exit 1
    ;;
esac
