# onback-real · 用**真 `onBack` 函数体**验证返回恢复（未跑通，但找到了真 bug）

```bash
bash docs/probes/onback-real/run.sh
```

## ⚠️ 本探针的当前状态：**未跑通，勿引用它的 PASS/FAIL**

`R0b` 显示：手动检查 `el.dataset.key === keyOf(first)` **成立**，
但通过 `new Function` 编译出来的 `waitForGridOf` **返回 false**。
⇒ 差异在 `new Function` 的**自由变量作用域**（我的依赖挂在 `window` 上，
函数内却解析不到同一个引用）—— **这是探针的环境问题**，不是产品问题。
**尚未定位到具体是哪一项解析失败。**

⇒ 本目录的价值目前只有两条：
1. **手法可复用**：从 `index.vue` **programmatically 抽函数体**（括号配平）→
   `new Function` 编译 → 在真 Vue + 真 DOM 里跑。**被测逻辑是真的**（不是我手抄的复刻件）。
2. **它复现了业主报的现象**，并排除了一个嫌疑（见下）。

## ✅ 它立的大功：排除了"记录端"，锁定了"判据端"

R2（A 滚到 800 → 进 B → B 里滚到 1186 → 返回 A）实测：

```
A 离开时 scrollTop = 800
返回 A 之后        = 1186          ← ★与业主描述完全一致
history            = [{ path:"D:/sample/A", scrollY:800 }]   ← ★记的值是**对的**
诊断消息           = [{ title:"诊断：未就位", msg:"记=800 现=1186" }]
```

⇒ **两个结论**：
- `rememberCurrentScreen` 记的值**是对的**（800）⇒ 我前几轮怀疑"记错了"是**错的**
- `waitForGridOf` 返回 false ⇒ 走了"**不恢复**"分支 ⇒ 停在上一屏的位置

⇒ 于是回头查判据，发现我加的 `first.dir === path` **在 cover 模式下永远不成立**
（子目录会收敛成封面条目，条目的 `dir` 是"封面图所在目录"，与"这一屏的路径"不一定相同）。
**已从产品代码里删掉**（`await fetchFolder` 已保证数据换新，只需等 DOM 跟上）。

⚠️ 所以：**结论已用于修产品；但"修完之后探针是否变绿"没能验证**（环境问题挡着）。

## 已知边界（写清楚，别让结论超出证据）

- `fetchFolder` 是**假的**（可控延迟 + 内存数据）—— 真应用走 HTTP(:3060)，时序可能不同
- `nextTick` / `fileList` / `imageBox` / `keyOf` 都是**页面里造的**，只有 `onBack` 与
  `waitForGridOf` 的**函数体**是从源码抽的真件

## 下次做的时候（给未来的自己）

1. **先单独验环境**：在页面里直接 `await waitForGridOf('x')` 并断言 true
   —— 这一条不过，后面的用例全部无意义（本次就是栽在这里）
2. 抽取用**括号配平**，不要 `indexOf('\n}\n')`（会匹配到函数体内的行首 `}`）
3. 注入时**不能** `window.x = const f = ...`（`= const` 是语法错，报 `Unexpected token 'const'`）
4. `new Function` **不接受 TS 类型注解** ⇒ 形参表要重写成无类型的
