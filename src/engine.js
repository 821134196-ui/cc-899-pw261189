import {
  PlanError, cloneExpr, exprRefs, exprComplexity, formatPlan,
} from './dsl.js';

/* ---------------- Schema and name resolution ---------------- */

export function tableColumns(catalog, tableName, only) {
  const cat = catalog?.[tableName];
  if (!cat) throw new PlanError(`目录中没有表 “${tableName}”`);
  const columns = only ?? cat.columns ?? (cat.rows?.[0] ? Object.keys(cat.rows[0]) : []);
  for (const col of columns) {
    if (cat.columns && !cat.columns.includes(col)) throw new PlanError(`表 ${tableName} 没有列 ${col}`);
  }
  return columns;
}

export function resolveExpr(expr, schema) {
  if (!expr || typeof expr !== 'object') return expr;
  if (expr.kind === 'lit') return { ...expr };
  if (expr.kind === 'col') {
    const wantedQual = expr.qual;
    const wantedName = expr.name;
    let matches;
    if (wantedQual) {
      const qualified = `${wantedQual}.${wantedName}`;
      matches = schema.filter(c => c.key === qualified
        || (c.qual === wantedQual && c.name === wantedName));
    } else {
      matches = schema.filter(c => c.key === wantedName || c.name === wantedName);
    }
    if (matches.length === 0) {
      throw new PlanError(`无法解析列 ${expr.raw || (wantedQual ? `${wantedQual}.${wantedName}` : wantedName)}；可用列：${schema.map(c => c.key).join(', ')}`);
    }
    const unique = new Map(matches.map(m => [m.key, m]));
    if (unique.size > 1) throw new PlanError(`列名 ${wantedName} 不明确：${[...unique.keys()].join(', ')}`);
    const entry = matches[0];
    return { ...expr, key: entry.key, qual: entry.qual ?? expr.qual, name: entry.name ?? expr.name };
  }
  if (Array.isArray(expr.args)) {
    return { ...expr, args: expr.args.map(a => resolveExpr(a, schema)) };
  }
  return { ...expr };
}

function defaultOutName(item) {
  if (item.as) return item.as;
  const e = item.expr;
  if (e.kind === 'col') return e.qual ? `${e.qual}.${e.name}` : (e.raw || e.name);
  throw new PlanError('非列投影表达式必须使用 AS 指定输出列名');
}

export function analyze(node, catalog) {
  if (!node) throw new PlanError('空计划节点');

  if (node.kind === 'table') {
    const alias = node.alias || node.name;
    const columns = tableColumns(catalog, node.name, node.only);
    const schema = columns.map(name => ({ key: `${alias}.${name}`, qual: alias, name }));
    return { node: { ...node, alias }, schema };
  }

  if (node.kind === 'filter') {
    const input = analyze(node.input, catalog);
    const pred = resolveExpr(node.pred, input.schema);
    return { node: { ...node, pred, input: input.node }, schema: input.schema };
  }

  if (node.kind === 'join') {
    const left = analyze(node.left, catalog);
    const right = analyze(node.right, catalog);
    const schema = [...left.schema, ...right.schema];
    const keys = new Set();
    for (const c of schema) {
      if (keys.has(c.key)) throw new PlanError(`连接输出存在重复列名 ${c.key}，请使用别名`);
      keys.add(c.key);
    }
    const on = resolveExpr(node.on ?? { kind: 'lit', value: true, dataType: 'boolean' }, schema);
    return {
      node: { ...node, on, left: left.node, right: right.node },
      schema,
      leftSchema: left.schema,
      rightSchema: right.schema,
    };
  }

  if (node.kind === 'project') {
    const input = analyze(node.input, catalog);
    const cols = node.cols.map(item => {
      const expr = resolveExpr(item.expr, input.schema);
      const out = defaultOutName({ ...item, expr });
      return { ...item, expr, out };
    });
    const schema = cols.map(item => {
      const out = item.out;
      const dot = out.indexOf('.');
      return {
        key: out,
        qual: dot > 0 ? out.slice(0, dot) : null,
        name: dot > 0 ? out.slice(dot + 1) : out,
        expr: item.expr,
      };
    });
    const seen = new Set();
    for (const c of schema) {
      if (seen.has(c.key)) throw new PlanError(`投影输出列重名: ${c.key}`);
      seen.add(c.key);
    }
    return { node: { ...node, cols, input: input.node }, schema };
  }

  if (node.kind === 'empty') {
    return { node, schema: node.schema || [] };
  }

  throw new PlanError(`未知计划节点: ${node.kind}`);
}

export function schemaOf(plan, catalog) {
  return analyze(plan, catalog).schema;
}

/* ---------------- 3-valued expression evaluator ---------------- */

function isNull(v) { return v === null || v === undefined; }

