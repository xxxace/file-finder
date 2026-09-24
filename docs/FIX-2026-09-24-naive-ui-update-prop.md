# 修复：缓存记录面板「按盘筛选」只能看不能用

日期：2026-09-24
文件：`src/components/HistoryTable/index.vue`
状态：已修复（`handleSerialChange`）+ 同模板同源写法一并收口（分页）

---

## 一、症状

缓存记录面板顶部的盘筛选下拉：**能展开、能看到每块盘的目录数/封面数、能点选项，但选完没有任何反应** ——
下拉显示的还是「全部盘」，下面的列表也不变。

## 二、根因（一句话）

`v-model:value` 与 `:on-update:value` **同时写在一个组件上**，两者编译出来的 prop 名是同一个
（`camelize('on-update:value') === camelize('onUpdate:value') === 'onUpdate:value'`），
而 naive-ui 的 `Select` 只认这一个 prop —— 后写的 `onSearch` 把 v-model 的 setter **整个顶掉**。

于是：`model.serial` 永远停在 `''` → 查询照发，但 `serial` 参数是空 → 列表永远是全部盘。
「能看」= 下拉展开走的是 naive-ui 内部状态；「不能用」= 外部 `value` 绑定的变量根本没被写。

## 三、证据链

| # | 证据 | 等级 |
|---|---|---|
| 1 | 改前编译产物同一对象里并列两个 key：`"onUpdate:value": <v-model setter>` 与 `"on-update:value": _ctx.onSearch`；patchFlag 里是 `"on-update:value"` | 静态，可复算 |
| 2 | naive-ui 源码只读带冒号的那个键：`es/select/src/Select.mjs:114` 声明 `"onUpdate:value"`、`:122` 声明 `onUpdateValue`；`:312-321` 的 `doUpdateValue` 只读这两个 | 静态，可复算 |
| 3 | Vue 的 props 解析走 `camelize(key)` 匹配，两个 key 归一后同名；JS 对象字面量同名 key 后者胜 → setter 被丢弃 | 静态 + 推理 |
| 4 | **对照实测**（no-op host renderer 挂真 Vue 运行时，复刻 naive-ui 的 `doUpdateValue`）见下 | 实测 |

### 实测结果（Vue 3.5.43）

```
[A 现状  v-model:value + :on-update:value]  fire 后 serial = ""      ← 值没写进去，handler 却跑了
[B 只用 v-model:value]                      fire 后 serial = "E-SERIAL"
[C 修复  :value + :on-update:value]         fire 后 serial = "E-SERIAL"  handler 触发 ✓
[D v-model:value + :on-update-value]        fire 后 serial = "E-SERIAL"  （naive-ui 的另一条通道，也能work）
[E 分页现状 v-model:page + :on-update:page]  fire 后 pageNo = 7         ← setter 同样被顶掉，靠 handler 自赋值救活
```

A 就是本 bug 的完整复现；E 说明**同一个模板里还有一处同源写法，只是碰巧没发作**。

### 复现脚本

不需要 DOM，用 Vue 的 `createRenderer` 传一套 no-op host 就能挂组件并检查 `props` 到底解析成了什么。

