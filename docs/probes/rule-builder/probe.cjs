/**
 * 规则编写器 · 纯函数探针（只读）
 * ---------------------------------------------------------------------------
 * 只测纯函数：`buildStepScript()`（动作脚本生成）、`expandUrl()` / `deriveTemplate()`（URL 模板）。
 * 不需要 GUI、不碰用户数据、不写用户目录。产物落同目录 `out.txt`（证据必须是 .txt —— .gitignore 挡 *.log）。
 * 跑法：node docs/probes/rule-builder/probe.cjs
 */
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFileSync } = require('child_process');

const PROBE = __dirname;
const ROOT = path.resolve(PROBE, '../../..');
const OUT = path.join(PROBE, 'out.txt');
const ESBUILD = path.join(ROOT, 'node_modules', 'esbuild', 'bin', 'esbuild');

function bundle(rel) {
    const out = path.join(os.tmpdir(), `ff-${path.basename(rel, '.ts')}-${process.pid}.cjs`);
    execFileSync(process.execPath, [
        ESBUILD, path.join(ROOT, rel),
        '--bundle', '--platform=node', '--format=cjs',
        `--outfile=${out}`, '--external:electron', '--log-level=error',
    ], { stdio: 'inherit' });
    return out;
}

const rulesBundle = bundle('electron/server/assistant/rules.ts');
const tplBundle = bundle('electron/server/assistant/urlTemplate.ts');
const selBundle = bundle('electron/server/assistant/selectorGen.ts');
const { buildStepScript } = require(rulesBundle);
const { expandUrl, deriveTemplate, replaceQueryInValue } = require(tplBundle);
const { selectorCandidates } = require(selBundle);

