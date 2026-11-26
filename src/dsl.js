// Small relational-plan DSL parser/formatter and expression utilities.

export class PlanError extends Error {}

const TWO_CHAR_OPS = new Set(['<=', '>=', '<>', '!=', '||']);
const COMPARISON_OPS = new Set(['=', '<>', '<', '>', '<=', '>=']);

export function tokenize(input) {
  const tokens = [];
  let i = 0;
  const push = (type, value, pos) => tokens.push({ type, value, pos });

  while (i < input.length) {
    const ch = input[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === ';' && input[i + 1] === ';') {
      while (i < input.length && input[i] !== '\n') i++;
      continue;
    }
    if ('()[]{},'.includes(ch)) { push('punct', ch, i); i++; continue; }

    if (ch === "'") {
      const start = i++;
      let value = '';
      let closed = false;
      while (i < input.length) {
        if (input[i] === "'" && input[i + 1] === "'") { value += "'"; i += 2; continue; }
        if (input[i] === "'") { i++; closed = true; break; }
        value += input[i++];
      }
      if (!closed) throw new PlanError('字符串没有闭合');
      push('string', value, start);
      continue;
    }

    if (/[0-9]/.test(ch)) {
      const start = i;
      while (i < input.length && /[0-9.]/.test(input[i])) i++;
      const raw = input.slice(start, i);
      const value = Number(raw);
      if (Number.isNaN(value)) throw new PlanError(`无效数字: ${raw}`);
      push('number', value, start);
      continue;
    }

    if (/[A-Za-z_]/.test(ch)) {
      const start = i;
      while (i < input.length && /[A-Za-z0-9_.]/.test(input[i])) i++;
      push('ident', input.slice(start, i), start);
      continue;
    }

    const two = input.slice(i, i + 2);
    if (TWO_CHAR_OPS.has(two)) { push('op', two === '!=' ? '<>' : two, i); i += 2; continue; }
    if ('=<>+-*/'.includes(ch)) { push('op', ch, i); i++; continue; }

    throw new PlanError(`无法识别的字符 “${ch}”（位置 ${i}）`);
  }
  return tokens;
}

class ParserCore {
  constructor(input) {
    this.tokens = typeof input === 'string' ? tokenize(input) : input;
    this.i = 0;
  }

  peek(offset = 0) { return this.tokens[this.i + offset]; }
  next() { return this.tokens[this.i++]; }
  eof() { return this.i >= this.tokens.length; }

  isPunct(value) { const t = this.peek(); return t?.type === 'punct' && t.value === value; }
  consumePunct(value) {
    const t = this.peek();
    if (!t || t.type !== 'punct' || t.value !== value) {
      throw new PlanError(`应为 “${value}”，实际为 ${t ? describeToken(t) : '输入结束'}`);
    }
    this.i++;
    return t;
  }

  isKeyword(word) {
    const t = this.peek();
    return t?.type === 'ident' && t.value.toLowerCase() === word;
  }
  consumeKeyword(word) {
    if (!this.isKeyword(word)) throw new PlanError(`应为关键字 ${word.toUpperCase()}`);
    return this.next();
  }

  isOp(op) { const t = this.peek(); return t?.type === 'op' && t.value === op; }
  consumeOp(op) {
    if (!this.isOp(op)) throw new PlanError(`应为运算符 ${op}`);
    return this.next();
  }

  parseExpression() { return this.parseOr(); }

  parseOr() {
    let left = this.parseAnd();
    while (this.isKeyword('or')) {
      this.next();
      const right = this.parseAnd();
      left = { kind: 'op', op: 'or', args: flattenOp('or', [left, right]) };
    }
    return left;
  }

  parseAnd() {
    let left = this.parseNot();
    while (this.isKeyword('and')) {
      this.next();
      const right = this.parseNot();
      left = { kind: 'op', op: 'and', args: flattenOp('and', [left, right]) };
    }
    return left;
  }

  parseNot() {
    if (this.isKeyword('not')) {
      this.next();
      return { kind: 'op', op: 'not', args: [this.parseNot()] };
    }
    return this.parseComparison();
  }