```js
const { createRenderer, h, defineComponent, reactive } = require('vue');
const host = {
  createElement: (t) => ({ t, children: [] }), insert: (c, p) => { p?.children?.push(c); },
  remove: () => {}, patchProp: (el, k, prev, next) => { (el.props ||= {})[k] = next; },
  createText: (t) => ({ t }), createComment: () => ({}), setText: () => {}, setElementText: () => {},
  parentNode: () => null, nextSibling: () => null, querySelector: () => null,
  setScopeId: () => {}, cloneNode: () => ({}), insertStaticContent: () => ({}),
};
const { createApp } = createRenderer(host);

let childProps = null;
// props 声明与 naive-ui 一致（"onUpdate:value" 与 onUpdateValue 是两个独立 prop）
const Fake = defineComponent({
  props: { value: { default: '' }, 'onUpdate:value': [Function, Array], onUpdateValue: [Function, Array] },
  setup(p) { childProps = p; return () => null; },
});

// 复刻 naive-ui 的 doUpdateValue
function fire(value) {
  const c = (f) => (Array.isArray(f) ? f.forEach(x => x(value)) : f && f(value));
  if (childProps.onUpdateValue) c(childProps.onUpdateValue);
  if (childProps['onUpdate:value']) c(childProps['onUpdate:value']);
}

const state = reactive({ serial: '' });
createApp({ setup: () => () => h(Fake, {
  value: state.serial,
  'onUpdate:value': (v) => { state.serial = v; },   // v-model 的 setter
  'on-update:value': () => {},                      // 手写 handler（camelize 后同名）
}) }).mount({});
fire('E-SERIAL');
console.log(state.serial); // 改前：""（被顶掉）；改成 :value + 单 handler 后："E-SERIAL"
```

## 四、修法

```diff
- <n-select v-model:value="model.serial" :options="diskOptions" :loading="diskLoading"
-     style="width: 320px" size="small" :on-update:value="onSearch" />
+ <n-select :value="model.serial" :options="diskOptions" :loading="diskLoading"
+     style="width: 320px" size="small" :on-update:value="handleSerialChange" />

- <n-pagination size="small" v-model:page="model.pageNo" v-model:page-size="model.pageSize"
+ <n-pagination size="small" :page="model.pageNo" :page-size="model.pageSize"
```

```ts
const handleSerialChange = (serial: string) => {
    model.value.serial = serial;
    onSearch();
}
```

**规则：一个 update 事件只挂一个 handler，赋值和后续动作都写在它里面。**

### 为什么不用另外两种写法

- `v-model:value` + watch(schema)：值能通，但「选盘会触发查询」变成隐式链条，读模板看不出来。
- `v-model:value` + `:on-update-value`（naive-ui 的第二条独立通道，实测 D 可行）：
  能work，但依赖 naive-ui 内部双通道并存的实现细节；哪天有人把 `v-model:value` 改成 `:value` 就当场哑掉。
  而且它在模板上看起来仍然是「两个 handler 绑一件事」。

选定的写法：**一个事件、一个 handler、一个数据写入点**，结构上不可能再被覆盖，也不依赖框架的合并策略。

## 五、同类写法排查

`grep -n "v-model:|@update:" src/**/*.vue` 全库命中 4 处，逐一核对：

| 位置 | 是否冲突 |
|---|---|
| `FileFinder/index.vue:25` `n-input v-model:value` | 否 |
| `HistoryTable:2` `n-modal v-model:show` | 否 |
| `HistoryTable:9` `n-input v-model:value` | 否 |
| `HistoryTable:33` `n-data-table @update:checked-row-keys`（无并存 v-model） | 否 |

结论：**冲突写法只有 select 与 pagination 两处**，都在同一次改动里，已一并修掉。

## 六、验证

- 改后编译产物：`n-select` 的 props 里 update 键只剩 `"on-update:value": _ctx.handleSerialChange`，无竞争；
  `n-pagination` 只剩 `"on-update:page"` / `"on-update:page-size"`。
- `vue-tsc --noEmit` 通过（exit 0）。
- ⚠️ **GUI 未实测**：真机点选未跑，证据到「编译产物 + 运行时 props 解析 + naive-ui 源码 + 类型检查」为止。

## 七、未做（待定，需用户点头）

`onSearch` / `onRefresh` 里都有 `if (loading.value) return`：加载中用户的操作（选盘、点查询/刷新）会被
**静默丢弃** —— 请求在途时选盘，下拉会显示新盘而列表仍是旧数据。pagination 靠 `:disabled="loading"` 挡住了，
select / 查询 / 刷新 没有。要修就是给这几个入口补 `:disabled="loading"`（与 pagination 保持一致），
本次未动，等用户确认。
