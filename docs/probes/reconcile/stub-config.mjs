/**
 * 探针专用桩：把数据目录指到 %TEMP% 下的**隔离目录**。
 *
 * 真 `electron/config/index.ts` 算的是 `$USERPROFILE/.file-finder` —— 那是**主人的真库**。
 * 探针会写缓存记录，绝不能落到那里（`searchCache.db` 就是全部数据）。
 * 路径由 `FF_PROBE_DATA` 传入，跑完连同夹具一起删。
 */
export default {
    userBasePath: process.env.FF_PROBE_DATA,
};
