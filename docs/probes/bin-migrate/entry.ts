/**
 * 探针入口：**只做转出口**，把 app 自己的模块交给探针脚本用。
 * 全部读/写都走 app 的真实代码（加解密、bin 仓、zip），探针里不重新实现任何格式。
 *
 * ⚠️⚠️ **导入这个 bundle = 就地加载 `process.env.USERPROFILE` 指向的那个缓存库，
 * 并（在有旧格式记录时）自动迁移它。** 所以任何用到它的脚本**必须**
 * **先**把 USERPROFILE 指到一个副本目录再 require —— 否则动的是主人的真库。
 * （2026-10-04 踩过：一个临时统计脚本忘了这一步，把真库迁了。）
 */
export * from '../../../electron/utils/cacheCrypto';
export * from '../../../electron/utils/binStore';
export * from '../../../electron/utils/zip';
export * from '../../../electron/server/nedb';