  parseComparison() {
    let left = this.parseAdditive();
    const t = this.peek();
    if (t?.type === 'op' && COMPARISON_OPS.has(t.value)) {
      this.next();
      const right = this.parseAdditive();
      return { kind: 'op', op: t.value, args: [left, right] };
    }
    if (this.isKeyword('is')) {
      this.next();
      let not = false;
      if (this.isKeyword('not')) { not = true; this.next(); }
      this.consumeKeyword('null');
      return { kind: 'op', op: not ? 'is not null' : 'is null', args: [left] };
    }
    return left;
  }

  parseAdditive() {
    let left = this.parseMultiplicative();
    while (this.isOp('+') || this.isOp('-') || this.isOp('||')) {
      const op = this.next().value;
      const right = this.parseMultiplicative();
      left = { kind: 'op', op, args: [left, right] };
    }
    return left;
  }

  parseMultiplicative() {
    let left = this.parseUnary();
    while (this.isOp('*') || this.isOp('/')) {
      const op = this.next().value;
      const right = this.parseUnary();
      left = { kind: 'op', op, args: [left, right] };
    }
    return left;
  }

  parseUnary() {
    if (this.isOp('-')) {
      this.next();
      return { kind: 'op', op: 'neg', args: [this.parseUnary()] };
    }
    if (this.isOp('+')) { this.next(); return this.parseUnary(); }
    return this.parsePrimary();
  }

  parsePrimary() {
    const t = this.peek();
    if (!t) throw new PlanError('表达式意外结束');

    if (t.type === 'number') { this.next(); return { kind: 'lit', value: t.value, dataType: 'number' }; }
    if (t.type === 'string') { this.next(); return { kind: 'lit', value: t.value, dataType: 'string' }; }

    if (t.type === 'ident') {
      const word = t.value.toLowerCase();
      if (word === 'true') { this.next(); return { kind: 'lit', value: true, dataType: 'boolean' }; }
      if (word === 'false') { this.next(); return { kind: 'lit', value: false, dataType: 'boolean' }; }
      if (word === 'null') { this.next(); return { kind: 'lit', value: null, dataType: 'null' }; }
      this.next();
      const parts = t.value.split('.');
      if (parts.length > 2) throw new PlanError(`列名最多包含 alias.column: ${t.value}`);
      return {
        kind: 'col',
        qual: parts.length === 2 ? parts[0] : null,
        name: parts.at(-1),
        raw: t.value,
      };
    }

    if (t.type === 'punct' && t.value === '(') {
      this.next();
      const expr = this.parseExpression();
      this.consumePunct(')');
      return expr;
    }

    throw new PlanError(`表达式中有未预期的 token: ${describeToken(t)}`);
  }
}

function flattenOp(op, args) {
  const out = [];
  for (const arg of args) {
    if (arg.kind === 'op' && arg.op === op) out.push(...arg.args);
    else out.push(arg);
  }
  return out;
}

function describeToken(t) {
  if (!t) return 'EOF';
  return `${t.type}:${JSON.stringify(t.value)}`;
}

class DSLParser extends ParserCore {
  parsePlan() {
    this.consumePunct('(');
    const opToken = this.next();
    if (opToken.type !== 'ident') throw new PlanError('计划节点必须以操作名开头');
    const op = opToken.value.toLowerCase();

    let node;
    if (op === 'table' || op === 'scan') node = this.parseTable(op);
    else if (op === 'filter' || op === 'select' || op === 'where') node = this.parseFilter();
    else if (op === 'join') node = this.parseJoin();
    else if (op === 'project' || op === 'projection') node = this.parseProject();
    else throw new PlanError(`未知计划操作 “${op}”；支持 table/filter/join/project`);

    this.consumePunct(')');
    return node;
  }

