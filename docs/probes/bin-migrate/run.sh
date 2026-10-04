#!/usr/bin/env bash
# 图片出库迁移 + bin 仓 + zip 的真数据探针 —— 一键复算
#
#   bash docs/probes/bin-migrate/run.sh        # 结果同时落到 out.txt
#
# ⚠️ 用**纯 node** 跑（不需要 Electron）：被测的是纯逻辑（加解密 / 文件仓 / zip），
#    它们都不依赖 Electron。
# ⚠️ 探针只在临时目录里动**真库的副本**，不碰真库、不碰移动硬盘。
# ⚠️ 第 3 步（让**系统**去解我们写的 zip）**故意不放在这个脚本里**：
#    从 bash 里调 powershell 会绕过 PowerShell 的安全检查，工具链会拦（拦得对）。
#    那一步用 PowerShell 工具单独跑，命令见本目录 README.md。
set -e
cd "$(dirname "$0")/../../.."

echo "== 1/2 用 app 自己的模块打一个探针 bundle =="
node node_modules/esbuild/bin/esbuild docs/probes/bin-migrate/entry.ts \
    --bundle --platform=node --format=cjs --target=node20 \
    --outfile=docs/probes/bin-migrate/bundle.cjs --log-level=warning

echo
echo "== 2/2 跑探针（迁移 + bin + zip） =="
node docs/probes/bin-migrate/probe.cjs | tee docs/probes/bin-migrate/out.txt

echo
echo "zip 已写到：$(cat "$TMPDIR/ff-migrate-zip-path.txt" 2>/dev/null || cat "$TEMP/ff-migrate-zip-path.txt" 2>/dev/null || echo '（见 out.txt）')"
echo "下一步（外部校验）用 PowerShell 工具跑："
echo "  Expand-Archive -LiteralPath '<zip 路径>' -DestinationPath '<临时目录>/unzipped' -Force"
