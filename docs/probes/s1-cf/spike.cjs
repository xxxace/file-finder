/**
 * S1 抓取 Spike —— 隐藏 BrowserWindow 过 Cloudflare + 单站命中率
 * ===========================================================================
 * 对应：docs/PRD-manager-assistant-2026-09-25.md §14(S1) ＋ docs/SPIKE-S1-runbook-2026-09-25.md
 *
 * 运行方式（在你的【真机】上，装了本仓库依赖的前提下）：
 *   cd D:/code/file-finder
 *   node_modules/.bin/electron docs/probes/s1-cf/spike.cjs
 *
 * 设计要点（对照 runbook）：
 *   - 单例隐藏窗：show:false ＋ partition:'persist:assistant'
 *     （PRD D1/D12：抓取全程留在 Chromium 网络栈，cf_clearance 与 IP+UA+TLS 三绑定，
 *      不取 cookie 交给 Node fetch）
 *   - webPreferences 严格按 D12：nodeIntegration:false / contextIsolation:true / sandbox:true
 *     ＋ 真实 Chrome UA（不暴露 Electron 指纹）
 *   - 轮询「内容标记选择器」而非仅靠 did-finish-load：CF 挑战页会先完成加载
 *   - 命中 CF：用【同 partition】开一个【可见】窗，你在窗口内验证后【关闭窗口】即继续（不再等终端回车，避免焦点问题卡死）
 *   - 每站对若干真实番号统计：通道是否通 / 封面 URL 是否抽到
 *
 * ⚠️ 诚实声明：
 *   - 下面 SITES 里的 detailUrl / markers / cover / title 是【初始猜测】，用于在真机上调通通道。
 *     具体 DOM 由各站实际页面决定，务必用 PRD 的「规则试跑闸门」逐个校准后再信命中率。
 *   - SAMPLE_IDS 是占位番号，真机运行前请替换成你自己库里真实存在的番号（否则命中率必然偏低）。
 *   - 本脚本不碰主程序一字节，不写任何业务文件，只输出结果到 stdout 与 ./result.json，
 *     并自动生成 ./spike-S1-result.md（覆盖式，仅当本脚本在真机跑出真实数据时才有意义）。
 */

const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const path = require("path");

const OUT_DIR = __dirname;
const PARTITION = "persist:assistant";
const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const NAV_TIMEOUT = 25000; // 单次导航最长等待
const POLL_INTERVAL = 500; // 轮询间隔
const POLL_TIMEOUT = 20000; // 轮询内容标记的最长等待（CF 挑战可能更久，需人工过）

// ---- 站点配置（初始猜测，真机校准） ----
const SITES = {
  javbus: {
    label: "javbus",
    detail: (id) => `https://www.javbus.com/${id}`,
    markers: [
      ".movie img",
      ".movie .photo-frame img",
      "#waterfall .movie .photo-frame img",
      "img.avatar",
    ],
    cover: [".movie img", ".movie .photo-frame img", "#waterfall .movie .photo-frame img"],
    title: [".movie .photo-info h3", "h3"],
  },
  freejavbt: {
    label: "freejavbt",
    detail: (id) => `https://freejavbt.com/${id}`,
    markers: [".entry-content img", "img.wp-post-image", ".post-thumbnail img", ".movie img", "img"],
    cover: [".entry-content img", "img.wp-post-image", ".movie img"],
    title: [".entry-title", "h1", ".title"],
  },
  javwine: {
    label: "javwine",
    detail: (id) => `https://javwine.com/${id}`,
    markers: [".movie img", ".cover img", "img"],
    cover: [".movie img", ".cover img"],
    title: [".title", "h1"],
  },
  javdock: {
    label: "javdock",
    detail: (id) => `https://javdock.net/${id}`,
    markers: [".movie .photo-frame img", "img"],
    cover: [".movie .photo-frame img", "img"],
    title: [".title", "h1"],
  },
  onejav: {
    label: "onejav",
    detail: (id) => `https://onejav.com/${id}`,
    markers: [".movie img", "img"],
    cover: [".movie img", "img"],
    title: [".title", "h1"],
  },
  // 演员站（用于 Phase 4，本 spike 一并探通道）
  javtext: {
    label: "javtext.net(actress)",
    detail: (id) =>
      `https://javtext.net/?type=actress&q=${encodeURIComponent(id)}`,
    markers: [".actress img", "img"],
    cover: [".actress img", "img"],
    title: [".actress .name", "h1"],
  },
};

// 番号清单 —— 已由用户替换为真实存在的番号（TST-218 / TST-229）；可按需增减
const SAMPLE_IDS = ["TST-218", "TST-229"];

// ---- 工具 ----
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// 在页面内检测是否还卡在 CF / Turnstile 挑战
function cfDetectJS() {
  return `(function(){
    var title=(document.title||'').toLowerCase();
    var cf = /just a moment|checking your browser|verify you are (a )?human|attention required/i.test(title)
      || !!document.querySelector('#cf-challenge-running, .cf-challenge, #challenge-form, form[action*="__cf_chl"]')
      || !!window._cf_chl_opt
      || /cf-chl-|challenge-platform|turnstile/i.test(document.body.innerHTML);
    return { cf: cf, url: location.href, title: document.title };
  })()`;
}

