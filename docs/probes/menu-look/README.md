# menu-look · 「更多」菜单外观是否真的生效

```bash
bash docs/probes/menu-look/run.sh
```

**10 PASS / 0 FAIL。** 真 Chromium + 真 naive-ui UMD + 真编译 CSS（复用 `header-width` 那套）。

## 验什么

业主 2026-10-04 五次报「多步（更多）的选择器好丑，和外面不统一」。

## ⛔ 最重要的一条：**我第一版修法是错的，实测才发现**

我以为 `menu-props` 里**扁平写** CSS 变量就行（"Vue 会把顶层 `--x` 当属性落 DOM"）。
**实测不生效**：算出来的圆角还是 naive-ui 默认的 `3px`。

根因在 `Dropdown.mjs:345`：
```js
style: [...style, this.cssVars],     // ← naive-ui 自己的变量在这
h(DropdownMenu, mergeProps(this.$attrs, dropdownProps, menuNodeProps))
```
⇒ 顶层那份 `--n-border-radius` **同名输给** `dropdownProps.style` 里那份 ⇒ 传了等于没传。

**三种写法实测对比**（这是本探针最有价值的部分）：

| 写法 | 计算出的圆角 | 结论 |
|---|---|---|
| 扁平 `{ '--n-border-radius': '4px' }` | **3px** | ⛔ **不生效** |
| `{ style: '--n-border-radius: 4px;' }` | **4px** | ✅ 生效 |
| `{ style: { '--n-border-radius': '4px' } }` | **4px** | ✅ 生效，但 **TS2322** |

⇒ 最终用 **`style` 字符串**：同样生效，且类型正确
（`menu-props` 返回类型是 `HTMLAttributes & Record<string, number|string|undefined>`，
那个索引签名要求 `style` 必须是 `string`）。

⚠️ **这类覆盖关系读代码是读不出来的**，必须真跑一遍 + 读 `getComputedStyle` 的**计算值**
（inline style 里有不代表被 CSS 消费）。

## 判据

| 组 | 验什么 | 结果 |
|---|---|---|
| M1 | 5 个 CSS 变量都落到菜单根节点 | 5/5 |
| M2 | **计算值**：圆角 4px / 字号 14px / 选项高 32px | ✓ |
| M3 | **形态是竖排**（业主裁决"按内容形态，不全统一"）| 4 项 y 各异、x 相同、等宽 |
| M4 | **控制组**：不传 `menu-props` 的默认值 | 默认 **3px / 34px** vs 改后 **4px / 32px** |

## 关于形态：业主明确裁决过

原话：「如果更多也要应该是上下，应该**根据实际布局来的，而不是全统一**」。

⇒ 4 个**文字动作**保持**竖排**（Windows 资源管理器的「更多」也是竖排）。
横排要为它另写一个浮层，与本项目"不新增界面"的立场冲突。
⇒ "丑"的真问题不是竖排，而是**圆角/字号/悬停色与项目其他浮层不像**（默认 3px/34px/灰底 vs 项目的 4px/14px/蓝灰）。

## 同步义务

`index.html` 里的 `moreMenuProps` 是 `index.vue` 那份的**等效复制**。
改产品那份必须同步改这里，否则探针测的不是产品。
