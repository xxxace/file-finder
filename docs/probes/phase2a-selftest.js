/* 管理助手 · Phase 2A 一键自测（粘到应用 DevTools 的 Console 里跑）
 *
 * 设计目标：**零占位符**。你不用知道 serial 是什么、目录要用什么格式 ——
 * 它自己去问应用"哪块盘在线、缓存里有什么"，然后挑目标、起抓取、报结果。
 *
 * 为什么必须在这里跑（而不是一个 node 脚本）：本地服务的口令是进程启动时
 * 随机生成、只活在主进程内存里的，只有应用自己的窗口能通过 IPC 拿到它。
 * 这正是"任意网页都打不开这个服务"的原因 —— 不能为了方便把它改成可读文件。
 */
(async () => {
    const t = require('electron').ipcRenderer.sendSync('ff-token');
    const API = 'http://127.0.0.1:3060';
    const get = p => fetch(`${API}${p}${p.includes('?') ? '&' : '?'}t=${t}`).then(r => r.json());
    const post = (p, body) =>
        fetch(`${API}${p}?t=${t}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        }).then(r => r.json());

    const LIMIT = 0; // 0 = 能抓的全抓（想先试几条就改成 5）

    console.log('① 查在线的盘（会重扫一下盘符，稍等）…');
    const { disks = [] } = await get('/getDisks');
    const online = disks.filter(d => d.online);
    if (!online.length) return console.warn('没有在线的盘。插上移动盘、在主界面点一下重新扫描，再跑这段。');

    const pick = online.sort((a, b) => (b.covers || 0) - (a.covers || 0))[0];
    console.log(
        `   在线：${online.map(d => `${d.serial}(${d.covers || 0}条)`).join('  ')}\n` +
            `   选中缓存最多的那块：${pick.serial}`,
    );

    console.log('② 找没封面的位置（只读缓存，不碰盘）…');
    const scan = await post('/assistant/scan', { serial: pick.serial, relPath: '' });
    const unmatched = scan.unmatched || [];
    console.log(
        `   看了 ${scan.scannedDocs} 条缓存记录：\n` +
            `   · ${scan.targets.length} 个能认出番号 → 去网站抓\n` +
            `   · ${unmatched.length} 个认不出番号 → 不猜（猜了只会抓到别人的片子）\n` +
            `   · ${scan.skippedCategory || 0} 个是分类目录 → 本来就不需要补，正确跳过`,
    );
    if (unmatched.length) {
        console.log('   认不出番号的（前 20 个）：');
        console.table(unmatched.slice(0, 20).map(x => ({ 位于: x.dir, 名字: x.name })));
    }
    if (!scan.targets.length) {
        return console.warn('没有能认出番号的视频。先去主界面点开几个装影片的文件夹（让它进缓存），再跑一次。');
    }
    console.log('   能抓的前 10 个：');
    console.table(scan.targets.slice(0, 10).map(x => ({ 将写入: x.writeRel, 形态: x.kind, 查询名: x.name })));

    const targets = LIMIT ? scan.targets.slice(0, LIMIT) : scan.targets;
    console.log(`③ 起抓取任务：抓 ${targets.length} 条（每条约几秒，整批可能要几分钟）…`);
    const started = await post('/assistant/jobs', { kind: 'grab', targets });
    if (!started.jobId) return console.warn('没能起任务：', started);

    for (let i = 0; i < 400; i++) {
        await new Promise(r => setTimeout(r, 3000));
        const { job } = await get(`/assistant/jobs?id=${started.jobId}`);
        if (!job) return console.warn('任务不见了（应用是不是重启过？）');
        const p = job.progress;
        console.log(
            `   ${job.status}  ${p.processed}/${p.total}  命中 ${p.hits}  未命中 ${p.misses}  被拦 ${p.blocked}  ${p.current}`,
        );
        if (job.status === 'running') continue;

        console.log(`\n④ ${job.message}`);
        console.table(
            job.rows.map(r => ({
                将写入: r.writeRel,
                状态: r.status,
                站点: r.hitSite,
                封面: r.coverUrl,
                说明: r.message,
            })),
        );
        if (!p.blocked) return console.log('✅ 链路通了。封面 URL 拿到即为成功（这次不写任何文件）。');
        return console.warn(
            '有站点要求人工验证。粘贴下面这行过一次（会弹窗，你手点完自动关）：\n' +
                `(await fetch('${API}/assistant/jobs?t=${t}',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({kind:'challenge',siteId:'javdock'})}).then(r=>r.json()))`,
        );
    }
    console.warn('等太久了，先不看了。可以到 Console 里查任务：', started.jobId);
})();