function compareValues(a, b, op) {
  if (isNull(a) || isNull(b)) return null;
  let cmp;
  if (typeof a === 'number' && typeof b === 'number') cmp = a - b;
  else if (typeof a === 'string' && typeof b === 'string') cmp = a.localeCompare(b);
  else if (typeof a === 'boolean' && typeof b === 'boolean') cmp = Number(a) - Number(b);
  else {
    if (op === '=') return a === b;
    if (op === '<>') return a !== b;
    return null;
  }
  switch (op) {
    case '=': return cmp === 0;
    case '<>': return cmp !== 0;
    case '<': return cmp < 0;
    case '<=': return cmp <= 0;
    case '>': return cmp > 0;
    case '>=': return cmp >= 0;
    default: throw new PlanError(`不支持比较符 ${op}`);
  }
}

function arithmetic(a, b, op) {
  if (isNull(a) || isNull(b)) return null;
  if (op === '+') return a + b;
  if (op === '-') return a - b;
  if (op === '*') return a * b;
  if (op === '/') return b === 0 ? null : a / b;
  throw new PlanError(`不支持算术符 ${op}`);
}

export function evalExpr(expr, row) {
  if (!expr) return true;
  if (expr.kind === 'lit') return expr.value ?? null;
  if (expr.kind === 'col') {
    const key = expr.key || (expr.qual ? `${expr.qual}.${expr.name}` : expr.raw || expr.name);
    const v = row?.[key];
    return v === undefined ? null : v;
  }
  if (expr.kind !== 'op') return null;
  const args = expr.args || [];

  switch (expr.op) {
    case 'and': {
      let hasUnknown = false;
      for (const a of args) {
        const v = evalExpr(a, row);
        if (v === false) return false;
        if (v !== true) hasUnknown = true;
      }
      return hasUnknown ? null : true;
    }
    case 'or': {
      let hasUnknown = false;
      for (const a of args) {
        const v = evalExpr(a, row);
        if (v === true) return true;
        if (v !== false) hasUnknown = true;
      }
      return hasUnknown ? null : false;
    }
    case 'not': {
      const v = evalExpr(args[0], row);
      return v === null || v === undefined ? null : !v;
    }
    case 'neg': {
      const v = evalExpr(args[0], row);
      return isNull(v) ? null : -v;
    }
    case 'is null':
      return isNull(evalExpr(args[0], row));
    case 'is not null':
      return !isNull(evalExpr(args[0], row));
    case '=': case '<>': case '<': case '<=': case '>': case '>=':
      return compareValues(evalExpr(args[0], row), evalExpr(args[1], row), expr.op);
    case '+': case '-': case '*': case '/':
      return arithmetic(evalExpr(args[0], row), evalExpr(args[1], row), expr.op);
    case '||': {
      const a = evalExpr(args[0], row);
      const b = evalExpr(args[1], row);
      return isNull(a) || isNull(b) ? null : String(a) + String(b);
    }
    default:
      throw new PlanError(`不支持运算符 ${expr.op}`);
  }
}

/* ---------------- Evaluation + simple cost model ---------------- */

function tableRows(node, catalog) {
  const alias = node.alias || node.name;
  const columns = tableColumns(catalog, node.name, node.only);
  const rawRows = catalog[node.name]?.rows ?? [];
  return rawRows.map(raw => {
    const row = {};
    for (const col of columns) {
      const v = raw[col];
      row[`${alias}.${col}`] = v === undefined ? null : v;
    }
    return row;
  });
}

function nullRow(schema) {
  const row = {};
  for (const c of schema) row[c.key] = null;
  return row;
}

function evalDetailed(node, catalog) {
  if (node.kind === 'table') {
    const rows = tableRows(node, catalog);
    const cols = tableColumns(catalog, node.name, node.only).length;
    const cpu = rows.length * 1.0;
    const width = rows.length * cols * 0.08;
    return { rows, cols, cost: cpu + width };
  }

  if (node.kind === 'empty') {
    const cols = node.schema?.length || 0;
    return { rows: [], cols, cost: 0 };
  }

  if (node.kind === 'filter') {
    const child = evalDetailed(node.input, catalog);
    const rows = child.rows.filter(r => evalExpr(node.pred, r) === true);
    const schema = schemaOf(node, catalog);
    const cpu = child.rows.length * (0.15 * exprComplexity(node.pred) + 0.05);
    const width = rows.length * schema.length * 0.08;
    return { rows, cols: schema.length, cost: child.cost + cpu + width };
  }

  if (node.kind === 'join') {
    const left = evalDetailed(node.left, catalog);
    const right = evalDetailed(node.right, catalog);
    const rightSchema = schemaOf(node.right, catalog);
    const rows = [];
    let pairChecks = 0;

    for (const l of left.rows) {
      const matches = [];
      for (const r of right.rows) {
        pairChecks++;
        const merged = { ...l, ...r };
        if (evalExpr(node.on, merged) === true) matches.push(merged);
      }
      if (node.joinType === 'inner') rows.push(...matches);
      else if (matches.length) rows.push(...matches);
      else rows.push({ ...l, ...nullRow(rightSchema) });
    }

    const schema = schemaOf(node, catalog);
    const pairCost = pairChecks * 0.8;
    const preservation = node.joinType === 'left' ? left.rows.length * 0.25 : 0;
    const width = rows.length * schema.length * 0.08;
    return {
      rows,
      cols: schema.length,
      cost: left.cost + right.cost + pairCost + preservation + width,
    };
  }

  if (node.kind === 'project') {
    const child = evalDetailed(node.input, catalog);
    const rows = child.rows.map(raw => {
      const out = {};
      for (const item of node.cols) out[item.out] = evalExpr(item.expr, raw);
      return out;
    });
    const cpu = child.rows.length * node.cols.length * 0.18;
    const width = rows.length * node.cols.length * 0.08;
    return { rows, cols: node.cols.length, cost: child.cost + cpu + width };
  }

  throw new PlanError(`无法执行节点 ${node.kind}`);
}