// 在页面内检查「内容标记」是否出现，并返回候选封面 src
function probeJS(markers, cover, title) {
  return `(function(){
    function first(sels){ for(var s of sels){ var el=document.querySelector(s); if(el) return el; } return null; }
    function rawSrc(el){ if(!el) return '';
      var s = el.getAttribute('src')||el.getAttribute('data-src')||el.getAttribute('data-original')||'';
      if(!s && el.getAttribute('srcset')){ s = el.getAttribute('srcset').split(',')[0].trim().split(' ')[0]; }
      if(s && s.indexOf('//')===0) s='https:'+s;
      return s;
    }
    // 黑名单：这些路径的图不是影片封面（站点 logo / 主题图 / 图标 / 占位），抽到了也不能算命中
    var badPath = /logo|theme|banner|avatar|spinner|placeholder|icon|1px|pixel|loading|ajax|sprite/i;
    var markerEl = first(${JSON.stringify(markers)});
    var coverEl = first(${JSON.stringify(cover)});
    var titleEl = first(${JSON.stringify(title)});
    var coverSrc = rawSrc(coverEl) || null;
    if(coverSrc && badPath.test(coverSrc)) coverSrc = null; // 显式选择器命中的如果是 logo/主题图，判为非封面
    // 兜底：扫描所有 <img>，挑第一个真实图片 URL（同样排除 logo/主题/图标）
    var fb=null; var samples=[];
    var all=document.images;
    for(var i=0;i<all.length;i++){ var im=all[i]; var s=rawSrc(im); if(!s) continue;
      if(samples.length<5) samples.push(s.slice(0,120));
      if(!fb && /^https?:/i.test(s) && /\\.(jpe?g|png|webp)/i.test(s) && !badPath.test(s)){ fb=s; }
    }
    return {
      marker: !!markerEl,
      cover: coverSrc,
      coverFallback: fb,
      title: titleEl ? (titleEl.textContent||'').trim() : null,
      imgs: all.length,
      sampleSrcs: samples
    };
  })()`;
}

async function waitForMarker(win, site, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastCf = false;
  while (Date.now() < deadline) {
    let info;
    try {
      info = await win.webContents.executeJavaScript(cfDetectJS());
    } catch (e) {
      // 页面可能正在跳转
      await sleep(POLL_INTERVAL);
      continue;
    }
    lastCf = info.cf;
    if (info.cf) {
      await sleep(POLL_INTERVAL);
      continue;
    }
    // 非 CF 挑战页，检查内容标记
    let probe;
    try {
      probe = await win.webContents.executeJavaScript(
        probeJS(site.markers, site.cover, site.title),
      );
    } catch (e) {
      await sleep(POLL_INTERVAL);
      continue;
    }
    if (probe.marker) return { ok: true, cf: false, probe };
    await sleep(POLL_INTERVAL);
  }
  return { ok: false, cf: lastCf, probe: null };
}

// 人工过一次 CF：同 partition 开【可见】窗，用户在窗口内完成验证后【关闭窗口】即继续
function manualPass(url) {
  return new Promise((resolve) => {
    const vw = new BrowserWindow({
      show: true,
      width: 1100,
      height: 800,
      webPreferences: {
        partition: PARTITION,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        userAgent: CHROME_UA,
      },
    });
    vw.loadURL(url).catch(() => {});
    console.log(`\n[人工验证] 已打开可见窗口加载：${url}`);
    console.log("[人工验证] 在窗口内完成 Cloudflare / Turnstile 验证后，【关闭这个窗口】即可继续；");
    console.log("[人工验证] （若觉得是误报、根本没有挑战，直接关窗也会继续）");
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try { if (!vw.isDestroyed()) vw.destroy(); } catch (e) {}
      resolve();
    };
    vw.on("closed", finish);
    setTimeout(finish, 180000); // 3 分钟兜底，绝不卡死
  });
}

async function loadHidden(url) {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      partition: PARTITION,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      userAgent: CHROME_UA,
    },
  });
  try {
    await win.loadURL(url, { timeout: NAV_TIMEOUT });
  } catch (e) {
    // 超时也可能只是 CF 挑战慢，继续轮询
  }
  return win;
}