const lines = [];
const t = (name, cond) => lines.push(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
const eq = (name, got, want) => t(`${name}　[${JSON.stringify(got)}]`, got === want);

// ───────────────────────── 动作脚本（buildStepScript） ─────────────────────────

// 1 · type：{q} 换成真实查询词
const s1 = buildStepScript({ act: 'type', selector: '#kw', value: '{q}' }, 'TST-123');
t('type：{q} 替换为真实查询词', s1.includes('"TST-123"'));
t('type：不再残留 {q} 占位', !s1.includes('{q}'));

// 2 · type：特殊字符被 JSON 转义（否则生成的 JS 会语法错 / 可被注入）
const evil = '"quoted"\n</script>\\back';
const s2 = buildStepScript({ act: 'type', selector: '#kw', value: '{q}' }, evil);
t('type：双引号被转义', s2.includes('\\"quoted\\"'));
t('type：换行被转义成字面量 \\n', s2.includes('\\n'));

// 3 · type：走 prototype 上的 value setter（受控输入 React/Vue 才认）
t('type：使用 prototype 的 value setter', s2.includes('Object.getOwnPropertyDescriptor'));

// 4 · click
const s3 = buildStepScript({ act: 'click', selector: '.search-btn' }, '');
t('click：调用 el.click() 且带选择器', s3.includes('.click()') && s3.includes('".search-btn"'));

// 5 · wait（等元素出现）
const s4 = buildStepScript({ act: 'wait', selector: '#result', ms: 5000 }, '');
t('wait(selector)：轮询 + 超时', s4.includes('"#result"') && s4.includes('5000') && s4.includes('timeout'));

// 6 · wait（等固定时长）
const s5 = buildStepScript({ act: 'wait', ms: 300 }, '');
t('wait(ms)：无选择器时纯等待', s5.includes('var SEL = null') && s5.includes('300'));

// 7 · 生成的脚本语法均可解析（含 async IIFE）
let bad = '';
for (const [i, s] of [s1, s2, s3, s4, s5].entries()) {
    try { new Function('return ' + s); } catch (e) { bad += ` #${i + 1}:${e.message}`; }
}
t('五个动作脚本语法均可解析', bad === '');
if (bad) lines.push(`      （语法失败：${bad}）`);

// 8 · ⚠️ type 的值也要认**管道写法**（录制侧会产出 `{q|noDash}`）——
//     早前只替换 `{q}`，那些写法会被原样填进搜索框，动作永远搜不到东西
const s6 = buildStepScript({ act: 'type', selector: '#kw', value: '{q|noDash}' }, 'ABP-123');
t('type：认 {q|noDash}（不当字面量）', s6.includes('"ABP123"') && !s6.includes('{q'));
const s7 = buildStepScript({ act: 'type', selector: '#kw', value: '{q|lower}' }, 'ABP-123');
t('type：认 {q|lower}', s7.includes('"abp-123"'));
t('type：固定值原样保留', buildStepScript({ act: 'type', selector: '#kw', value: '固定' }, 'ABP-123').includes('"固定"'));

// ───────────────────────── URL 模板（expandUrl / deriveTemplate） ─────────────────────────

eq('{q} 套用站点变换（strip-dash）', expandUrl('https://s/{q}', 'ABP-123', 'strip-dash'), 'https://s/ABP123');
eq('{q} 默认做 URL 编码', expandUrl('https://s/{q}', 'a b'), 'https://s/a%20b');
eq('{q|noDash} 不叠加站点变换', expandUrl('https://s/{q|noDash}', 'ABP-123', 'lower'), 'https://s/ABP123');
eq('{q|lower} 转小写', expandUrl('https://s/{q|lower}', 'ABP-123'), 'https://s/abp-123');
eq('{q|upper} 转大写', expandUrl('https://s/{q|upper}', 'abp-1'), 'https://s/ABP-1');
eq('{q|num} 只留数字', expandUrl('https://s/{q|num}', 'FC2-PPV-1234567'), 'https://s/1234567');
eq('{q|noDash|lower} 可链式', expandUrl('https://s/{q|noDash|lower}', 'ABP-123'), 'https://s/abp123');
eq('{q|raw} 不做编码', expandUrl('https://s/{q|raw}', 'a b'), 'https://s/a b');
eq('同模板多占位符各自展开', expandUrl('https://s/{q|lower}/x/{q}', 'ABP-1'), 'https://s/abp-1/x/ABP-1');
eq('无占位符的模板原样不动', expandUrl('https://s/fixed', 'ABP-1'), 'https://s/fixed');
eq('encode=false：填输入框不做 URL 编码', expandUrl('https://s/{q}', 'a b', undefined, false), 'https://s/a b');
eq('encode=false 也认管道', expandUrl('{q|noDash}', 'ABP-123', undefined, false), 'ABP123');

const d1 = deriveTemplate('https://s/ABP-123', 'ABP-123');
t('反推：原样命中 → {q}', d1.ok && d1.template === 'https://s/{q}' && d1.hit === '{q}');

const d2 = deriveTemplate('https://s/abp-123', 'ABP-123');
t('反推：小写命中 → {q|lower}', d2.ok && d2.template === 'https://s/{q|lower}' && d2.hit === '{q|lower}');

const d3 = deriveTemplate('https://s/v/ABP123', 'ABP-123');
t('反推：去横杠命中 → {q|noDash}', d3.ok && d3.template === 'https://s/v/{q|noDash}' && d3.hit === '{q|noDash}');

const d4 = deriveTemplate('https://s/1234567', 'FC2-PPV-1234567');
t('反推：纯数字命中 → {q|num}', d4.ok && d4.template === 'https://s/{q|num}' && d4.hit === '{q|num}');

const d5 = deriveTemplate('https://s/hello', 'ABP-123');
t('反推：找不到就不硬猜（ok:false）', d5.ok === false && d5.template === 'https://s/hello');

const d6 = deriveTemplate('https://s/ABP-123?from=x', 'ABP-123');
t('反推：只换第一处，其余原样', d6.template === 'https://s/{q}?from=x');

// ───────────────────────── 选择器生成（selectorCandidates） ─────────────────────────

const dsc = (o) => Object.assign(
    { tag: 'img', id: '', cls: [], attrs: {}, idx: 0, total: 1, parent: null }, o,
);
const first = (o) => selectorCandidates(dsc(o))[0] || '';

eq('有 id 时优先用 #id', first({ id: 'cover' }), '#cover');
eq('meta 用 property 定位', first({ tag: 'meta', attrs: { property: 'og:image' } }), 'meta[property="og:image"]');
eq('data-* 属性可用', first({ attrs: { 'data-src': 'a.jpg' } }), 'img[data-src="a.jpg"]');
eq('class 组合', first({ cls: ['movie', 'photo'] }), 'img.movie.photo');
t('构建产物类名被排除（css-1a2b3c）', !selectorCandidates(dsc({ cls: ['css-1a2b3c'] })).join(' ').includes('css-1a2b3c'));
t('状态类被排除（is-active）', !selectorCandidates(dsc({ cls: ['photo', 'is-active'] })).join(' ').includes('is-active'));
t('哈希 id 被降级', selectorCandidates(dsc({ id: 'a1b2c3d4e5' }))[0] !== '#a1b2c3d4e5');
t('nth-of-type 只在最后兜底', (() => {
    const l = selectorCandidates(dsc({ cls: ['photo'], total: 3, idx: 1 }));
    return l[0] === 'img.photo' && l[l.length - 1] === 'img:nth-of-type(2)';
})());
t('元素多到超阈值时不给 nth-of-type', !selectorCandidates(dsc({ total: 30, idx: 5 })).join(' ').includes('nth-of-type'));
t('没有 tag 时返回空列表', selectorCandidates({ tag: '' }).length === 0);

// ───────────────────────── 录制值里的番号替换 ─────────────────────────

eq('录制值等于测试番号 → {q}', replaceQueryInValue('TST-123', 'TST-123'), '{q}');
eq('只差横杠 → {q|noDash}', replaceQueryInValue('TST123', 'TST-123'), '{q|noDash}');
eq('只差大小写 → {q|lower}', replaceQueryInValue('tst-123', 'TST-123'), '{q|lower}');
eq('无关的值原样保留', replaceQueryInValue('搜索', 'TST-123'), '搜索');
eq('同时差横杠与大小写 → {q|noDash|lower}', replaceQueryInValue('tst123', 'TST-123'), '{q|noDash|lower}');

// ⚠️ 很短的查询词（纯数字）不该在域名/端口上先命中 —— 那会反推出 `https://{q}.example.com/x`
t('反推：不在域名里乱认（只找 path+search）', deriveTemplate('https://123.example.com/x', '123').ok === false);

// ───────────────────────── 结果 ─────────────────────────

const pass = lines.filter(l => l.startsWith('PASS')).length;
fs.writeFileSync(
    OUT,
    `${lines.join('\n')}\n\n合计 ${pass}/${lines.length} PASS\n\n`
    + `样例（type，含特殊字符输入）:\n${s2}\n`
    + `样例（expandUrl）: ${expandUrl('https://s/{q|noDash|lower}', 'ABP-123')}\n`
    + `样例（deriveTemplate）: ${deriveTemplate('https://s/v/ABP123', 'ABP-123').template}\n`,
    'utf8',
);
console.log(lines.join('\n'));
console.log(`\n${pass}/${lines.length} PASS  → 证据：${path.relative(ROOT, OUT)}`);
for (const b of [rulesBundle, tplBundle]) fs.rmSync(b, { force: true });
process.exit(pass === lines.length ? 0 : 1);