  parseTable() {
    const nameTok = this.next();
    if (nameTok.type !== 'ident' && nameTok.type !== 'string') throw new PlanError('表名无效');
    let alias = nameTok.value;
    if (this.peek()?.type === 'ident') alias = this.next().value;

    let only;
    if (this.isPunct('[')) {
      only = this.parseNameList();
    }
    return { kind: 'table', name: nameTok.value, alias, ...(only ? { only } : {}) };
  }

  parseNameList() {
    this.consumePunct('[');
    const names = [];
    if (!this.isPunct(']')) {
      do {
        const t = this.next();
        if (t.type !== 'ident') throw new PlanError('列名必须是标识符');
        names.push(t.value);
      } while (this.consumeIfPunct(','));
    }
    this.consumePunct(']');
    return names;
  }

  consumeIfPunct(value) {
    if (this.isPunct(value)) { this.i++; return true; }
    return false;
  }

  parseFilter() {
    this.consumePunct('{');
    const pred = this.parseExpression();
    this.consumePunct('}');
    const input = this.parsePlan();
    return { kind: 'filter', pred, input };
  }

  parseJoin() {
    let typeTok = null;
    if (this.isKeyword('inner')) { this.next(); typeTok = 'inner'; }
    else if (this.isKeyword('left')) { this.next(); typeTok = 'left'; }
    if (!typeTok) throw new PlanError('join 必须指定 inner 或 left');
    if (this.isKeyword('outer')) this.next();

    this.consumePunct('{');
    const on = this.parseExpression();
    this.consumePunct('}');
    const left = this.parsePlan();
    const right = this.parsePlan();
    return { kind: 'join', joinType: typeTok, on, left, right };
  }

  parseProject() {
    this.consumePunct('[');
    const cols = [];
    if (!this.isPunct(']')) {
      do {
        const expr = this.parseExpression();
        let as = null;
        if (this.isKeyword('as')) {
          this.next();
          const label = this.next();
          if (!label || (label.type !== 'ident' && label.type !== 'string')) {
            throw new PlanError('AS 后必须是输出列名');
          }
          as = label.value;
        }
        cols.push({ expr, as });
      } while (this.consumeIfPunct(','));
    }
    this.consumePunct(']');
    const input = this.parsePlan();
    return { kind: 'project', cols, input };
  }
}

export function parseDSL(text) {
  const parser = new DSLParser(String(text));
  const plan = parser.parsePlan();
  if (!parser.eof()) throw new PlanError(`计划结束后仍有多余 token: ${describeToken(parser.peek())}`);
  return plan;
}

export function parsePredicate(text) {
  const p = new ParserCore(String(text));
  const expr = p.parseExpression();
  if (!p.eof()) throw new PlanError(`谓词后有多余 token: ${describeToken(p.peek())}`);
  return expr;
}

/* ---------- Expression helpers ---------- */

export function cloneExpr(expr) {
  if (!expr || typeof expr !== 'object') return expr;
  return structuredClone(expr);
}

export function exprRefs(expr, set = new Set()) {
  if (!expr || typeof expr !== 'object') return set;
  if (expr.kind === 'col') set.add(expr.key || (expr.qual ? `${expr.qual}.${expr.name}` : expr.raw || expr.name));
  for (const key of ['args']) {
    if (Array.isArray(expr[key])) expr[key].forEach(a => exprRefs(a, set));
  }
  return set;
}

export function exprComplexity(expr) {
  if (!expr || expr.kind === 'lit' || expr.kind === 'col') return 1;
  return 1 + (expr.args || []).reduce((n, a) => n + exprComplexity(a), 0);
}

export function splitConjuncts(expr) {
  if (!expr) return [];
  if (expr.kind === 'op' && expr.op === 'and') return expr.args.flatMap(splitConjuncts);
  return [expr];
}

export function splitDisjuncts(expr) {
  if (!expr) return [];
  if (expr.kind === 'op' && expr.op === 'or') return expr.args.flatMap(splitDisjuncts);
  return [expr];
}

export function makeAnd(items) {
  const flat = items.filter(Boolean).flatMap(x => x.kind === 'op' && x.op === 'and' ? x.args : [x]);
  if (flat.length === 0) return { kind: 'lit', value: true, dataType: 'boolean' };
  if (flat.length === 1) return flat[0];
  return { kind: 'op', op: 'and', args: flat };
}

