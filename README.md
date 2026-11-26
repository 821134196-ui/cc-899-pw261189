# 受限关系计划优化器：NULL 与外连接谓词下推实验室

一个零运行时依赖的静态网页，实现可编辑的小型关系计划优化器。支持：

- `(table name alias)` 表扫描与基表列裁剪
- `(filter { predicate } input)` 过滤
- `(join inner|left { on } left right)` 内连接、左外连接
- `(project [expr AS out, ...] input)` 投影、表达式替换、相邻投影合并
- 三值逻辑（TRUE / FALSE / UNKNOWN）与 SQL 风格 NULL
- Bag/多重集语义，不把投影误当成 DISTINCT
- 逐个生成候选规则，展示形式前置条件、当前行数据差分、估算成本和采纳/拒绝理由
- 可强制应用被判定为错误的候选，直接观察丢失或多出的行

## 运行

直接用浏览器打开 `index.html` 即可（页面使用预构建的 `bundle.js`）；也可以启动静态服务器：

```bash
npm start
# 或
python3 -m http.server 8123
```

然后打开 <http://localhost:8123/>。

修改 `src/` 后可重新生成浏览器包：

```bash
npx esbuild src/app.js --bundle --format=iife --target=es2022 --minify --outfile=bundle.js
```

## 测试

```bash
npm test
npm run check
```

测试包含：

- NULL 三值逻辑
- LEFT JOIN 的 NULL 扩展行
- 所有内置示例最终结果与原计划多重集等价
- 每个形式合法候选都通过当前数据差分检查和 DSL 格式化往返
- 每个“错误规则”都被内置反例数据改坏
- 80 个随机 NULL-heavy 目录上的安全性检查

## DSL 示例

```text
(project [e.name, d.name AS dept]
  (filter {d.name = 'Engineering'}
    (join left {e.dept_id = d.id}
      (table emp e)
      (table dept d))))
```

谓词支持：

```text
AND OR NOT
= <> < <= > >=
IS NULL / IS NOT NULL
+ - * / ||
TRUE FALSE NULL
括号与单引号字符串
```

## 合法性规则速查

| 谓词位置 | 连接 | 引用侧 | 结论 |
|---|---|---|---|
| WHERE | INNER | 任一侧 | 单侧合取项可下推；跨表合取可并入 ON |
| WHERE | LEFT | 左/保留侧 | 可推到左输入 |
| WHERE | LEFT | 右/NULL 提供侧 | 不能原样下推；若条件拒绝 NULL 扩展行，可先把 LEFT 降为 INNER |
| WHERE | LEFT | 跨表 | 不能移到 ON；满足 NULL-rejecting 条件时可先降为 INNER |
| ON | LEFT | 右/NULL 提供侧 | 可推到右输入，只影响匹配候选 |
| ON | LEFT | 左/保留侧 | 不能推到左输入，否则丢失补 NULL 的保留行 |
| 任意 | 任意 | 跨表 OR | 不能像 AND 合取项一样拆到两侧 |

一个关键区分是：右表中的真实 NULL 与 LEFT JOIN 未匹配后产生的 **NULL 扩展行** 不是一回事。`WHERE d.id IS NULL` 可能专门筛选未匹配行；把它推进右表扫描会得到空右表，从而保留全部左行。

## 内置反例

1. **WHERE 右侧谓词直接推进 LEFT JOIN 右输入**：多出 NULL 部门员工。
2. **ON 中左表谓词推进保留侧**：丢失本应被 NULL 扩展保留的员工。
3. **`WHERE right.key IS NULL` 推进右表**：把“未匹配行”错误变成“全部左行”。
4. **`NOT(x = v)` 被二值补集改写为 `x <> v OR x IS NULL`**：多出 NULL 行。
5. **WHERE 跨表谓词移到 LEFT JOIN ON**：本应被 WHERE 删除的行变成 NULL 扩展行。
6. **跨表 OR 被拆成左右两个过滤**：OR 语义和外连接保留语义同时被破坏。

页面中的错误候选带有红色“强制应用错误候选”按钮，可在不影响安全优化轨迹的情况下查看破坏后的结果和行差分。

## 代码结构

- `src/dsl.js`：DSL tokenizer/parser/formatter、表达式/AST 工具
- `src/engine.js`：模式解析、三值逻辑执行器、成本模型、多重集差分、NULL-rejecting 分析
- `src/rules.js`：候选规则生成与形式前置条件说明
- `src/optimize.js`：候选审计、推荐排序、逐步/整轮优化
- `src/examples.js`：内置目录、正例和错误规则反例
- `src/app.js`：原生 DOM 交互
- `test/core.test.js`：Node 内置测试运行器测试
