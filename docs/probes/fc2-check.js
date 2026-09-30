/* FC2 探针：**哪个站真的收 FC2？**
 * ===========================================================================
 * ⚠️ 本文件的前一版是错的，故意留在这里当教训：
 *   旧版拿 `FC2-PPV-<数字>` 去打 **javbus**，以为"抽到封面 = 假设成立"。
 *   但 javbus 是**综合番号库，根本不收 FC2** —— 打过去必然是 404，
 *   脚本会得出"这些数字不是 FC2 番号"的**假阴性**结论。
 *   判据本身无效，跑一百遍也是零信息。
 *
 * 怎么发现的（可复现，2026-09-25）：
 *   `https://www.javbus.com/FC2-PPV-1000001`          → 404
 *   `https://www3.javdock.com/zh/video/FC2-PPV-1000001` → 真作品页（「示例作品标题A…」）
 *   同一个 ID，一个站没有、另一个站有 → 说明是**站的选择**问题，不是 ID 的问题。
 *
 * 所以正确做法是：**先横向筛站，再纵向验 ID**。本脚本只做前半段。
 *
 * 用法：Electron dev 里 Ctrl+Shift+I → Console 粘贴。
 * 依赖：dev 正在跑（token 只活主进程内存，所以不能做成 node 脚本）。
 */
(async () => {
    const t = require('electron').ipcRenderer.sendSync('ff-token');
    const API = 'http://127.0.0.1:3060';
    const post = (p, body) =>
        fetch(`${API}${p}?t=${t}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        }).then(r => r.json());
    const get = p => fetch(`${API}${p}?t=${t}`).then(r => r.json());

    // 这三个都**已确认是真实 FC2 作品**（前两个我逐条在 javdock 上验过；
    // 第三个是你盘里带前缀那条，javdock 上是「示例作品标题A」）。
    // 用已知存在的 ID 当"探针"，才能区分"站没有"和"ID 不存在"。
    const KNOWN_GOOD = ['FC2-PPV-1000002', 'FC2-PPV-1000003', 'FC2-PPV-1000001'];

    const rules = await get('/assistant/rules');
    const list = Array.isArray(rules) ? rules : rules.rules || [];
    if (!list.length) {
        console.warn('拿不到站点规则，dev 起来了吗？');
        return;
    }

    const rows = [];
    for (const rule of list) {
        for (const q of KNOWN_GOOD) {
            const r = await post('/assistant/dryrun', { siteId: rule.id, query: q });
            rows.push({
                站点: rule.id,
                默认启用: rule.enabled ? '是' : '',
                查询: q,
                结果: r.ok ? '抽到封面' : r.cf ? '被 CF 拦' : r.err ? `错:${r.err}` : '没抽到',
                标题: (r.fields && r.fields.title) || '',
            });
        }
    }
    console.table(rows);

    const per = {};
    for (const r of rows) {
        per[r.站点] = per[r.站点] || { 命中: 0, 总数: 0 };
        per[r.站点].总数 += 1;
        if (r.结果 === '抽到封面') per[r.站点].命中 += 1;
    }
    console.log('\n—— 哪个站收 FC2 ——');
    for (const [s, v] of Object.entries(per)) {
        console.log(`  ${s.padEnd(12)} ${v.命中}/${v.总数}${v.命中 ? '  ← 可用' : ''}`);
    }
    console.log(
        '\n注："没抽到"里混着两种情况，本接口现在还分不出来：' +
            '① 该站没这片（404）② 页面在但封面选择器不对。' +
            '要校准规则得先把这两种分开显示。',
    );
})();