export function makeOr(items) {
  const flat = items.filter(Boolean).flatMap(x => x.kind === 'op' && x.op === 'or' ? x.args : [x]);
  if (flat.length === 0) return { kind: 'lit', value: false, dataType: 'boolean' };
  if (flat.length === 1) return flat[0];
  return { kind: 'op', op: 'or', args: flat };
}

export function substituteExpr(expr, mapping) {
  if (!expr || typeof expr !== 'object') return expr;
  if (expr.kind === 'col') {
    const key = expr.key || (expr.qual ? `${expr.qual}.${expr.name}` : expr.raw);
    if (mapping.has(key)) return cloneExpr(mapping.get(key));
    return { ...expr };
  }
  if (!expr.args) return { ...expr };
  return { ...expr, args: expr.args.map(a => substituteExpr(a, mapping)) };
}

export function replaceInExpr(expr, predicate, replacement) {
  if (predicate(expr)) return replacement;
  if (!expr?.args) return expr;
  return { ...expr, args: expr.args.map(a => replaceInExpr(a, predicate, replacement)) };
}

/* ---------- Formatting ---------- */

export function formatExpr(expr) {
  if (!expr) return 'TRUE';
  if (expr.kind === 'lit') return formatLiteral(expr.value);
  if (expr.kind === 'col') return expr.key || (expr.qual ? `${expr.qual}.${expr.name}` : expr.raw || expr.name);
  if (expr.kind === 'op') {
    if (expr.op === 'not') return `(NOT ${formatExpr(expr.args[0])})`;
    if (expr.op === 'neg') return `(-${formatExpr(expr.args[0])})`;
    if (expr.op === 'is null' || expr.op === 'is not null') return `(${formatExpr(expr.args[0])} ${expr.op.toUpperCase()})`;
    const symbol = expr.op === 'and' ? 'AND' : expr.op === 'or' ? 'OR' : expr.op;
    return `(${expr.args.map(formatExpr).join(` ${symbol} `)})`;
  }
  return '?';
}

export function formatLiteral(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'string') return `'${value.replace(/'/g, "''")}'`;
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  return String(value);
}

function label(label) {
  if (/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(label)) return label;
  return `'${String(label).replace(/'/g, "''")}'`;
}

function projectOut(item) {
  return item.out || item.as || (item.expr.kind === 'col'
    ? (item.expr.qual ? `${item.expr.qual}.${item.expr.name}` : item.expr.raw || item.expr.name)
    : `expr_${Math.random().toString(36).slice(2, 7)}`);
}

function formatProjectItem(item) {
  return `${formatExpr(item.expr)} AS ${label(projectOut(item))}`;
}

export function formatPlan(node, level = 0) {
  if (!node) return '(empty)';
  const pad = '  '.repeat(level);
  if (node.kind === 'table') {
    const cols = Array.isArray(node.only) ? ` [${node.only.join(', ')}]` : '';
    const alias = node.alias && node.alias !== node.name ? ` ${node.alias}` : (node.alias ? ` ${node.alias}` : '');
    return `${pad}(table ${node.name}${alias}${cols})`;
  }
  if (node.kind === 'filter') {
    return `${pad}(filter { ${formatExpr(node.pred)} }\n${formatPlan(node.input, level + 1)}\n${pad})`;
  }
  if (node.kind === 'join') {
    return `${pad}(join ${node.joinType} { ${formatExpr(node.on)} }\n${formatPlan(node.left, level + 1)}\n${formatPlan(node.right, level + 1)}\n${pad})`;
  }
  if (node.kind === 'project') {
    return `${pad}(project [${node.cols.map(formatProjectItem).join(', ')}]\n${formatPlan(node.input, level + 1)}\n${pad})`;
  }
  if (node.kind === 'empty') return `${pad}(empty [${(node.schema || []).map(c => c.key).join(', ')}])`;
  throw new PlanError(`无法格式化节点: ${node.kind}`);
}
