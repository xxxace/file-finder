/**
 * 探针页面共用的壳：造上下文 → 挂载（真 naive-ui，`:show/:x/:y` 手动定位，与 index.vue 一致）
 * → 暴露 `window.__probe()` 供无头 Electron 取值。
 *
 * ⚠️ 页面必须**先**给 `window.__HARNESS_MARKUP` 赋值（before.html / after.html 各写各的）。
 */
(function () {
    const { createApp, h, reactive, ref } = Vue;
    const N = naive;

    /* ── 上下文：与 index.vue 里 popover 那段用到的标识符逐字对应 ── */
    const FILES = [
        { name: '[TST-593] 示例作品标题 CD1.mp4', size: 1288490188 },
        { name: '[TST-593] 示例作品标题 CD2.mp4', size: 1181116006 },
        { name: '[TST-593] 示例作品标题 cover.jpg', size: 2234567 },
        /* 第 4 个刻意**超长** —— 业主报的「标题过长没有省略号」就是它 */
        { name: '[TST-593] 示例作品标题 这是一个特别长的补丁说明文件名_最终版_v3_修正字幕.srt', size: 43210 },
    ];
    const popover = reactive({ visible: true, x: 24, y: 24, files: FILES });
    /** 高亮落在第 2 项上 —— 让"键盘高亮那一项"也出现在对照图里 */
    const fileCursor = ref(1);
    const getSize = (n) => n >= 1e9
        ? (n / 1e9).toFixed(2) + ' GB'
        : n >= 1e6 ? (n / 1e6).toFixed(0) + ' MB' : (n / 1e3).toFixed(0) + ' KB';
    const extOf = (name) => (name.includes('.') ? name.split('.').pop().toLowerCase() : '');

    const ctx = {
        popover,
        fileCursor,
        getSize,
        extOf,
        openFile: () => { },
        onFileListKeydown: () => { },
    };

    /* 真实 scoped CSS 靠 `[data-v-probe]` 命中 ⇒ 每个元素都得打上这个标记 */
    const tmpl = ('<div class="probe-root">' + window.__HARNESS_MARKUP + '</div>')
        .replace(/<([a-zA-Z][\w-]*)/g, '<$1 data-v-probe');
    const Root = { name: 'Root', template: tmpl, setup: () => ctx };

    const app = createApp({ render: () => h(N.NConfigProvider, null, { default: () => h(Root) }) });
    for (const [k, v] of Object.entries(N)) {
        if (/^N[A-Z]/.test(k)) {
            app.component(k.replace(/^N/, 'n-').replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase(), v);
        }
    }
    app.mount('#stage');

    /* ⚠️ 真机里 `openFileList` 会 `nextTick` 后把焦点落到弹层容器上（`fileListBox.focus()`）。
       焦点是"橙色边框"那条报障的关键变量：**不给焦点就复现不出来**。
       所以这里必须照抄这一步，否则探针会证明一个真机上不存在的样子。 */
    Vue.nextTick(() => {
        const box = document.querySelector('.file-list');
        /* ⚠️ 必须带 `{ focusVisible: true }`：无头里没有真实键盘/鼠标输入，
           Chromium 的启发式永远不给 `:focus-visible` ⇒ **复现不出那条橙色边框**。
           强制带上之后，UA 焦点环才是真机上"用键盘打开弹层"时的那个样子。 */
        if (box) box.focus({ focusVisible: true });
    });

    /* ── 量什么 ──
       要看住的就是"丑"的两个原因，改前改后各量一遍：
       ① `.file-cover` 画没画出来（改前 h=0、背景是 blank.svg；改后 h=font-size、背景是 fiv 图标）
       ② 文件名能不能换行（改前 white-space=nowrap、只显示前缀；改后 normal、多行）
       再加 popover / 列表宽度，确认没被撑到屏幕外。 */
    const r2 = (el) => {
        const r = el.getBoundingClientRect();
        return { w: +r.width.toFixed(1), h: +r.height.toFixed(1) };
    };

    window.__probe = async () => {
        await new Promise((r) => setTimeout(r, 400));
        const cs = (el, p) => getComputedStyle(el)[p];
        const items = Array.from(document.querySelectorAll('.file-item'));
        const list = document.querySelector('.file-list') || document.querySelector('.n-popover .hstack');
        const pop = document.querySelector('.n-popover');

        /* 「橙色边框」查证：焦点在弹层容器上时，浏览器**默认焦点环**（`outline: auto`）是什么。
           —— 这就是"不给焦点就复现不出来"的那个变量。 */
        const focusProbe = (() => {
            const el = document.activeElement;
            if (!el) return { active: null };
            const s = getComputedStyle(el);
            return {
                activeClass: el.className,
                outlineStyle: s.outlineStyle,
                outlineWidth: s.outlineWidth,
                outlineColor: s.outlineColor,
                outlineOffset: s.outlineOffset,
                focusVisible: el.matches(':focus-visible'),
                /* 真 Chromium 里 outline:auto 的实色（色值随系统强调色走，**不要**靠猜） */
                outlineColorResolved: (() => {
                    try {
                        const c = document.createElement('canvas').getContext('2d');
                        c.fillStyle = s.outlineColor;
                        return c.fillStyle;
                    } catch { return null; }
                })(),
            };
        })();

        return {
            itemCount: items.length,
            popoverRect: pop ? r2(pop) : null,
            listRect: list ? r2(list) : null,
            focusProbe,
            items: items.map((el, i) => {
                const icon = el.querySelector('.file-cover');
                const name = el.querySelector('span');
                const size = el.querySelector('.file-size');
                return {
                    i,
                    itemRect: r2(el),
                    nameText: name ? (name.textContent || '').trim() : null,
                    /* ① 图标画出来了没 */
                    iconRect: icon ? r2(icon) : null,
                    iconBgImage: icon ? cs(icon, 'backgroundImage').replace(/^url\(".*\/([^/"]+)"\)$/, '$1').slice(0, 60) : null,
                    iconFontSize: icon ? cs(icon, 'fontSize') : null,
                    /* ② 名字换不换行 */
                    nameWhiteSpace: name ? cs(name, 'whiteSpace') : null,
                    nameFontSize: name ? cs(name, 'fontSize') : null,
                    nameLineHeight: name ? cs(name, 'lineHeight') : null,
                    nameRect: name ? r2(name) : null,
                    /* scrollHeight > clientHeight ⟺ 内容真的被切了（这时才该有省略号） */
                    nameScrollHeight: name ? name.scrollHeight : null,
                    nameClientHeight: name ? name.clientHeight : null,
                    nameDisplay: name ? cs(name, 'display') : null,
                    /* 省略号靠这两个：`-webkit-line-clamp` 必须配 `display:-webkit-box` 才生效 */
                    nameLineClamp: name ? (cs(name, 'webkitLineClamp') || cs(name, 'WebkitLineClamp')) : null,
                    /* ③ 新增的大小那一行 */
                    sizeText: size ? (size.textContent || '').trim() : null,
                    sizeFontSize: size ? cs(size, 'fontSize') : null,
                };
            }),
        };
    };
})();