export function evaluateDetailed(plan, catalog) {
  const analyzed = analyze(plan, catalog);
  const result = evalDetailed(analyzed.node, catalog);
  return { ...result, cost: roundCost(result.cost), schema: analyzed.schema };
}

export function evaluatePlan(plan, catalog) {
  return evaluateDetailed(plan, catalog).rows;
}

export function costPlan(plan, catalog) {
  return evaluateDetailed(plan, catalog).cost;
}

function roundCost(n) { return Math.round(n * 100) / 100; }

/* ---------------- Multiset differential check ---------------- */

function stableKey(row, columns) {
  const keys = columns || Object.keys(row).sort();
  const ordered = {};
  for (const k of keys) ordered[k] = row?.[k] ?? null;
  return JSON.stringify(ordered);
}

export function multisetDiff(expectedRows, actualRows, columns = null) {
  const map = new Map();
  for (const row of expectedRows) {
    const key = stableKey(row, columns);
    const e = map.get(key) || { key, expected: 0, actual: 0, row };
    e.expected++;
    map.set(key, e);
  }
  for (const row of actualRows) {
    const key = stableKey(row, columns);
    const e = map.get(key) || { key, expected: 0, actual: 0, row };
    e.actual++;
    e.row = row;
    map.set(key, e);
  }
  const missing = [];
  const extra = [];
  for (const e of map.values()) {
    if (e.expected > e.actual) missing.push({ row: e.row, count: e.expected - e.actual, kind: 'missing' });
    if (e.actual > e.expected) extra.push({ row: e.row, count: e.actual - e.expected, kind: 'extra' });
  }
  return {
    equivalent: missing.length === 0 && extra.length === 0,
    missing,
    extra,
    expectedCount: expectedRows.length,
    actualCount: actualRows.length,
  };
}

/* ---------------- NULL / outer-join legality helpers ---------------- */

export function sideOfExpr(expr, leftKeys, rightKeys) {
  const refs = [...exprRefs(expr)];
  const l = refs.some(r => leftKeys.has(r));
  const r = refs.some(x => rightKeys.has(x));
  if (l && r) return 'cross';
  if (l) return 'left';
  if (r) return 'right';
  return 'constant';
}

/**
 * Conservative universal test: under a row where every right-side column is
 * NULL, can this top-level conjunct ever be TRUE for some left-side values?
 * Returning true means "guaranteed not TRUE", hence it rejects NULL-extended rows.
 */
export function isNullRejecting(expr, nullableKeys) {
  if (!expr) return false;

  if (expr.kind === 'lit') return expr.value !== true;
  if (expr.kind === 'col') return nullableKeys.has(expr.key);

  if (expr.kind === 'op') {
    if (expr.op === 'is null') return false; // NULL-extended column makes IS NULL true
    if (expr.op === 'is not null') return [...exprRefs(expr.args[0])].some(k => nullableKeys.has(k));
    if (expr.op === 'and') return expr.args.some(a => isNullRejecting(a, nullableKeys));
    if (expr.op === 'or') return expr.args.every(a => isNullRejecting(a, nullableKeys));
    if (expr.op === 'not') return false; // conservative; direct IS NOT NULL is handled
    if (['=', '<>', '<', '<=', '>', '>=', '+', '-', '*', '/', '||', 'neg'].includes(expr.op)) {
      return [...exprRefs(expr)].some(k => nullableKeys.has(k));
    }
  }
  return false;
}

export function nullWitness(expr, nullableKeys) {
  const row = {};
  for (const k of nullableKeys) row[k] = null;
  return evalExpr(expr, row);
}

export { cloneExpr, formatPlan };