async function run() {
  await app.whenReady();
  console.log("=== S1 Spike 开始 ===");
  console.log(`partition=${PARTITION}  ua=${CHROME_UA.slice(0, 40)}...`);

  const results = {};
  for (const key of Object.keys(SITES)) {
    const site = SITES[key];
    console.log(`\n---------- [${site.label}] ----------`);
    let channelOk = 0;
    let coverHit = 0;
    let cfBlocked = 0;
    let neededManual = 0;
    let neededCookie = 0;
    let errors = 0;
    const details = [];

    for (const id of SAMPLE_IDS) {
      const url = site.detail(id);
      let win;
      let res;
      try {
        win = await loadHidden(url);
        res = await waitForMarker(win, site, POLL_TIMEOUT);
        if (!res.ok && res.cf) {
          cfBlocked++;
          neededManual++;
          // 同 partition 开可见窗，用户在窗口内过 CF；关闭窗口即继续
          await manualPass(url);
          // 复用 partition session（cf_clearance 已落盘），重新加载隐藏窗重试
          try {
            await win.loadURL(url, { timeout: NAV_TIMEOUT });
          } catch (e) {}
          await sleep(1000);
          res = await waitForMarker(win, site, POLL_TIMEOUT);
        }
        if (res.ok) {
          channelOk++;
          const c = res.probe && (res.probe.cover || res.probe.coverFallback);
          if (c) coverHit++;
          else {
            neededCookie++; // 通道通了但没抽到封面（选择器不准 / 需 cookie）
            const d = res.probe || {};
            console.log(
              `    ⚠ 通道通但封面未抽到：imgs=${d.imgs || 0} 样例=${(d.sampleSrcs || []).map((s) => s.slice(0, 70)).join(" | ") || "无"}`,
            );
          }
        }
      } catch (e) {
        errors++;
        res = { ok: false, cf: false, probe: null, err: e.message };
      } finally {
        if (win)
          try {
            win.destroy();
          } catch (e) {}
      }
      const c = res.ok && res.probe ? res.probe.cover || res.probe.coverFallback || null : null;
      const viaFallback = res.ok && res.probe && !res.probe.cover && !!res.probe.coverFallback;
      const hit = c
        ? viaFallback
          ? "封面✓(兜底)"
          : "封面✓"
        : res.ok
          ? "通道✓封面✗"
          : res.cf
            ? "CF拦"
            : "失败";
      details.push({ id, url, status: hit, cover: c });
      console.log(`  ${id.padEnd(10)} -> ${hit}`);
    }

    const n = SAMPLE_IDS.length;
    const rate = ((coverHit / n) * 100).toFixed(0);
    results[key] = {
      label: site.label,
      n,
      channelOk,
      coverHit,
      cfBlocked,
      neededManual,
      neededCookie,
      errors,
      coverRate: Number(rate),
      details,
    };
    console.log(
      `  => 通道 ${channelOk}/${n}  封面命中 ${coverHit}/${n} (${rate}%)  CF拦 ${cfBlocked}  需人工 ${neededManual}  需cookie ${neededCookie}  错误 ${errors}`,
    );
  }

  // ---- go/no-go ----
  const best = Object.values(results).sort(
    (a, b) => b.coverRate - a.coverRate,
  )[0] || { coverRate: 0 };
  const verdict = best.coverRate >= 70 ? "GO ✅" : "NO-GO ❌";
  console.log(
    `\n=== go/no-go：最佳站点封面命中 ${best.coverRate}% >= 70% ? ${verdict} ===`,
  );

  fs.writeFileSync(
    path.join(OUT_DIR, "result.json"),
    JSON.stringify({ verdict, best: best.label, results }, null, 2),
  );
  writeMd(results, verdict, best);
  console.log(
    `\n结果已写：docs/probes/s1-cf/result.json  与  docs/probes/s1-cf/spike-S1-result.md`,
  );
  app.quit();
}

function writeMd(results, verdict, best) {
  const now = new Date().toISOString();
  let md = `# Spike S1 结果（实测 · ${now}）\n\n`;
  md += `> 由 \`docs/probes/s1-cf/spike.cjs\` 在真机运行产出。\n`;
  md += `> go/no-go：最佳站点封面命中 **${best.coverRate}%** → **${verdict}**\n\n`;
  md += `## 每站结果\n\n`;
  for (const key of Object.keys(results)) {
    const r = results[key];
    md += `### ${r.label}\n\n`;
    md += `| 指标 | 值 |\n|---|---|\n`;
    md += `| 样本数 | ${r.n} |\n| 通道通 | ${r.channelOk}/${r.n} |\n| 封面命中 | ${r.coverHit}/${r.n} (${r.coverRate}%) |\n`;
    md += `| CF 拦截 | ${r.cfBlocked} |\n| 需人工过验证 | ${r.neededManual} |\n| 通道通但需 cookie/选择器 | ${r.neededCookie} |\n| 错误 | ${r.errors} |\n\n`;
    md += `<details><summary>逐条明细</summary>\n\n`;
    md += `| 番号 | URL | 状态 | 封面 |\n|---|---|---|---|\n`;
    for (const d of r.details)
      md += `| ${d.id} | ${d.url} | ${d.status} | ${d.cover || "-"} |\n`;
    md += `\n</details>\n\n`;
  }
  md += `## 结论\n\n`;
  md += `- 是否至少 1 站 ≥70% 且 session 可复用：${best.coverRate >= 70 ? "是" : "否"}\n`;
  md += `- go/no-go：**${verdict}**\n`;
  md += `- 若 NO-GO：按 PRD §12/§14 回退 fetch-only 或换源（必要时试代理），并重估整体。\n`;
  fs.writeFileSync(path.join(OUT_DIR, "spike-S1-result.md"), md);
}

app.on("window-all-closed", () => {
  /* 由 app.quit 控制 */
});
run().catch((e) => {
  console.error("Spike 异常：", e);
  process.exit(1);
});
