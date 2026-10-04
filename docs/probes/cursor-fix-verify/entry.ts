/**
 * 修复验证探针的**页面侧入口** —— 由 esbuild 打包，与本文件同目录的 `entry.ts` 一起编。
 *
 * 为什么要打**真的** `useGridCursor.ts`：
 * 前三个探针（cursor-scale-row / cursor-scroll-cache / row4-boundary）测的都是
 * 「浏览器排版层发生了什么」—— 它们用**复刻**的 `splitRows` / `stepPos`。
 * ⇒ 它们能证明**根因**，但**证明不了修复是否真的生效**（复刻件与真代码可能已经分叉）。
 *
 * 本探针直接把真 `useGridCursor.ts` + `gridGeometry.ts` + `utils/index.ts` 打包进页面，
 * 在**真 DOM**（主屏尺寸、真 CSS）里派发**真 KeyboardEvent**，
 * 读回真`cursorKey` —— 全链路无复刻。
 */
import { createApp, h, ref, computed, nextTick } from 'vue';
import { useGridCursor } from '../../../src/views/FileFinder/useGridCursor';

/** 供页面调用的装函数。返回一组操作句柄。 */
export function mountGrid(opts: {
    mount: HTMLElement;
    count: number;
}) {
    const fileList = ref<Array<{ key: string; name: string; dir: string; size: number; type: string }>>(
        Array.from({ length: opts.count }, (_, i) => ({
            key: `k${i}`, name: `item-${i}`, dir: 'D:/sample/dir', size: 1024, type: 'image',
        })),
    );
    const imageBox = ref<HTMLElement | null>(null);
    const opened: string[] = [];
    // ⛔⛔ **必须在 `setup()` 顶层调`useGridCursor`**，不能在外面直接调 ——
    // 它内部用 `onMounted` 注册 keydown 监听、在 `onUnmounted` 摘掉。
    // 在 setup 之外调 ⇒ Vue 报 "onMounted is called when there is no active component instance"
    // ⇒ **监听压根没挂上** ⇒ 所有按键都没响应。
    // （我第一版就是踩了这个：V1~V6 全空，V7 控制组却"抓到 12 步错"——
    //   那个 12 是因为所有落点都空、等于"全错"，不是真的抓到了 bug。）
    let cursor!: ReturnType<typeof useGridCursor>;

    const App = {
        setup() {
            cursor = useGridCursor({
                fileList: computed(() => fileList.value),
                keyOf: (item) => item.key,
                imageBox,
                isPreviewOpen: () => false,
                onConfirm: (item) => { opened.push(item.key); },
            });
            return () => h('div', { class: 'image-box', ref: imageBox },
                fileList.value.map((item) => h('div', {
                    key: item.key,
                    class: ['image-box-item', cursor.cursorKey.value === item.key ? 'cursor' : ''],
                    'data-key': item.key,
                }, [
                    h('div', { class: 'ph' }),
                    h('span', null, item.name),
                ])),
            );
        },
    };
    const app = createApp(App);
    app.mount(opts.mount);
    // ⚠️ 暴露 app 实例：换站时必须 `unmount()`，否则**上一个用例的 window keydown 监听还在**
    // ⇒ 一次按键被多个监听处理 ⇒ 落点跳格。V3~V6 换站时都要先摘。
    (window as unknown as { __lastApp: unknown }).__lastApp = app;
    // ⛔ 必须等挂载完成：setup 已跑完、onMounted 已注册 ⇒ 监听确实在位
    const ready = nextTick();

    return {
        ready,
        /** 派发一次**真**按键（走 window 监听器，与真机同一条路径） */
        press(key: string) {
            const target = document.querySelector('.image-box-item') || document.body;
            const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
            target.dispatchEvent(ev);
            return cursor.cursorKey.value;
        },
        /**
         * 按键 + **等 DOM 与滚动都落定**。
         *
         * ⚠️ 为什么要这个：`press` 只派发事件，`focusCursor` 里的
         *    `scrollIntoView` 与 Vue 的 DOM patch 都是**异步**的
         *    ⇒ 只 `setTimeout`几十毫秒可能还没滚完 ⇒ 量到 `scrollTop = 0`
         *    ⇒ 会把"没滚"误当成"不需要滚"。
         * ⇒ 这里等到 `requestAnimationFrame` 连打两发（覆盖 Vue patch + 滚动），
         *    再多给一帧让 `scroll` 事件派发出去（缓存失效就靠它）。
         */
        async pressAndSettle(key: string, ms = 40) {
            const out = this.press(key);
            await new Promise(r => setTimeout(r, ms));
            await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
            // ⚠️⚠️ 必须**此刻**现取容器，不能缓存引用 ——
            //    换站时（`__newStation()`）旧容器已被移除、换成新的。
            //    我第一版在 mount 时就把容器存起来用了 ⇒ 读到的永远是**旧容器**的 scrollTop
            //    ⇒ 明明滚到 2661 却报 0 ⇒ 差点把"探针坏了"当成"产品没滚"。
            const box = imageBox.value;
            return {
                key: out,
                now: cursor.cursorKey.value,
                scroll: box ? box.scrollTop : -1,
                isCurrent: !!box && box.isConnected,
            };
        },
        /** 等转场推进（真机按键间隔≈30ms，转场 .18s） */
        settle(ms = 40) {
            return new Promise(r => setTimeout(r, ms));
        },
        peek: () => cursor.cursorKey.value,
        cursorIndex: () => cursor.cursorIndex.value,
        opened: () => opened.slice(),
        scrollTop: () => {
            const box = imageBox.value;
            return box ? box.scrollTop : -1;
        },
        isBox: () => !!imageBox.value,
        /**
         * 换一份数据（模拟 `dataSource` 整份替换 = 切目录）。
         * ⚠️ `dirTag` 参与 key —— 与产品一致（`keyOf` 含 `dir`）⇒ 换屏时 key 集合全变。
         * ⚠️ `keep` 指定"新屏里仍然存在"的那个 key ⇒ 用来验"恢复的焦点还在不在"。
         */
        setData(count: number, dirTag: string, keepKey?: string) {
            fileList.value = Array.from({ length: count }, (_, i) => ({
                // ⚠️ `keepKey` 放回**原索引**：key 名不带新目录标记
                //    （产品里 key 含 dir，但 onBack 恢复的 key 属于**旧屏的命名空间**，
                //    验"恢复的焦点还在不在"要的就是"新屏里恰好还有这个 key"）
                key: keepKey && i === Number(keepKey.slice(1)) ? keepKey : `k${dirTag}-${i}`,
                name: `item-${i}`, dir: `D:/sample/${dirTag}`,
                size: 1024, type: 'image',
            }));
            return true;
        },
        /** 与产品同名的三个写入口（验第 1 条"焦点记忆"用） */
        noteIntent: () => cursor.noteIntent(),
        setCursorKey: (k: string) => cursor.setCursorKey(k),
        dispose: () => { /* 页面卸载即可，无需逐个销毁 */ },
    };
}
