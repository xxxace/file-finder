# perf-tick —— 图片链路的性能基线（只量数字，不改数据）

全部只碰**系统盘**上的 bin 仓 ⇒ **零移动硬盘读**；写入都落在系统临时目录。

| 命令 | 量什么 | 结论 |
|---|---|---|
| `bash run.sh read` | 取图耗时（热 / 一屏 216 张 / 页缓存命中） | 一屏 155 ms、单张最坏 1.4 ms ⇒ **不需要内存缓存** |
| `bash run.sh write` | 写盘耗时、**只加密**的占比、并发 vs 串行 | 加密只占 0.04 ms（不是瓶颈）；写一屏 1.36 s |
| `bash run.sh pipeline` | 「写盘与解码重叠」这个改动的 A/B（Electron） | 7 轮中位 **333 → 154 ms（2.16×）**，产出明文逐字节一致 |

结论已写进 `docs/DESIGN-PREVIEW-CACHE-2026-10-04.md` §十二。
**这个探针该留的判据**：性能基线 —— 以后改档位、改写盘策略、改并发都要拿它复算，属于"会被反复重跑"。

## 文件清单（只有这些该入库）

```
entry.ts          Electron 段转出口（含 thumbnail，要 nativeImage）
entry-bin.ts      纯 node 段转出口（只有文件 IO）
probe.cjs         量取图 / 写盘（纯 node，三个模式：read | write | writebreak）
pipeline.cjs      量「写盘与解码重叠」的 A/B（Electron）
run.sh            唯一入口，按参数跑其中一段
README.md         本文件
out-*.txt         实测证据（结论的原始数字）
```

`bundle-*.cjs` 是**构建产物**（`run.sh` 每次重建），已被 `.gitignore` 精确挡掉 ——
⚠️ 规则是 `docs/probes/*/bundle*.cjs`，**不能用 `*.cjs`**：探针源码本身就是 `.cjs`。

## 四个坑（都踩过）

1. **CJS bundle 是全量求值的** —— esbuild 的 `--external:electron` 只是把 `require('electron')`
   留成外部调用，纯 node 进程跑到它照样抛 `Cannot find module 'electron'`。
   ⇒ 含 `nativeImage` 的模块必须走独立的 entry（这就是 `entry.ts` / `entry-bin.ts` 并存的原因）。
2. **`app.exit()` 会吞掉 stdout** —— Electron 主进程里"跑完了但什么都没打印"。
   ⇒ `pipeline.cjs` 把结果**写进 `out-pipeline.txt`** 再退出。
3. **沙箱/无 GPU 机器上必须加 `--disable-gpu --disable-gpu-compositing
   --disable-software-rasterizer --no-sandbox`** —— 一旦脚本用了 `app.whenReady()`，
   Electron 会初始化完整 GUI 并让 GPU 进程崩（`GPU process isn't usable. Goodbye.`）。
4. **判据不能落在密文上** —— `putBin` 每次写用随机 IV，同一明文两次写出的密文必然不同。
   比"两次产出是否一致"必须**先解密再哈希明文**（与"拿 base64 字符长度当图片大小"同一类错：
   **判据落在了错误的层**）。

## 判据必须多轮

单次测量是噪声：同一个改动，A 两次量到 **683 ms / 363 ms**（差 2 倍）。
`pipeline.cjs` 固定 7 轮交替 A/B 取分布（最终落在 330–360 / 152–165）。
