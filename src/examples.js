export const CATALOG = {
  emp: {
    columns: ['id', 'name', 'dept_id', 'level', 'active'],
    rows: [
      { id: 1, name: 'Alice', dept_id: 'd1', level: 5, active: true },
      { id: 2, name: 'Bob', dept_id: 'd2', level: 2, active: true },
      { id: 3, name: 'Carol', dept_id: 'd2', level: 4, active: false },
      { id: 4, name: 'Dave', dept_id: null, level: 1, active: true },
      { id: 5, name: 'Eve', dept_id: 'd9', level: 3, active: false },
      { id: 6, name: 'Frank', dept_id: 'd1', level: 4, active: false },
    ],
  },
  dept: {
    columns: ['id', 'name', 'min_level'],
    rows: [
      { id: 'd1', name: 'Sales', min_level: 2 },
      { id: 'd2', name: 'Engineering', min_level: 3 },
      { id: 'd3', name: 'Research', min_level: 4 },
      { id: 'd4', name: 'Lonely Dept', min_level: 1 },
      { id: 'd5', name: null, min_level: 1 },
    ],
  },
  payroll: {
    columns: ['id', 'name', 'salary', 'bonus'],
    rows: [
      { id: 1, name: 'Alice', salary: 90, bonus: 30 },
      { id: 2, name: 'Bob', salary: 70, bonus: 10 },
      { id: 3, name: 'Carol', salary: 80, bonus: null },
      { id: 4, name: 'Dave', salary: null, bonus: 50 },
    ],
  },
};

export const EXAMPLES = [
  {
    id: 'inner-basic',
    group: '正常优化',
    title: 'INNER JOIN + 过滤 + 投影',
    plan: `(project [e.name, d.name AS dept]
  (filter {e.active = true AND e.level >= d.min_level}
    (join inner {e.dept_id = d.id}
      (table emp e)
      (table dept d))))`,
    note: '合取拆分、保留侧/普通内连接下推、跨表条件并入 ON，最后裁剪基表列。',
  },
  {
    id: 'project-substitute',
    group: '投影',
    title: '谓词穿过投影并替换别名',
    plan: `(project [e.name, total]
  (filter {total > 100}
    (project [e.name, (e.salary + e.bonus) AS total]
      (table payroll e))))`,
    note: 'total 是投影表达式别名。下推时必须做表达式替换；NULL 薪水或奖金会使加法和比较得到 UNKNOWN。',
  },
  {
    id: 'c1-where-right',
    group: '外连接反例',
    title: '① WHERE 右侧谓词直接推进 RIGHT 输入',
    badRuleId: 'wrong-push-where-left-nullable',
    plan: `(project [e.name, d.name AS dept]
  (filter {d.name = 'Engineering'}
    (join left {e.dept_id = d.id}
      (table emp e)
      (table dept d))))`,
    note: '错误规则会让 Alice、Dave、Eve 等以 NULL 部门重新出现。合法路径是先识别该条件拒绝 NULL 扩展行，把 LEFT 降为 INNER，再下推。',
  },
  {
    id: 'c2-on-left',
    group: '外连接反例',
    title: '② ON 中左表谓词推进“保留侧”',
    badRuleId: 'wrong-push-on-left-preserved',
    plan: `(project [e.name, e.active, d.name AS dept]
  (join left {e.dept_id = d.id AND e.active = true}
    (table emp e)
    (table dept d)))`,
    note: 'Carol、Eve、Frank 不满足 ON 中的 active=true，但 LEFT JOIN 仍保留它们并补 NULL 部门；提前过滤员工表会丢行。',
  },
  {
    id: 'c3-is-null',
    group: 'NULL 反例',
    title: '③ WHERE d.id IS NULL 推进右表',
    badRuleId: 'wrong-push-where-left-nullable',
    plan: `(project [e.name, d.id AS did, d.name AS dept]
  (filter {d.id IS NULL}
    (join left {e.dept_id = d.id}
      (table emp e)
      (table dept d))))`,
    note: '原查询的 d.id NULL 来自“未匹配后的 NULL 扩展”，不是部门表里的真实 NULL 主键。错误下推到右表会得到空右表，进而保留全部员工。',
  },
  {
    id: 'c4-null-complement',
    group: 'NULL 反例',
    title: '④ NOT(x=v) 被二值补集错误改写',
    badRuleId: 'wrong-null-complement',
    plan: `(project [d.id, d.name]
  (filter {NOT (d.name = 'Sales')}
    (table dept d)))`,
    note: 'd5 的 name 为 NULL。NOT(NULL = Sales) 仍是 UNKNOWN，WHERE 拒绝它；错误地补上 OR name IS NULL 会多出 d5。',
  },
  {
    id: 'c5-where-to-on',
    group: '外连接反例',
    title: '⑤ WHERE 跨表谓词移到 LEFT JOIN ON',
    badRuleId: 'wrong-move-where-to-left-on',
    plan: `(project [e.name, e.level, d.name AS dept, d.min_level AS min_level]
  (filter {e.level >= d.min_level}
    (join left {e.dept_id = d.id}
      (table emp e)
      (table dept d))))`,
    note: 'Bob 按部门能匹配，但等级低于 min_level。WHERE 会删除 Bob；把等级条件移到 ON 后，Bob 匹配失败却会被 LEFT JOIN 保留并补 NULL。',
  },
  {
    id: 'c6-or-split',
    group: '外连接反例',
    title: '⑥ 跨表 OR 被拆成两侧过滤',
    badRuleId: 'wrong-or-both-sides',
    plan: `(project [e.name, e.active, d.name AS dept]
  (filter {e.active = false OR d.name = 'Sales'}
    (join left {e.dept_id = d.id}
      (table emp e)
      (table dept d))))`,
    note: 'Frank 因 d.name=Sales 应被 OR 保留；错误地先在左表过滤 active=false 会删除 Frank。OR 不能像 AND 一样按引用来源拆走。',
  },
];

export const RULE_MATRIX = [
  { where: 'WHERE / 连接后', join: 'INNER', side: '单侧', verdict: 'safe', action: '可推到对应输入；跨表合取可并入 ON' },
  { where: 'WHERE / 连接后', join: 'LEFT', side: '左（保留侧）', verdict: 'safe', action: '可推到左输入' },
  { where: 'WHERE / 连接后', join: 'LEFT', side: '右（NULL 提供侧）', verdict: 'conditional', action: '不能原样下推；NULL-rejecting 时先降为 INNER' },
  { where: 'WHERE / 连接后', join: 'LEFT', side: '跨表', verdict: 'conditional', action: '不能移入 ON；若拒绝 NULL 扩展行，可先降为 INNER' },
  { where: 'ON', join: 'LEFT', side: '右（NULL 提供侧）', verdict: 'safe', action: '可推到右输入，只影响匹配候选' },
  { where: 'ON', join: 'LEFT', side: '左（保留侧）', verdict: 'unsafe', action: '不能推到左输入，否则丢失补 NULL 的保留行' },
  { where: '任意', join: '任意', side: 'OR / 非合取', verdict: 'unsafe', action: '不能按表引用简单拆成两侧过滤' },
];
