/**
 * 探针数据回收器 —— 只在本机 127.0.0.1:5189 监听，收一条 POST 写一个 json，然后退出。
 *
 * 为什么不用浏览器自动化：这里只需要"页面把测量结果送出来"，一个 20 行的 HTTP 服务就够。
 * 目的：拿到**含绘制的真实帧时间**（`--virtual-time-budget` 会把时间轴搞乱，量不到）。
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const OUT = path.join(__dirname, 'bench.json');
const port = Number(process.env.PROBE_PORT || 5189);

const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'Access-Control-Allow-Headers': 'content-type' });
        res.end();
        return;
    }
    if (req.method !== 'POST') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('probe collector');
        return;
    }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
        fs.writeFileSync(OUT, body);
        res.writeHead(204).end();
        console.log('[collect] wrote', OUT, body.length, 'bytes');
        // 给浏览器一点时间收尾再退
        setTimeout(() => process.exit(0), 200);
    });
});

server.listen(port, '127.0.0.1', () => console.log('[collect] listening', port));
setTimeout(() => { console.log('[collect] timeout'); process.exit(1); }, 40000);
